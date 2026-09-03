// M20 app — the turn pipeline. The S5 spec's seven stages, in one place:
//
//   1. inbound     — ledger dedupe + offset commit happen in ingest (M15); this
//                    layer mints the turnId, enqueues, and returns immediately.
//                    Awaiting the turn here would block Telegram polling and make
//                    interruption impossible — the drain is single-flight instead.
//   2-4. assemble → loop → DecisionObject (M11, M13 do the work)
//   5. gate        — inside the loop (re-entry capped there)
//   6. realize     — vs the channel clock; every send lands in the ledger
//   7. afterturn   — DETACHED: appraisal, episode, affect, outcome_prev. A
//                    failure here is an incident; stage 6's outcome is done.
//
// Interruption (new inbound while stage 6 is mid-plan): the in-flight send is
// aborted, the unsent bubbles become the NEXT turn's carry-over ("she was about
// to say"), and the interrupted turn's ledger row becomes a `defer` with a
// future dueBy. When the carry-over turn runs, its link row re-points the
// interrupted inbound at itself — if it replies (or goes silent), the ledger is
// clean; if no next turn ever comes, reconcile fires LOST_REPLY, which is TRUE:
// the message never got an answer.

import { PACKET_RECORD_KIND } from '../consolidate/index.js';
import { signature, type Baselines, type Vec12 } from '../coupling/index.js';
import {
  appraise,
  draftEpisode,
  affectEvents,
  type EpisodeStore,
  type ProceduralStore,
  type SessionWindow,
} from '../memory/index.js';
import type { AffectStore } from '../affect/index.js';
import { runLoop, type LoopConfig, type LoopDeps, type LoopPacket, type LoopQuery } from '../loop/index.js';
import type { DecisionObject, ToolRegistry } from '../loop/index.js';
import { realize } from '../realize/index.js';
import type { Channel, InboundMsg, MessageLedger } from '../bridge/index.js';
import type { EventLog } from '../events/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import { fail, newId } from '../kernel/index.js';
import type { AffectEvent } from '../affect/index.js';
import type { Embedder } from '../embed/index.js';
import type { AssembleDeps, Packet, TurnQuery } from '../assemble/index.js';
import type { ModelClient } from '../model/index.js';
import type { InhibitionGate } from '../inhibit/index.js';
import type { ThreadIndex } from '../memory/threads.js';
import { localHourOfDay } from '../life/policy.js';
import { inferRegister } from './register.js';

/** Section head for undelivered bubbles carried into the next turn's context (M20 spec §Behavior). */
export const UNDELIVERED_HEAD = '[UNDELIVERED]';

const carryBlock = (bubbles: readonly string[]): string =>
  `\n${UNDELIVERED_HEAD}\nYou were interrupted mid-reply and these words were never sent. They are still true — re-weave them into what you say now (never paste them verbatim as a block):\n` +
  bubbles.map((b) => `- ${b}`).join('\n') +
  '\n';

interface Carry {
  bubbles: string[];
  /** The interrupted turn's inbound updateId — re-linked to the turn that finally answers. */
  fromUpdateId: number;
  fromTurnId: string;
}

interface Queued {
  m: InboundMsg;
  turnId: string;
  /** Entry context for self-initiated turns (M17 life); absent = a user turn. */
  kind?: 'heartbeat' | 'ponder' | undefined;
  /** What a self-initiated turn deliberates on — the heartbeat thought, the ponder seed. */
  goal?: string | undefined;
}

export interface SelfEntryHandle {
  /** The minted turn id. */
  turnId: string;
  /**
   * The heartbeat-outcome hook (Phase 1, 2026-09-02): settles EXACTLY ONCE with
   * the number of bubbles this turn actually delivered to the channel — 0 when
   * the turn went silent/deferred in-loop, was aborted mid-send, or died before
   * realizing. Every exit path settles, so an M17 job awaiting this can never
   * hang; a wedged turn would hold the job until the scheduler's timeout, and
   * the unwritten counters are the safe direction (nothing was sent).
   */
  sent: Promise<number>;
}

export interface PipelineDeps {
  model: ModelClient;
  gate: InhibitionGate;
  tools: ToolRegistry;
  channel: Channel;
  ledger: MessageLedger;
  affect: AffectStore;
  baselines: Baselines;
  episodes: EpisodeStore;
  procedures: ProceduralStore;
  window: SessionWindow;
  embedder: Embedder;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  /** M11's assemble, already closed over its nominators/coupling/config. */
  assemble: (q: TurnQuery, a: Vec12, deps: AssembleDeps) => Promise<Packet>;
  /** Fresh per turn: the weather line is read at assembly time, not at boot. */
  assembleDeps: () => AssembleDeps;
  loopCfg: LoopConfig;
  allowedChatIds: readonly number[];
  reconcileWindowMs: number;
  /**
   * The durable thread index (Round 3). The afterturn folds each appraisal's
   * threads[] into it — standing intent accrues here; the heartbeat reads it
   * due list. Optional only because hermetic tests that never touch threads
   * omit it; a prod boot always wires it.
   */
  threads?: ThreadIndex | undefined;
  /** Registry name for a speaker person id, when the people map knows him. */
  personLabel?: ((person: string) => string | undefined) | undefined;
  /** HIS zone (config timezone) — register inference's clock modifier. */
  timezone: string;
}

export interface Pipeline {
  /** Mint + enqueue. Returns the turnId (ingest links on it), or undefined when nothing should run (reaction-only, denied chat). */
  inbound(m: InboundMsg): string | undefined;
  /** Mint + enqueue a self-initiated turn (M17 heartbeat/ponder). The handle's `sent` settles with the delivered bubble count — the heartbeat-outcome hook the M17 job counts on. */
  selfEntry(kind: 'heartbeat' | 'ponder', goal: string): SelfEntryHandle;
  /** Epoch ms of the last real user arrival (reactions included) — the M17 conversation-active mutex input. */
  lastInboundAtMs(): number | undefined;
  isBusy(): boolean;
  /** Settle the queue and every detached afterturn — shutdown and probe quiesce. */
  drain(): Promise<void>;
  lastDecision(): DecisionObject | null;
}

export const makePipeline = (deps: PipelineDeps): Pipeline => {
  const queue: Queued[] = [];
  const recentTurnIds: string[] = [];
  const afterturns: Promise<unknown>[] = [];
  // The heartbeat-outcome hook's pending settlements, by turnId. A self-entry
  // with no waiter (compose-less probes) is settled and dropped — never a leak.
  const selfOutcomes = new Map<string, (sent: number) => void>();

  /** Settles a self-entry's sent count exactly once; every turn exit calls this. */
  const settleSelfOutcome = (turnId: string, sent: number): void => {
    const settle = selfOutcomes.get(turnId);
    selfOutcomes.delete(turnId);
    settle?.(sent);
  };

  let running = false;
  let chain: Promise<void> = Promise.resolve();
  let carry: Carry | null = null;
  let last: DecisionObject | null = null;
  let lastTurnId: string | null = null;
  let lastInboundAt: number | undefined;
  // The in-flight turn's abort handle, armed only once realization begins —
  // an inbound that lands during deliberation just waits its turn.
  let live: { abort: AbortController; armed: boolean } | null = null;

  const drain = async (): Promise<void> => {
    await chain;
    await Promise.allSettled(afterturns);
  };

  const pump = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await runTurn(item);
      } catch (e) {
        // A turn that throws outside its own handling is a loud incident; the
        // ledger keeps the inbound row so reconcile names what was lost. Its
        // self-entry outcome settles at 0 first: a dead turn sent nothing, and
        // the awaiting heartbeat job must not hang on it.
        settleSelfOutcome(item.turnId, 0);
        void deps.events.emit('incident.turn_failed', { turnId: item.turnId, error: String(e) }, item.turnId);
      }
    }
  };

  const kick = (): void => {
    if (running) return;
    running = true;
    chain = chain
      .then(async () => {
        try {
          await pump();
        } finally {
          running = false;
        }
      })
      .catch(() => {
        running = false;
      });
  };

  const runTurn = async (item: Queued): Promise<void> => {
    const { m, turnId } = item;
    const t0 = deps.clock.epochMs();

    // Tick decay + persist so the weather the packet is chosen against is now,
    // not whenever affect last moved. Empty batch: no semantic change, just time.
    await deps.affect.applyEvents([], { source: 'other' });
    const sig = signature(deps.affect.current(), deps.baselines);
    const vecs = await deps.embedder.embed([m.text]);
    const queryVec = vecs[0] ?? fail('app/turn', `embedder returned no vector for turn ${turnId}`);

    // Carry-over link: this turn inherited the interrupted reply, so the
    // interrupted inbound is answered by whatever this turn decides.
    if (carry !== null && carry.fromUpdateId !== m.updateId) {
      await deps.ledger.linkTurn(carry.fromUpdateId, turnId);
    }
    const inherited = carry;
    carry = null; // consumed exactly once — silence after carry is an informed silence

    const adapterDeps: AssembleDeps = deps.assembleDeps();
    const adapter = async (q: LoopQuery, a: Vec12): Promise<LoopPacket> => {
      const entry = q.entry ?? 'user-turn';
      const label = deps.personLabel?.(((q.speaker as TurnQuery['speaker']) ?? m.speaker).person);
      const tq: TurnQuery = {
        entry,
        ...(q.text !== undefined ? { text: q.text } : {}),
        ...(q.goal !== undefined ? { goal: q.goal } : {}),
        speaker: (q.speaker as TurnQuery['speaker']) ?? m.speaker,
        ...(label !== undefined ? { personLabel: label } : {}),
        // Register inference (Round 3): HIS words pick the frame, bounded by
        // HIS wall clock — the mode system's exclusivity then selects scenes.
        register:
          q.register ??
          (entry === 'user-turn' && q.text !== undefined
            ? inferRegister(q.text, localHourOfDay(deps.clock.epochMs(), deps.timezone))
            : 'play'),
        queryVec: q.queryVec ?? queryVec,
        recentTurnIds: q.recentTurnIds ?? recentTurnIds,
        ...(q.turnId !== undefined ? { turnId: q.turnId } : {}),
      };
      const packet = await deps.assemble(tq, a, adapterDeps);
      const rec = packet.record();
      // M10's credit input — the pipeline owns the emission so packet ids and
      // decision ids can never drift (runLoop forwards entry.turnId for this).
      void deps.events.emit(
        PACKET_RECORD_KIND,
        { ...rec, affectSig: Array.from(rec.affectSig) },
        rec.turnId,
      );
      if (inherited !== null) {
        return {
          ...packet,
          systemText: () => packet.systemText() + carryBlock(inherited.bubbles),
        };
      }
      return packet;
    };

    const loopDeps: LoopDeps = {
      model: deps.model,
      gate: deps.gate,
      assemble: adapter,
      affect: sig,
      window: deps.window,
      tools: deps.tools,
      events: deps.events,
      clock: deps.clock,
      rng: deps.rng.fork(`turn:${turnId}`),
      cfg: deps.loopCfg,
    };

    const decision = await runLoop(
      {
        kind: item.kind ?? 'user-turn',
        inbound: m,
        turnId,
        ...(item.goal !== undefined ? { goal: item.goal } : {}),
      },
      loopDeps,
    );
    last = decision;

    // Decision row lands BEFORE realization: a crash mid-send still shows the
    // plan. Provenance rides along: a `decidedBy:'failure'` silence is NOT a
    // termination for reconcile — the reply stays owed. A model-authored
    // defer carries its due-by in the same row (the ledger rejects a defer
    // without one, and a rejected row would have thrown the turn away).
    const now = deps.clock.epochMs();
    await deps.ledger.recordDecision(turnId, {
      turnId,
      plan: decision.plan,
      at: now,
      decidedBy: decision.decidedBy,
      ...(decision.plan === 'defer' ? { dueBy: now + deps.reconcileWindowMs } : {}),
    });

    if (decision.plan !== 'reply' || decision.bubbles.length === 0) {
      await settle(turnId, m, decision, [], item.kind);
      settleSelfOutcome(turnId, 0); // in-loop silence/defer: nothing was sent, nothing counted (Phase 1)
      return;
    }

    // Stage 6. Skip when the queue already holds newer words; abort if words
    // arrive mid-send — both are the same carry-over path.
    const abort = new AbortController();
    live = { abort, armed: true };
    const stale = queue.length > 0;
    const report = stale
      ? { plan: decision.plan, sent: [], aborted: true, undelivered: [...decision.bubbles] }
      : await realize(decision, sig, deps.rng.fork(`realize:${turnId}`), {
          chatId: m.chatId,
          channel: deps.channel,
          clock: deps.clock,
          signal: abort.signal,
          recordSend: (msgId, text) => deps.ledger.recordOutbound(turnId, msgId, text),
        });
    live = null;

    if (report.aborted && report.undelivered.length > 0) {
      carry = { bubbles: [...report.undelivered], fromUpdateId: m.updateId, fromTurnId: turnId };
      await deps.ledger.recordDecision(turnId, {
        turnId,
        plan: 'defer',
        at: deps.clock.epochMs(),
        decidedBy: 'model', // she decided to reply; the interruption deferred the delivery
        dueBy: deps.clock.epochMs() + deps.reconcileWindowMs, // strictly future: clean while the carry-over turn may still land
      });
    }

    // The abort path settles at 0 too: the undelivered bubbles ride the
    // carry-over into the NEXT turn, so this one genuinely sent nothing.
    settleSelfOutcome(turnId, report.sent.length);
    await settle(turnId, m, decision, report.sent.map((s) => s.text), item.kind);
    void deps.events.emit(
      'app.turn_done',
      { turnId, plan: decision.plan, sent: report.sent.length, undelivered: report.undelivered.length, ms: deps.clock.epochMs() - t0 },
      turnId,
    );
  };

  /** Stage 7 bookkeeping that is NOT detached (the verbatim window), then the detached afterturn.
   *  A self-initiated turn (M17) never enters the window as a user utterance and runs no
   *  appraisal — the goal text is hers, not something he said; ponder writes its own artifact. */
  const settle = async (
    turnId: string,
    m: InboundMsg,
    decision: DecisionObject,
    sentTexts: string[],
    selfKind?: 'heartbeat' | 'ponder' | undefined,
  ): Promise<void> => {
    const prevTurnId = lastTurnId;
    lastTurnId = turnId;
    recentTurnIds.push(turnId);
    while (recentTurnIds.length > 10) recentTurnIds.shift();

    // The window is the verbatim record — it must hold the exchange even if
    // appraisal dies. Only delivered texts enter it; undelivered ones travel
    // via the carry-over block instead.
    if (selfKind === undefined) {
      deps.window.push({ role: 'user', content: m.text, ts: m.ts, turnId });
    }
    for (const text of sentTexts) {
      deps.window.push({ role: 'assistant', content: text, ts: deps.clock.epochMs(), turnId });
    }

    if (selfKind !== undefined) return;

    const at = deps.affect.current();
    const affectAtEncoding: readonly number[] = Array.from(signature(at, deps.baselines));
    const task: Promise<void> = (async () => {
      const out = await appraise(
        {
          userText: m.text,
          herReply: sentTexts.length > 0 ? sentTexts.join('\n') : null,
          plan: decision.plan,
          prevTurnId,
          turnId,
        },
        { model: deps.model, events: deps.events },
      );
      if (!out.ok) {
        void deps.events.emit('incident.appraisal_failed', { turnId, error: out.error }, turnId);
        return;
      }
      await deps.episodes.append(
        draftEpisode(
          { clock: deps.clock, rng: deps.rng, affectAt: () => affectAtEncoding },
          { turnId, ts: deps.clock.epochMs(), appraisal: out.appraisal },
        ),
      );
      // Standing intent (Round 3): the appraisal's threads[] fold into the
      // durable index — open/touched threads come due for the heartbeat's
      // follow-up six hours later. A fold failure must not unsend the turn:
      // it lands as an incident, the episode above is already durable.
      if (deps.threads !== undefined && out.appraisal.threads.length > 0) {
        try {
          deps.threads.apply(out.appraisal.threads, deps.clock.epochMs());
        } catch (e) {
          void deps.events.emit('incident.thread_fold_failed', { turnId, error: e instanceof Error ? e.message : String(e) }, turnId);
        }
      }
      const evs: AffectEvent[] = affectEvents(out.appraisal);
      if (evs.length > 0) await deps.affect.applyEvents(evs, { source: 'appraisal' });
    })();
    afterturns.push(task);
    void task.catch(() => {
      /* handled inside; drain() allSettled's the rest */
    });
  };

  // M17 life entries: she starts the turn herself. The synthetic InboundMsg is
  // deliberately never ledger-recorded (no real updateId — delivery correctness
  // is a user-arrival law); if the turn dies, incident.turn_failed is the trace.
  // The returned handle settles on realization outcome (the heartbeat-outcome
  // hook): the M17 job moves its counters only when bubbles actually left.
  const selfEntry = (kind: 'heartbeat' | 'ponder', goal: string): SelfEntryHandle => {
    const chatId = deps.allowedChatIds[0] ?? fail('app/self-entry', 'no allowed chat for a self-initiated turn');
    const m: InboundMsg = {
      updateId: 0,
      msgId: 0,
      chatId,
      ts: deps.clock.epochMs(),
      text: goal,
      // v1 is telegram-only; the speaker ref mirrors what the bridge records.
      speaker: { channel: 'telegram', person: `tg:${chatId}` },
    };
    const turnId = newId(deps.clock, deps.rng);
    let settleSent!: (sent: number) => void;
    const sent = new Promise<number>((resolve) => {
      settleSent = resolve;
    });
    selfOutcomes.set(turnId, settleSent);
    queue.push({ m, turnId, kind, goal });
    kick();
    return { turnId, sent };
  };

  return {
    inbound: (m) => {
      // A skipped update (photo without caption, edit, denied chat — the
      // bridge marks them) is recorded only so the offset can move past it:
      // no turn, no reply owed, and it does not count as him talking to her.
      if (m.skipped !== undefined) {
        void deps.events.emit('bridge.update_skipped', { updateId: m.updateId, chatId: m.chatId, reason: m.skipped.reason });
        return undefined;
      }
      if (m.chatId !== undefined && !deps.allowedChatIds.includes(m.chatId)) {
        // A stranger's message is not contact — it must not mute the heartbeat.
        void deps.events.emit('app.chat_denied', { chatId: m.chatId, updateId: m.updateId });
        return undefined;
      }
      lastInboundAt = deps.clock.epochMs();
      // A reaction is an outcome signal, never a request (M15). Recorded on L0
      // for credit (M10/S7); it starts no turn and owes no reply.
      if (m.reaction !== undefined && m.text === '') {
        void deps.events.emit(
          'memory.reaction',
          { emoji: m.reaction.emoji, toMsgId: m.reaction.toMsgId, msgId: m.msgId, chatId: m.chatId, updateId: m.updateId, ts: m.ts },
        );
        return undefined;
      }
      const turnId = newId(deps.clock, deps.rng);
      queue.push({ m, turnId });
      if (live !== null && live.armed) live.abort.abort(); // interruption: she stops typing
      kick();
      return turnId;
    },
    isBusy: () => running || queue.length > 0,
    selfEntry,
    lastInboundAtMs: () => lastInboundAt,
    drain,
    lastDecision: () => last,
  };
};
