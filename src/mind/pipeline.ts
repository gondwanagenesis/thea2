// v8 mind — the turn pipeline. The delivery plumbing is v7's proven path
// (single-flight drain, interruption + carry-over, decision row before
// realization, ledger rows per send, errors folded into values). What changed
// is the mind around the model call:
//
//   SENSE → EVOKE → FEEL fast → MODULATE → THINK&SPEAK (one call) → EXPRESS
//   then, detached: FEEL slow → REMEMBER (outcome, value, reconsolidation)
//
// Nothing about her feelings or style is written into her prompt (law 1.1);
// her state reaches the turn through what comes to mind (evoke), how her mind
// runs (modulate), and how the words are paced (realize reads the signature).

import { signature, type Baselines, type CompiledCoupling } from '../coupling/index.js';
import type { AffectStore, EmotionEventInput } from '../affect/index.js';
import type { SessionWindow } from '../memory/index.js';
import { TURN_ABORTED_INCIDENT, runLoop, type DecisionObject, type LoopConfig, type LoopDeps, type LoopEntry, type LoopPacket, type ToolRegistry } from '../loop/index.js';
import { asError, fail, newId, type Clock, type Rng } from '../kernel/index.js';
import { realize } from '../realize/index.js';
import type { Channel, InboundMsg, MessageLedger } from '../bridge/index.js';
import type { EventLog } from '../events/index.js';
import type { Embedder } from '../embed/index.js';
import type { ModelClient } from '../model/index.js';
import type { InhibitionGate } from '../inhibit/index.js';
import { sense, replyText, type Sensed } from './sense.js';
import { evoke, EVOKE_DEFAULTS, type Evoked } from './evoke.js';
import { feelFast, type FastEvent } from './feel.js';
import { metabolism, type Metabolism } from './modulate.js';
import { composePacket, hourIn, V8_OUTPUT_CONTRACT } from './compose.js';
import { appraiseSlow, slowEvents } from './appraise.js';
import { applyOutcome, bestOption, encodeLived, FOLLOW_THRESHOLD, markShown } from './remember.js';
import { vecToArray } from './vocab.js';
import type { MindStore } from './store.js';
import type { Concern, Line } from './types.js';

export const UNDELIVERED_HEAD = '[unsent]';

const carryBlock = (bubbles: readonly string[]): string =>
  `\n\n${UNDELIVERED_HEAD}\nyou were interrupted and these words were never sent:\n` + bubbles.map((b) => `- ${b}`).join('\n');

interface Carry {
  bubbles: string[];
  fromUpdateId: number;
  fromTurnId: string;
}

interface Queued {
  m: InboundMsg;
  turnId: string;
  /** Self-initiated (a thought became a wish to text him). */
  kind?: 'heartbeat' | undefined;
  goal?: string | undefined;
}

export interface SelfEntryHandle {
  turnId: string;
  sent: Promise<number>;
}

/**
 * v9: the body, as the mind sees it (app wires src/body into this; mind never
 * imports body). Senses resolve an inbound into the text the turn runs on;
 * tools send media inside a turn and report it at the end; a voice note gets
 * a spoken answer.
 */
export interface BodySeam {
  perceive(m: InboundMsg): Promise<{ text: string; voice: boolean }>;
  begin(turnId: string, ctx: { chatId: number; inboundMsgId?: number | undefined }): void;
  /** What she sent besides text bubbles during the turn (already on the ledger). */
  end(turnId: string): Array<{ msgId: number; text: string }>;
  /** Speak the reply as a voice note; undefined = could not (the text path takes over). */
  speak(chatId: number, text: string, turnId: string): Promise<{ msgId: number } | undefined>;
  onSkipped(m: InboundMsg): void;
  /** Facts about his present for [now] (where he is, his local time and sky). */
  nowFacts?(): string[];
}

export interface MindPipelineDeps {
  model: ModelClient;
  /** Tried once when the primary door fails outright (decidedBy 'failure'). */
  fallbackModel?: ModelClient | undefined;
  gate: InhibitionGate;
  tools: ToolRegistry;
  channel: Channel;
  ledger: MessageLedger;
  affect: AffectStore;
  baselines: Baselines;
  coupling: CompiledCoupling;
  window: SessionWindow;
  embedder: Embedder;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  mind: MindStore;
  loopCfg: LoopConfig;
  allowedChatIds: readonly number[];
  reconcileWindowMs: number;
  personLabel?: ((person: string) => string | undefined) | undefined;
  timezone: string;
  /** Fraction of today's idle budget left (0..1) — energy reads it. */
  budgetLeft: () => number;
  /** v9 body (senses + hands). Absent ⇒ text-only v8. */
  body?: BodySeam | undefined;
}

export interface MindPipeline {
  inbound(m: InboundMsg): string | undefined;
  selfEntry(kind: 'heartbeat', goal: string): SelfEntryHandle;
  lastInboundAtMs(): number | undefined;
  isBusy(): boolean;
  drain(): Promise<void>;
  lastDecision(): DecisionObject | null;
}

/** The last few window lines as him/her context (oldest first). */
const contextLines = (window: SessionWindow, n = 3): Line[] =>
  window
    .messages()
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-n)
    .map((m) => ({ who: m.role === 'user' ? ('him' as const) : ('her' as const), text: String(m.content) }));

export const makeMindPipeline = (deps: MindPipelineDeps): MindPipeline => {
  const queue: Queued[] = [];
  const afterturns: Promise<unknown>[] = [];
  const selfOutcomes = new Map<string, (sent: number) => void>();
  const settleSelfOutcome = (turnId: string, sent: number): void => {
    const s = selfOutcomes.get(turnId);
    selfOutcomes.delete(turnId);
    s?.(sent);
  };

  let running = false;
  let chain: Promise<void> = Promise.resolve();
  /** Afterturns (slow appraisal → remember) run one at a time, in turn order. */
  let afterChain: Promise<void> = Promise.resolve();
  let carry: Carry | null = null;
  let last: DecisionObject | null = null;
  let lastInboundAt: number | undefined;
  let live: { abort: AbortController; armed: boolean } | null = null;

  const emit = (kind: string, payload: Record<string, unknown>, turnId?: string): void => {
    void deps.events.emit(kind, payload, turnId);
  };

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
        settleSelfOutcome(item.turnId, 0);
        emit('incident.turn_failed', { turnId: item.turnId, error: String(e) }, item.turnId);
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

  /** Stage 1-3: sense, evoke, feel fast. Fail-open: a dead embedder yields a bare packet, never a dead turn. */
  const perceive = async (
    item: Queued,
    before: Line[],
  ): Promise<{ sensed: Sensed | null; evoked: Evoked; fast: FastEvent[]; met: Metabolism }> => {
    const now = deps.clock.epochMs();
    const selfEntry = item.kind !== undefined;
    const his = selfEntry ? '' : item.m.text;
    const st = deps.mind.state();
    let sensed: Sensed | null = null;
    try {
      sensed = await sense(before, selfEntry ? (item.goal ?? '') : his, { embedder: deps.embedder, centroids: deps.mind.centroids() });
    } catch (e) {
      emit('incident.mind_sense_failed', { turnId: item.turnId, error: asError(e).message }, item.turnId);
    }
    const a0 = signature(deps.affect.current(), deps.baselines);
    const met0 = metabolism(deps.affect.current(), a0, { hourLocal: hourIn(now, deps.timezone), budgetLeft: deps.budgetLeft() });
    const evoked: Evoked =
      sensed === null
        ? { options: [], memories: [], considered: 0 }
        : evoke(deps.mind, {
            queryVec: sensed.situationVec,
            ...(selfEntry ? {} : { hisQueryVec: sensed.hisVec }),
            move: sensed.move?.label,
            a: a0,
            now,
            turn: st.turn,
            rng: deps.rng.fork(`evoke:${item.turnId}`),
            coupling: deps.coupling,
            cfg: { ...EVOKE_DEFAULTS, k: met0.k, mmrLambda: met0.mmrLambda, sampleTemp: met0.sampleTemp, shortBias: met0.shortBias },
          });

    let fast: FastEvent[] = [];
    if (!selfEntry && sensed !== null) {
      const concerns = deps.mind.openConcerns().map((c) => ({ c, vec: deps.mind.concernVec(c.id) }));
      fast = feelFast({
        evoked,
        tone: sensed.tone,
        hisVec: sensed.hisVec,
        concerns,
        now,
      });
      if (fast.length > 0) {
        try {
          await deps.affect.applyEvents(fast.map((f) => f.event), { source: 'appraisal' });
        } catch (e) {
          emit('incident.mind_feel_failed', { turnId: item.turnId, stage: 'fast', error: asError(e).message }, item.turnId);
        }
      }
      emit('mind.felt', { turnId: item.turnId, stage: 'fast', events: fast.map((f) => ({ source: f.source, tag: f.event.tag, i: f.event.i })) }, item.turnId);
    }
    // The metabolism the model call runs on is set AFTER the fast feeling landed: her immediate reaction is part of this turn.
    const a1 = signature(deps.affect.current(), deps.baselines);
    const met = metabolism(deps.affect.current(), a1, { hourLocal: hourIn(now, deps.timezone), budgetLeft: deps.budgetLeft() });
    return { sensed, evoked, fast, met };
  };

  const runTurn = async (raw: Queued): Promise<void> => {
    const t0 = deps.clock.epochMs();
    const selfEntry = raw.kind !== undefined;
    // v9 SENSE, part one: what came with his words (a photo, his voice, a file,
    // a place) becomes the text this turn runs on — before anything is recalled.
    let item = raw;
    let voiceReply = false;
    if (deps.body !== undefined && !selfEntry) {
      void deps.channel.typing(raw.m.chatId).catch(() => undefined);
      try {
        const p = await deps.body.perceive(raw.m);
        item = { ...raw, m: { ...raw.m, text: p.text } };
        voiceReply = p.voice;
      } catch (e) {
        emit('incident.body_sense_failed', { turnId: raw.turnId, error: asError(e).message }, raw.turnId);
      }
    }
    deps.body?.begin(item.turnId, { chatId: item.m.chatId, ...(selfEntry ? {} : { inboundMsgId: item.m.msgId }) });
    const { m, turnId } = item;

    await deps.affect.applyEvents([], { source: 'other' }); // bring the engine to now
    const before = contextLines(deps.window);
    const { sensed, evoked, fast, met } = await perceive(item, before);

    if (carry !== null && carry.fromUpdateId !== m.updateId) await deps.ledger.linkTurn(carry.fromUpdateId, turnId);
    const inherited = carry;
    carry = null;

    const st = deps.mind.state();
    const now = deps.clock.epochMs();
    const who = deps.personLabel?.(m.speaker.person) ?? 'he';
    const recentThoughts = deps.mind.stream().filter((t) => t.source === 'lived' && now - t.ts < 24 * 3600_000);
    const openConcerns: Concern[] = [...deps.mind.openConcerns()].sort((x, y) => y.importance - x.importance || y.touched - x.touched);
    const packet = composePacket({
      timeZone: deps.timezone,
      now,
      self: deps.mind.self(),
      concerns: openConcerns,
      thoughts: recentThoughts,
      options: evoked.options.map((s) => s.m),
      memories: evoked.memories.map((s) => s.m),
      lastHisAt: selfEntry ? st.lastHisAt : st.lastHisAt,
      who,
      selfEntry,
      nowFacts: deps.body?.nowFacts?.() ?? [],
    });
    const hits = packet.lint();
    if (hits.length > 0) emit('incident.mind_told', { turnId, hits }, turnId);

    const shownIds = evoked.options.map((s) => s.m.id);
    markShown(deps.mind, shownIds, st.turn, now);
    deps.mind.logShown({
      turn: st.turn,
      at: now,
      turnId,
      options: evoked.options.map((s) => ({ id: s.m.id, score: Math.round(s.score * 1000) / 1000, sim: Math.round(s.sim * 1000) / 1000 })),
      memories: evoked.memories.map((s) => s.m.id),
    });
    emit(
      'mind.evoked',
      {
        turnId,
        considered: evoked.considered,
        options: shownIds,
        memories: evoked.memories.map((s) => s.m.id),
        move: sensed?.move?.label ?? null,
        tone: sensed?.tone?.label ?? null,
        temperature: met.temperature,
        k: met.k,
      },
      turnId,
    );

    const loopPacket: LoopPacket =
      inherited === null
        ? packet
        : { systemText: () => packet.systemText() + carryBlock(inherited.bubbles), proceduralText: () => null, trailerText: () => packet.trailerText() };
    const sig = signature(deps.affect.current(), deps.baselines);
    const cfg: LoopConfig = { ...deps.loopCfg, assessTemperature: met.temperature, outputContract: V8_OUTPUT_CONTRACT };
    const loopDeps = (model: ModelClient): LoopDeps => ({
      model,
      gate: deps.gate,
      assemble: async () => loopPacket,
      affect: sig,
      window: deps.window,
      tools: deps.tools,
      events: deps.events,
      clock: deps.clock,
      rng: deps.rng.fork(`turn:${turnId}`),
      cfg,
    });
    const entry: LoopEntry = {
      kind: item.kind ?? 'user-turn',
      inbound: m,
      turnId,
      ...(item.goal !== undefined ? { goal: item.goal } : {}),
    };

    const failed = (code: string): DecisionObject => {
      emit(TURN_ABORTED_INCIDENT, { turnId, code, stage: 'mind' }, turnId);
      return { turnId, plan: 'silent', decidedBy: 'failure', bubbles: [], confidence: 0, weight: 0, reluctance: 1, completeness: 1, toolTrace: [], spawns: [], inhibitions: [] };
    };
    let decision: DecisionObject;
    try {
      decision = await runLoop(entry, loopDeps(deps.model));
    } catch (e) {
      decision = failed(asError(e).code);
    }
    if (decision.decidedBy === 'failure' && deps.fallbackModel !== undefined) {
      emit('mind.fallback', { turnId }, turnId);
      try {
        decision = await runLoop(entry, loopDeps(deps.fallbackModel));
      } catch (e) {
        decision = failed(asError(e).code);
      }
    }
    last = decision;

    if (!selfEntry) {
      await deps.ledger.recordDecision(turnId, {
        turnId,
        plan: decision.plan,
        at: deps.clock.epochMs(),
        decidedBy: decision.decidedBy,
        ...(decision.plan === 'defer' ? { dueBy: deps.clock.epochMs() + deps.reconcileWindowMs } : {}),
      });
    }

    if (decision.plan !== 'reply' || decision.bubbles.length === 0) {
      // v9: a turn can speak through its hands alone (a voice note, a photo, a reaction).
      const bodySent = deps.body?.end(turnId) ?? [];
      await settle(item, decision, bodySent, before, sensed, fast, met, shownIds);
      settleSelfOutcome(turnId, bodySent.length);
      return;
    }

    const abort = new AbortController();
    live = { abort, armed: true };
    const stale = queue.length > 0 && !selfEntry;
    // v9: he spoke, so she answers out loud — the same words, as one voice note.
    // A voice that fails falls back to the text path; nothing is ever lost to it.
    const spoken =
      !stale && voiceReply && deps.body !== undefined
        ? await deps.body.speak(m.chatId, decision.bubbles.join('\n'), turnId)
        : undefined;
    let report: { sent: Array<{ msgId: number; text: string }>; aborted: boolean; undelivered: string[] };
    if (spoken !== undefined) {
      const words = decision.bubbles.join('\n');
      await deps.ledger.recordOutbound(turnId, spoken.msgId, `[voice note] ${words}`);
      report = { sent: [{ msgId: spoken.msgId, text: words }], aborted: false, undelivered: [] };
    } else if (stale) {
      report = { sent: [], aborted: true, undelivered: [...decision.bubbles] };
    } else {
      const r = await realize(decision, sig, deps.rng.fork(`realize:${turnId}`), {
        chatId: m.chatId,
        channel: deps.channel,
        clock: deps.clock,
        signal: abort.signal,
        recordSend: (msgId, text) => deps.ledger.recordOutbound(turnId, msgId, text),
      });
      report = { sent: [...r.sent], aborted: r.aborted, undelivered: [...r.undelivered] };
    }
    live = null;

    if (report.aborted && report.undelivered.length > 0 && !selfEntry) {
      carry = { bubbles: [...report.undelivered], fromUpdateId: m.updateId, fromTurnId: turnId };
      await deps.ledger.recordDecision(turnId, {
        turnId,
        plan: 'defer',
        at: deps.clock.epochMs(),
        decidedBy: 'model',
        dueBy: deps.clock.epochMs() + deps.reconcileWindowMs,
      });
    }

    const bodySent = deps.body?.end(turnId) ?? [];
    settleSelfOutcome(turnId, report.sent.length + bodySent.length);
    await settle(item, decision, [...bodySent, ...report.sent], before, sensed, fast, met, shownIds);
    emit('app.turn_done', { turnId, plan: decision.plan, sent: report.sent.length, undelivered: report.undelivered.length, ms: deps.clock.epochMs() - t0, mind: 'v8' }, turnId);
  };

  /** Window bookkeeping (not detached), then the detached FEEL slow → REMEMBER. */
  const settle = async (
    item: Queued,
    decision: DecisionObject,
    sent: ReadonlyArray<{ msgId: number; text: string }>,
    before: Line[],
    sensed: Sensed | null,
    fast: FastEvent[],
    met: Metabolism,
    shownIds: string[],
  ): Promise<void> => {
    const { m, turnId } = item;
    const selfEntry = item.kind !== undefined;
    if (!selfEntry) await deps.window.push({ role: 'user', content: m.text, ts: m.ts, turnId });
    for (const s of sent) await deps.window.push({ role: 'assistant', content: s.text, ts: deps.clock.epochMs(), turnId });

    // Her state at encoding: after the fast feeling, before the slow one (what she was feeling as she spoke).
    const sigAtEncoding = vecToArray(signature(deps.affect.current(), deps.baselines));
    const hers = sent.map((s) => s.text);
    const now = deps.clock.epochMs();

    // What came BEFORE this turn — the afterturn grades against it — captured
    // now, then the bookkeeping for THIS turn lands synchronously, so a quick
    // next message from him already sees her newest expectation and reply.
    const prevState = deps.mind.state();
    const momentId = hers.length > 0 ? `m_${now}_${newId(deps.clock, deps.rng).slice(-6)}` : undefined;
    const sync: Parameters<MindStore['setState']>[0] = { turn: prevState.turn + 1 };
    if (!selfEntry) sync.lastHisAt = m.ts;
    if (momentId !== undefined) {
      sync.lastMomentId = momentId;
      sync.lastHerAt = now;
      sync.lastShown = { turn: prevState.turn, at: now, ids: shownIds };
      sync.lastExpect = decision.expect !== undefined ? { text: decision.expect, at: now, momentId } : undefined;
    }
    deps.mind.setState(sync);

    // Afterturns run strictly in order (each grades the reply before it).
    const task = afterChain.then(async () => {
      const prev = prevState.lastMomentId !== undefined ? deps.mind.get(prevState.lastMomentId) : undefined;
      const gapHours = !selfEntry && prevState.lastHisAt !== undefined ? (m.ts - prevState.lastHisAt) / 3600_000 : undefined;

      const slow = await appraiseSlow(
        {
          his: selfEntry ? '' : m.text,
          hers,
          gapHours,
          prevHers: prev?.hers,
          expect: prevState.lastExpect?.text,
          concerns: deps.mind.openConcerns(),
          standards: deps.mind.standards(),
          alreadyFelt: fast.map((f) => f.event.tag),
          selfEntry,
        },
        { model: deps.model, turnId },
      );

      let importance: number | undefined;
      if (slow.ok) {
        importance = slow.value.importance;
        const evs = slowEvents(slow.value, fast.map((f) => ({ tag: f.event.tag, i: f.event.i })), prevState.lastExpect?.text);
        if (evs.length > 0) {
          try {
            await deps.affect.applyEvents(evs.map((e) => e.event as EmotionEventInput), { source: 'appraisal' });
          } catch (e) {
            emit('incident.mind_feel_failed', { turnId, stage: 'slow', error: asError(e).message }, turnId);
          }
        }
        emit('mind.felt', { turnId, stage: 'slow', events: evs.map((e) => ({ source: e.source, tag: e.event.tag, i: e.event.i })) }, turnId);

        // How her previous reply landed → value, followed option, reconsolidation.
        if (!selfEntry && prev !== undefined && slow.value.outcome_prev !== null) {
          const r = applyOutcome(deps.mind, {
            momentId: prev.id,
            outcome: { landed: slow.value.outcome_prev.landed, why: slow.value.outcome_prev.why, at: deps.clock.epochMs() },
            alpha: met.learningRate,
            followedId: prev.followedFrom ?? null,
            now: deps.clock.epochMs(),
          });
          emit('mind.outcome', { turnId, momentId: prev.id, landed: slow.value.outcome_prev.landed, rpe: r?.rpe ?? null, followed: prev.followedFrom ?? null }, turnId);
        }

        // Concerns: loops opened, touched, closed.
        const newVecTexts: Array<{ id: string; what: string }> = [];
        for (const op of slow.value.concerns) {
          const existing = op.id !== undefined ? deps.mind.concerns().find((c) => c.id === op.id) : undefined;
          if (op.op === 'open' || existing === undefined) {
            if (op.op === 'close') continue;
            const id = `c_${now}_${newId(deps.clock, deps.rng).slice(-6)}`;
            deps.mind.upsertConcern({
              id,
              what: op.what,
              kind: op.kind ?? 'loop',
              about: op.about ?? 'diego',
              ...(op.due_hours !== undefined ? { due: now + op.due_hours * 3600_000 } : {}),
              importance: op.importance ?? 5,
              status: 'open',
              created: now,
              touched: now,
              source: 'lived',
            });
            newVecTexts.push({ id, what: op.what });
          } else {
            deps.mind.upsertConcern({
              ...existing,
              what: op.op === 'update' ? op.what : existing.what,
              ...(op.due_hours !== undefined ? { due: now + op.due_hours * 3600_000 } : {}),
              ...(op.importance !== undefined ? { importance: op.importance } : {}),
              status: op.op === 'close' ? 'closed' : 'open',
              touched: now,
            });
          }
        }
        if (newVecTexts.length > 0) {
          try {
            const vs = await deps.embedder.embed(newVecTexts.map((x) => x.what));
            newVecTexts.forEach((x, k) => {
              const v = vs[k];
              if (v !== undefined) deps.mind.setConcernVec(x.id, v);
            });
          } catch (e) {
            emit('incident.mind_embed_failed', { turnId, stage: 'concerns', error: asError(e).message }, turnId);
          }
        }
      } else {
        emit('incident.mind_appraisal_failed', { turnId, error: slow.error }, turnId);
      }

      // The lived moment: only when she actually said something.
      if (momentId !== undefined) {
        let replyVec: Float32Array | undefined;
        try {
          [replyVec] = await deps.embedder.embed([replyText(hers)]);
        } catch (e) {
          emit('incident.mind_embed_failed', { turnId, stage: 'reply', error: asError(e).message }, turnId);
        }
        const best = replyVec !== undefined ? bestOption(replyVec, shownIds, deps.mind) : null;
        const followed = best !== null && best.sim >= FOLLOW_THRESHOLD ? best : null;
        const moment = encodeLived({
          id: momentId,
          now,
          kind: selfEntry ? 'text_first' : 'reply',
          before,
          his: selfEntry ? '' : m.text,
          hers,
          sig: sigAtEncoding,
          move: sensed?.move?.label,
          tone: sensed?.tone?.label,
          expect: decision.expect,
          importance,
        });
        moment.msgIds = sent.map((s) => s.msgId);
        moment.followedFrom = followed?.id ?? null;
        moment.shownOptions = shownIds;
        deps.mind.add(moment, {
          ...(sensed !== null ? { sit: sensed.situationVec } : {}),
          ...(sensed !== null && !selfEntry ? { his: sensed.hisVec } : {}),
          ...(replyVec !== undefined ? { reply: replyVec } : {}),
        });
        emit('mind.remembered', { turnId, momentId, followed: followed?.id ?? null, closest: best?.id ?? null, closestSim: best !== null ? Math.round(best.sim * 1000) / 1000 : null, felt: moment.felt.word ?? null }, turnId);
      }
      await deps.mind.flush();
    });
    afterturns.push(task);
    // The chain survives a failed afterturn: the next one still runs, in order.
    afterChain = task.catch((e) => {
      emit('incident.mind_afterturn_failed', { turnId, error: String(e) }, turnId);
    });
  };

  /** ⭐ keeps a moment forever; 👎 means never again. Other reactions are just warmth, recorded. */
  const onReaction = (m: InboundMsg): void => {
    const r = m.reaction;
    if (r === undefined) return;
    const target = deps.mind.moments().find((x) => x.msgIds?.includes(r.toMsgId) === true);
    emit('memory.reaction', { emoji: r.emoji, toMsgId: r.toMsgId, momentId: target?.id ?? null, updateId: m.updateId });
    if (target === undefined) return;
    if (r.emoji === '⭐' || r.emoji === '🌟') deps.mind.update(target.id, { gold: true });
    else if (r.emoji === '👎') deps.mind.update(target.id, { never: true });
    void deps.mind.flush();
  };

  const selfEntryFn = (kind: 'heartbeat', goal: string): SelfEntryHandle => {
    const chatId = deps.allowedChatIds[0] ?? fail('mind/self-entry', 'no allowed chat for a self-initiated turn');
    const m: InboundMsg = {
      updateId: 0,
      msgId: 0,
      chatId,
      ts: deps.clock.epochMs(),
      text: goal,
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
      if (m.skipped !== undefined) {
        emit('bridge.update_skipped', { updateId: m.updateId, chatId: m.chatId, reason: m.skipped.reason });
        if (deps.allowedChatIds.includes(m.chatId)) deps.body?.onSkipped(m);
        return undefined;
      }
      if (m.chatId !== undefined && !deps.allowedChatIds.includes(m.chatId)) {
        emit('app.chat_denied', { chatId: m.chatId, updateId: m.updateId });
        return undefined;
      }
      lastInboundAt = deps.clock.epochMs();
      if (m.reaction !== undefined && m.text === '') {
        onReaction(m);
        return undefined;
      }
      const turnId = newId(deps.clock, deps.rng);
      queue.push({ m, turnId });
      if (live !== null && live.armed) live.abort.abort();
      kick();
      return turnId;
    },
    selfEntry: selfEntryFn,
    lastInboundAtMs: () => lastInboundAt,
    isBusy: () => running || queue.length > 0,
    drain,
    lastDecision: () => last,
  };
};
