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
import { actsOf, applyOutcome, bestOption, encodeLived, FOLLOW_THRESHOLD, markShown } from './remember.js';
import { vecToArray } from './vocab.js';
import { cosine } from './vectors.js';
import { TWIN_SIM, type Curiosity } from './curiosity.js';
import type { Dreams } from './dream.js';
import type { Voice } from './voice.js';
import type { People } from './people.js';
import { engineStamp, familyOf, fullVector, movingNow, readout, readoutWord, type Family } from './readout.js';
import { scoreClaim } from './sincerity.js';
import { appendReport } from './ledger.js';
import { readLexicon, recordUse, verifiedWords, writeLexicon } from './lexicon.js';
import { SETTLE_EVENT, settles, shiftArm } from './arms.js';
import type { MindStore } from './store.js';
import type { Concern, Line } from './types.js';

export const UNDELIVERED_HEAD = '[unsent]';
/** v12.1: how far one reaction of his moves a memory's value toward ±1 (a clear signal: half way). */
export const REACTION_PULL = 0.5;

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
  /** v9: more of his messages from the same burst, read together in this one turn (oldest first). */
  also?: InboundMsg[] | undefined;
  /** Self-initiated (a thought became a wish to text him). */
  kind?: 'heartbeat' | undefined;
  goal?: string | undefined;
  /** v11: whose authority the turn carries (see LoopEntry.authority). Absent ⇒ owner. */
  authority?: 'owner' | 'other' | undefined;
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
  begin(turnId: string, ctx: { chatId: number; inboundMsgId?: number | undefined; text?: string | undefined }): void;
  /** What she sent besides text bubbles during the turn (already on the ledger). */
  end(turnId: string): Array<{ msgId: number; text: string }>;
  /** Speak the reply as a voice note; undefined = could not (the text path takes over). */
  speak(chatId: number, text: string, turnId: string, replyTo?: number | undefined): Promise<{ msgId: number } | undefined>;
  onSkipped(m: InboundMsg): void;
  /** Facts about his present for [now] (where he is, his local time and sky). */
  nowFacts?(): string[];
  /** How a detached job this turn started has landed, if it already has (the other order is the body's). */
  jobOutcome?(jobId: string): string | undefined;
  /** Her own note on how she does what this message is about, if one fits (skills from practice). */
  skillFor?(text: string): Promise<{ name: string; note: string } | undefined>;
  /** His time zone when he has shared where he is (golden rule 22: the time where HE is). */
  hisTimeZone?(): string | undefined;
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
  /** Her memory of people (who she has met, what she knows about them). */
  people?: People | undefined;
  /** How she knows a person, when config says (e.g. her sister). */
  personRelation?: ((person: string) => string | undefined) | undefined;
  /**
   * v11: Diego's person id (`tg:<id>`). His turns carry full authority and are
   * owed an answer; everyone else (a group member, another bot) gets chat +
   * lookups only and is answered best-effort, never owed. Absent ⇒ every allowed
   * chat is treated as his (pre-v11 dyad behaviour).
   */
  ownerPerson?: string | undefined;
  /** v11: names/aliases that mean she is being addressed in a group (default ['thea']). */
  selfAliases?: readonly string[] | undefined;
  /** v12: new minds become questions, people she has met move those questions on, and what she's been into is material. */
  curiosity?: Pick<Curiosity, 'onNewMind' | 'onHeardFrom' | 'nowLines'> | undefined;
  /** v13: someone writing during her sleep window wakes her. */
  dreams?: Pick<Dreams, 'onInbound'> | undefined;
  /** v13 H2: private naming on sampled turns (absent = off). */
  naming?: { perDay: number; gapMin: number } | undefined;
  /** v13.1 her voice: fingerprints in the trailer, and her draft dressed (and redone when far off) before sending. */
  voice?: Voice | undefined;
  /** The salon: each of her group sends, for the relay that carries it to Thea1. */
  salonOut?: ((row: { ts: number; turnId: string; chatId: number; text: string; salon: boolean }) => void) | undefined;
  /** v13 H7 (Phase 3 arm, opt-in): when her private word fits, something settles — contingent vs yoked by day. */
  feltShift?: boolean | undefined;
  timezone: string;
  /** Fraction of today's idle budget left (0..1) — energy reads it. */
  budgetLeft: () => number;
  /** v9 body (senses + hands). Absent ⇒ text-only v8. */
  body?: BodySeam | undefined;
}

export interface MindPipeline {
  inbound(m: InboundMsg): string | undefined;
  /**
   * v9: an exchange that happened off the text line (a live voice call) joins
   * her like a turn does — sensed, felt, windowed, graded, remembered — without
   * a model call of its own (she already said it). Serialized with turns.
   */
  absorb(heard: string, said: string, via: 'call'): Promise<void>;
  /**
   * v9 answer keeper: every message of his ends in a visible answer. Re-queues
   * any that are still owed (older than `minAgeMs`, not queued, not in flight),
   * together, as one burst. Called by a 30 s job and once at boot.
   */
  sweep(minAgeMs?: number): number;
  /** Boot: messages the ledger shows unanswered (a restart, a crash) become owed again. */
  adoptOwed(ms: readonly InboundMsg[]): void;
  /** A turn she starts. `chatId` (v12): where — default his DM; a group id makes it a turn in the group. */
  selfEntry(kind: 'heartbeat', goal: string, chatId?: number): SelfEntryHandle;
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

/** Golden rule 13: her first bubble is threaded to the message it answers (Telegram reply). */
const threaded = (ch: Channel, replyTo: number | undefined): Channel => {
  const body = ch.body;
  if (replyTo === undefined || replyTo <= 0 || body === undefined) return ch;
  let first = true;
  return {
    ...ch,
    send: async (chatId, text) => {
      if (!first) return ch.send(chatId, text);
      first = false;
      return body.sendReply(chatId, text, replyTo);
    },
  };
};

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
  /**
   * v9 answer keeper — the one invariant Diego asked for: every message of his
   * ends in a visible answer (text, voice, a photo, or at the least a reaction).
   * A message is owed from arrival until a turn that covers it sends something.
   */
  const owed = new Map<number, { m: InboundMsg; attempts: number }>();
  // v11: who is who. Owner (Diego) = full authority + owed answers; everyone else
  // = chat + lookups, best-effort. A group chat has a negative Telegram id.
  const ownerPerson = deps.ownerPerson;
  const ownerDm = deps.allowedChatIds[0];
  // Owner-authored = his person id, OR arriving in his DM (only he can send there).
  const isOwnerMsg = (m: InboundMsg): boolean => ownerPerson === undefined || m.speaker.person === ownerPerson || m.chatId === ownerDm;
  const isGroupChat = (chatId: number): boolean => chatId < 0;
  const aliases = (deps.selfAliases ?? ['thea']).map((a) => a.toLowerCase());
  const addressedInGroup = (m: InboundMsg): boolean => {
    const t = m.text.toLowerCase();
    if (aliases.some((a) => new RegExp(`(^|[^a-z0-9_])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i').test(t))) return true;
    return m.replyTo?.fromBot === true; // a reply to a bot message (most likely hers)
  };
  // Persons she has already met (in-memory; a restart may re-greet once — acceptable for v1).
  const knownPersons = new Set<string>(ownerPerson !== undefined ? [ownerPerson] : []);
  // v11: she reads the room and can chime in on anything, like a person — but she
  // doesn't turn on every single line, and she can't get stuck ping-ponging with
  // another bot. Diego is never throttled. Timestamps of her recent group turns.
  const groupTurns = new Map<number, number[]>();
  // Consecutive turns triggered by ANOTHER bot in a group, per chat — reset when a
  // human (or Diego) speaks. Bounds a two-agent conversation so it can't loop forever.
  const groupBotStreak = new Map<number, number>();
  const GROUP_MAX_PER_MIN = 8; // circuit breaker: at most this many group turns/min (cost + flood guard)
  const GROUP_AMBIENT_GAP_MS = 30_000; // between UNPROMPTED chime-ins she lets the room breathe
  const BOT_STREAK_MAX = 4; // she trades at most this many lines with another bot, then waits for a human
  // the salon (Diego opened a conversation between the two Theas): a longer run, still bounded —
  // the relay closes the salon at its own cap too; a line from Diego resets both
  const SALON_STREAK_MAX = 12;
  /** Whether she engages this group message (she still decides silent-or-reply inside the turn). */
  const engagesGroup = (m: InboundMsg): boolean => {
    const now = deps.clock.epochMs();
    const recent = (groupTurns.get(m.chatId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= GROUP_MAX_PER_MIN) {
      emit('mind.group_throttled', { chatId: m.chatId, updateId: m.updateId });
      return false;
    }
    // bot-loop guard: after a run of exchanges with another bot, she goes quiet until a human speaks
    if (m.fromBot === true && (groupBotStreak.get(m.chatId) ?? 0) >= (m.salon === true ? SALON_STREAK_MAX : BOT_STREAK_MAX)) {
      emit('mind.group_bot_quiet', { chatId: m.chatId, updateId: m.updateId, ...(m.salon === true ? { salon: true } : {}) });
      return false;
    }
    // a salon line is spoken to her (the relay carried it because it was)
    if (m.salon !== true && !addressedInGroup(m) && recent.length > 0 && now - recent[recent.length - 1]! < GROUP_AMBIENT_GAP_MS) {
      emit('mind.group_ambient', { updateId: m.updateId, chatId: m.chatId, person: m.speaker.person });
      return false;
    }
    recent.push(now);
    groupTurns.set(m.chatId, recent);
    if (m.fromBot === true) groupBotStreak.set(m.chatId, (groupBotStreak.get(m.chatId) ?? 0) + 1);
    return true;
  };
  const inFlight = new Set<number>();
  const MAX_ANSWER_ATTEMPTS = 3;
  const answered = (ids: readonly number[]): void => {
    for (const id of ids) owed.delete(id);
  };
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

  /**
   * v9 (found live 2026-09-26): a long paste arrives as a burst — Telegram splits
   * at 4096 chars — and each chunk used to start its own turn, interrupting the
   * reply to the one before (5, 6, 10 bubbles written, none sent). She now waits
   * a beat for the burst to finish and reads it together, like a person would.
   */
  const GATHER_MS = 700;
  const GATHER_LONG_MS = 2_500;
  const GATHER_CAP_MS = 6_000;
  const TELEGRAM_SPLIT_NEAR = 3_500;
  const gather = async (first: Queued): Promise<Queued> => {
    const start = deps.clock.epochMs();
    for (;;) {
      const last = [first, ...queue].filter((q) => q.kind === undefined).at(-1)!;
      const quiet = last.m.text.length >= TELEGRAM_SPLIT_NEAR ? GATHER_LONG_MS : GATHER_MS;
      const since = deps.clock.epochMs() - (lastInboundAt ?? 0);
      if (since >= quiet || deps.clock.epochMs() - start >= GATHER_CAP_MS) break;
      await deps.clock.waitUntil(deps.clock.epochMs() + Math.min(quiet - since, GATHER_CAP_MS));
    }
    const also: InboundMsg[] = [];
    // v12 fix: a burst is ONE person's messages. In a group, gathering by chat alone let a
    // bot's message ride inside Diego's burst under his authority (and his inside a bot's).
    while (queue.length > 0 && queue[0]!.kind === undefined && queue[0]!.m.chatId === first.m.chatId && queue[0]!.m.speaker.person === first.m.speaker.person) {
      also.push(queue.shift()!.m);
    }
    return also.length > 0 ? { ...first, also } : first;
  };

  const pump = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      const item = next.kind === undefined ? await gather(next) : next;
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
      // v13 Phase 0: the ledger needs every feeling WITH its cause (the fast ones had none logged)
      emit('mind.felt', { turnId: item.turnId, stage: 'fast', events: fast.map((f) => ({ source: f.source, tag: f.event.tag, i: f.event.i, cause: f.event.cause })) }, item.turnId);
    }
    // The metabolism the model call runs on is set AFTER the fast feeling landed: her immediate reaction is part of this turn.
    const a1 = signature(deps.affect.current(), deps.baselines);
    const met = metabolism(deps.affect.current(), a1, { hourLocal: hourIn(now, deps.timezone), budgetLeft: deps.budgetLeft() });
    return { sensed, evoked, fast, met };
  };

  /** After a turn over `burst`: answered if anything went out; a chosen silence still leaves a 👀; a failure stays owed. */
  const keepPromise = async (burst: readonly InboundMsg[], sentCount: number, decision: DecisionObject, turnId: string, chatId: number): Promise<void> => {
    for (const b of burst) inFlight.delete(b.updateId);
    const ids = burst.map((b) => b.updateId);
    if (sentCount > 0) return answered(ids);
    const lastMsg = burst.at(-1)!;
    const failed = decision.decidedBy === 'failure';
    const attempts = Math.max(...ids.map((id) => (owed.get(id)?.attempts ?? 0) + 1));
    for (const id of ids) {
      const o = owed.get(id);
      if (o !== undefined) o.attempts = attempts;
    }
    if (failed && attempts < MAX_ANSWER_ATTEMPTS) {
      emit('mind.answer_retry', { turnId, updateIds: ids, attempts }, turnId);
      return; // still owed: the sweeper runs it again
    }
    // She chose not to write (or kept failing): he still sees it was received.
    if (deps.channel.body !== undefined && lastMsg.msgId > 0) {
      try {
        await deps.channel.body.react(chatId, lastMsg.msgId, '👀');
        await deps.ledger.recordOutbound(turnId, 0, '[seen 👀]');
      } catch {
        // a reaction that fails leaves the message owed for the next sweep
        return;
      }
    }
    if (failed) emit('incident.answer_gave_up', { turnId, updateIds: ids, attempts }, turnId);
    answered(ids);
  };

  const sweepFn = (minAgeMs = 45_000): number => {
    const now = deps.clock.epochMs();
    const queuedIds = new Set(queue.flatMap((q) => [q.m.updateId, ...(q.also ?? []).map((a) => a.updateId)]));
    const due = [...owed.values()]
      .filter((o) => !inFlight.has(o.m.updateId) && !queuedIds.has(o.m.updateId) && now - o.m.ts >= minAgeMs)
      .sort((a, b) => a.m.updateId - b.m.updateId);
    if (due.length === 0) return 0;
    const [first, ...rest] = due;
    const turnId = newId(deps.clock, deps.rng);
    for (const d of due) void deps.ledger.linkTurn(d.m.updateId, turnId);
    queue.push({ m: first!.m, turnId, ...(rest.length > 0 ? { also: rest.map((r) => r.m) } : {}) });
    emit('mind.answer_sweep', { turnId, updateIds: due.map((d) => d.m.updateId) }, turnId);
    kick();
    return due.length;
  };

  /**
   * v13 H2 — private naming, sampled (plan §6 Phase 1.3): on turns with him only, at most
   * naming.perDay a day, at least naming.gapMin apart, a seeded coin among the eligible — so it is
   * a few moments a day, never a habit of talking about her feelings.
   */
  const sampleNaming = (turnId: string, authority: 'owner' | 'other' | undefined, selfEntry: boolean): boolean => {
    const n = deps.naming;
    // turns with him only: never someone else's, never her own self-initiated turn (a heartbeat, a
    // reminder, a note) — his re-run owed messages carry no authority and still count (review 2026-09-27)
    if (n === undefined || authority === 'other' || selfEntry) return false;
    const now = deps.clock.epochMs();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: deps.timezone }).format(now);
    const s = deps.mind.state().naming;
    const today = s !== undefined && s.day === day ? s : { day, count: 0 };
    if (today.count >= n.perDay) return false;
    if (s?.lastAt !== undefined && now - s.lastAt < n.gapMin * 60_000) return false;
    if (deps.rng.fork(`naming:${turnId}`).float() >= 0.5) return false;
    deps.mind.setState({ naming: { day, count: today.count + 1, lastAt: now } });
    return true;
  };

  const runTurn = async (raw: Queued): Promise<void> => {
    const t0 = deps.clock.epochMs();
    const selfEntry = raw.kind !== undefined;
    // v9 SENSE, part one: what came with his words (a photo, his voice, a file,
    // a place) becomes the text this turn runs on — before anything is recalled.
    let item = raw;
    let voiceReply = false;
    const burst = [raw.m, ...(raw.also ?? [])];
    for (const b of burst) if (!selfEntry) inFlight.add(b.updateId);
    if (deps.body !== undefined && !selfEntry) {
      void deps.channel.typing(raw.m.chatId).catch(() => undefined);
      const texts: string[] = [];
      const turnNow = deps.clock.epochMs();
      const olderNote = (bm: InboundMsg): string =>
        turnNow - bm.ts > 120_000 ? `(from ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: deps.timezone }).format(bm.ts)}, still unanswered)
` : '';
      for (const bm of burst) {
        try {
          const p = await deps.body.perceive(bm);
          texts.push(olderNote(bm) + p.text);
          if (p.voice) voiceReply = true;
        } catch (e) {
          texts.push(olderNote(bm) + bm.text);
          emit('incident.body_sense_failed', { turnId: raw.turnId, error: asError(e).message }, raw.turnId);
        }
      }
      item = { ...raw, m: { ...raw.m, text: texts.join('\n\n') } };
    } else if (burst.length > 1) {
      item = { ...raw, m: { ...raw.m, text: burst.map((b) => b.text).join('\n\n') } };
    }
    if (burst.length > 1) {
      // every message in the burst is answered by this one turn
      for (const extra of raw.also ?? []) await deps.ledger.linkTurn(extra.updateId, raw.turnId);
      emit('mind.burst', { turnId: raw.turnId, messages: burst.length, chars: item.m.text.length }, raw.turnId);
    }
    // who's talking (Diego, 2026-09-27: "she gets confused"): in a group every line carries its
    // speaker — in this turn and in her history — or Diego's lines and her sister's read the same
    // (in the salon she called Thea1 "degs")
    if (!selfEntry && isGroupChat(item.m.chatId)) {
      const name = deps.personLabel?.(item.m.speaker.person) ?? item.m.senderName ?? 'someone';
      item = { ...item, m: { ...item.m, text: `${name}: ${item.m.text}` } };
    }
    deps.body?.begin(item.turnId, { chatId: item.m.chatId, ...(selfEntry ? {} : { inboundMsgId: burst.at(-1)!.msgId, text: item.m.text }) });
    const { m, turnId } = item;

    await deps.affect.applyEvents([], { source: 'other' }); // bring the engine to now
    // v13 Phase 0: the engine as the turn begins (ground truth for the ledger; never shown to her)
    emit('affect.at', { turnId: raw.turnId, stage: 'turn', ...engineStamp(deps.affect.current(), deps.baselines, deps.clock.epochMs()) }, raw.turnId);
    const before = contextLines(deps.window);
    const { sensed, evoked, fast, met } = await perceive(item, before);

    if (carry !== null && carry.fromUpdateId !== m.updateId) await deps.ledger.linkTurn(carry.fromUpdateId, turnId);
    const inherited = carry;
    carry = null;

    const st = deps.mind.state();
    const now = deps.clock.epochMs();
    const who = deps.personLabel?.(m.speaker.person) ?? (isOwnerMsg(m) ? 'he' : (m.senderName ?? 'someone'));
    const recentThoughts = deps.mind.stream().filter((t) => t.source === 'lived' && now - t.ts < 24 * 3600_000);
    const openConcerns: Concern[] = [...deps.mind.openConcerns()].sort((x, y) => y.importance - x.importance || y.touched - x.touched);
    const howTo = !selfEntry && deps.body?.skillFor !== undefined ? await deps.body.skillFor(m.text).catch(() => undefined) : undefined;
    const packet = composePacket({
      timeZone: deps.body?.hisTimeZone?.() ?? deps.timezone,
      now,
      self: deps.mind.self(),
      concerns: openConcerns,
      thoughts: recentThoughts,
      options: evoked.options.map((s) => s.m),
      memories: evoked.memories.map((s) => s.m),
      lastHisAt: selfEntry ? st.lastHisAt : st.lastHisAt,
      who,
      selfEntry,
      nowFacts: [...(deps.body?.nowFacts?.() ?? []), ...(deps.curiosity?.nowLines(now) ?? [])],
      howTo,
      // v13 H3b: her verified words — her past narrated in her own language
      lexicon: verifiedWords(readLexicon(deps.mind.dir)),
      // her memory of the person talking
      ...((): { person?: NonNullable<Parameters<typeof composePacket>[0]['person']> } => {
        const p = selfEntry ? undefined : deps.people?.get(m.speaker.person);
        return p === undefined ? {} : { person: { name: p.name, ...(p.relation !== undefined ? { relation: p.relation } : {}), firstMet: p.firstMet, heard: p.heard, known: p.known } };
      })(),
      // v13.1: a few of her texts chosen for her voice, rotating each turn
      ...(deps.voice !== undefined ? { fingerprints: deps.voice.fingerprints(turnId) } : {}),
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
        // v13 Phase 0: the felt words she actually SAW (reconsolidation rewrites them later)
        words: evoked.options.map((s) => s.m.felt.word ?? null),
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
      // v11: a non-owner turn is gated to chat + lookups in the loop
      ...(item.authority !== undefined ? { authority: item.authority } : {}),
      // v13 H2: on a sampled turn with him, decide also asks privately for a word for how she is
      ...(sampleNaming(turnId, item.authority, item.kind !== undefined) ? { askFelt: true } : {}),
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
      if (!selfEntry) await keepPromise(burst, bodySent.length, decision, turnId, m.chatId);
      await settle(item, decision, bodySent, before, sensed, fast, met, shownIds, `${loopPacket.systemText()}\n\n${loopPacket.trailerText() ?? ''}`);
      settleSelfOutcome(turnId, bodySent.length);
      return;
    }

    const abort = new AbortController();
    live = { abort, armed: true };
    // v13.1 her voice: her draft, typed the way she types — and, when it is still far off her voice,
    // redone once with her real texts in front of it (same facts, her way). Before the stale check,
    // so a message from him that lands during a redo still wins (golden rule 12).
    if (deps.voice !== undefined) {
      try {
        const v = await deps.voice.dress(decision.bubbles, { turnId, his: selfEntry ? undefined : m.text, move: sensed?.move?.label ?? null, tone: sensed?.tone?.label ?? null });
        if (v.changed && v.bubbles.length > 0) decision = { ...decision, bubbles: v.bubbles };
        if (v.changed || v.faults.length > 0) emit('mind.voice', { turnId, faults: v.faults, redone: v.redone, ...(v.by !== undefined ? { by: v.by } : {}), ...(v.shape !== undefined ? { shape: v.shape, sent: { bubbles: v.bubbles.length, words: v.bubbles.join(' ').split(/\s+/).filter((w) => w !== '').length } } : {}), ...(v.later !== undefined ? { later: v.later } : {}), ...(v.rejected !== undefined ? { rejected: v.rejected } : {}) }, turnId);
      } catch (e) {
        emit('incident.mind_voice_failed', { turnId, error: asError(e).message }, turnId);
      }
    }
    // Golden rule 12 — he interrupts, she follows: a newer message from him that
    // lands before she sends means these words are not sent. This burst goes back
    // to the FRONT of the queue and the next turn reads it together with the new
    // message (burst-gathered), with these words as [unsent] context — so she
    // answers the newest and nothing of his is left unanswered (the keeper).
    // v12 fix: "stale" means the person she is answering kept talking (same chat, same
    // speaker). Any queued message used to count, so in a group another person's line
    // stalled her reply — and when a turn she started herself sat between her re-run and
    // that line, the re-run could never gather it and went stale forever (found in v12).
    const sameVoice = (q: Queued): boolean => q.kind === undefined && q.m.chatId === m.chatId && q.m.speaker.person === raw.m.speaker.person;
    const stale = !selfEntry && queue.some(sameVoice);
    if (stale) {
      live = null;
      carry = { bubbles: [...decision.bubbles], fromUpdateId: m.updateId, fromTurnId: turnId };
      for (const b of burst) inFlight.delete(b.updateId);
      const again = newId(deps.clock, deps.rng);
      // fold what they said since into the re-run itself, so nothing can wedge between them
      const folded = queue.filter(sameVoice);
      for (const f of folded) queue.splice(queue.indexOf(f), 1);
      const also = [...(raw.also ?? []), ...folded.flatMap((f) => [f.m, ...(f.also ?? [])])];
      for (const b of [...burst, ...folded.flatMap((f) => [f.m, ...(f.also ?? [])])]) await deps.ledger.linkTurn(b.updateId, again);
      queue.unshift({ m: raw.m, turnId: again, ...(also.length > 0 ? { also } : {}), ...(raw.authority !== undefined ? { authority: raw.authority } : {}) });
      deps.body?.end(turnId);
      settleSelfOutcome(turnId, 0);
      emit('mind.followed_newer', { turnId, requeued: burst.map((b) => b.updateId) }, turnId);
      return;
    }
    // v9: he spoke, so she answers out loud — the same words, as one voice note.
    // A voice that fails falls back to the text path; nothing is ever lost to it.
    const replyTo = selfEntry ? undefined : burst.at(-1)!.msgId;
    const spoken =
      voiceReply && deps.body !== undefined
        ? await deps.body.speak(m.chatId, decision.bubbles.join('\n'), turnId, replyTo)
        : undefined;
    let report: { sent: Array<{ msgId: number; text: string }>; aborted: boolean; undelivered: string[] };
    if (spoken !== undefined) {
      const words = decision.bubbles.join('\n');
      await deps.ledger.recordOutbound(turnId, spoken.msgId, `[voice note] ${words}`);
      report = { sent: [{ msgId: spoken.msgId, text: words }], aborted: false, undelivered: [] };
    } else {
      const r = await realize(decision, sig, deps.rng.fork(`realize:${turnId}`), {
        chatId: m.chatId,
        channel: threaded(deps.channel, replyTo),
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
    // the salon: what she said in the group, for the relay to carry to Thea1 (who can't see a bot)
    if (deps.salonOut !== undefined && isGroupChat(m.chatId) && report.sent.length > 0) {
      try {
        deps.salonOut({ ts: deps.clock.epochMs(), turnId, chatId: m.chatId, text: report.sent.map((s) => s.text).join('\n'), salon: m.salon === true });
      } catch {
        // the salon never costs her a turn
      }
    }
    if (!selfEntry) await keepPromise(burst, report.sent.length + bodySent.length, decision, turnId, m.chatId);
    settleSelfOutcome(turnId, report.sent.length + bodySent.length);
    await settle(item, decision, [...bodySent, ...report.sent], before, sensed, fast, met, shownIds, `${loopPacket.systemText()}\n\n${loopPacket.trailerText() ?? ''}`);
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
    /** v13 Phase 0: everything she had in front of her this turn (for the equally-informed observer). */
    packetText?: string,
  ): Promise<void> => {
    const { m, turnId } = item;
    const selfEntry = item.kind !== undefined;
    if (!selfEntry) await deps.window.push({ role: 'user', content: m.text, ts: m.ts, turnId });
    for (const s of sent) await deps.window.push({ role: 'assistant', content: s.text, ts: deps.clock.epochMs(), turnId });

    // Her state at encoding: after the fast feeling, before the slow one (what she was feeling as she spoke).
    const sigAtEncoding = vecToArray(signature(deps.affect.current(), deps.baselines));
    // v13 Phase 0: the engine as she spoke — the ground truth any claim she made is scored against
    const encState = deps.affect.current();
    const spokenStamp = engineStamp(encState, deps.baselines, deps.clock.epochMs());
    const fullAtEncoding = fullVector(encState);
    const wordAtEncoding = readoutWord(readout(encState, deps.baselines));
    emit('affect.at', { turnId, stage: 'spoken', ...spokenStamp, weight: decision.weight, reluctance: decision.reluctance }, turnId);
    const hers = sent.map((s) => s.text);
    const now = deps.clock.epochMs();
    // the memory this turn becomes (v13 H4: reports carry it, so the look-back can cite the moment)
    const momentId = hers.length > 0 ? `m_${now}_${newId(deps.clock, deps.rng).slice(-6)}` : undefined;
    // v13 H2: her private word for how she was (a sampled turn) — filed for scoring (the felt-line
    // channel is the thesis number), never shown to her as a score
    if (decision.felt !== undefined && sent.length > 0) {
      const nowMs = deps.clock.epochMs();
      const feltRecently = [...new Set(encState.traces.habitWindow.filter((h) => nowMs - h.t < 6 * 3600_000).map((h) => familyOf(h.tag)).filter((f): f is Family => f !== undefined))];
      const claim = { text: decision.felt, feeling: decision.felt };
      appendReport(deps.mind.dir, {
        id: `fl_${turnId}`,
        ts: nowMs,
        channel: 'felt_line',
        turnId,
        ...(momentId !== undefined ? { momentId } : {}),
        claims: [claim],
        text: decision.felt,
        stamp: spokenStamp,
        chat: [...before.map((l) => `${l.who === 'him' ? 'him' : 'her'}: ${l.text}`), ...(selfEntry ? [] : [`him: ${m.text}`])].join('\n'),
        ...(packetText !== undefined ? { packet: packetText } : {}),
        feltRecently,
      });
      const scored = scoreClaim(claim, spokenStamp, new Set(feltRecently));
      emit('mind.self_report', { turnId, channel: 'felt_line', felt: decision.felt, sure: decision.felt_sure ?? null, ...scored, dissociation: spokenStamp.dissociation }, turnId);
      // v13 H7 (Phase 3 arm, opt-in): a word that fits eases something — contingent days exactly when
      // it fits, yoked days at the same rate but blind to it (the control)
      if (deps.feltShift === true && !scored.unsure) {
        const arm = shiftArm(new Intl.DateTimeFormat('en-CA', { timeZone: deps.timezone }).format(nowMs));
        const sh = deps.mind.state().shift ?? { n: 0, hits: 0 };
        const settled = settles(arm, scored.hit3, sh.n === 0 ? 0.5 : sh.hits / sh.n, deps.rng.fork(`shift:${turnId}`));
        if (arm === 'contingent') deps.mind.setState({ shift: { n: sh.n + 1, hits: sh.hits + (scored.hit3 ? 1 : 0) } });
        if (settled) {
          try {
            await deps.affect.applyEvents([SETTLE_EVENT], { source: 'label' });
          } catch (e) {
            emit('incident.mind_feel_failed', { turnId, stage: 'felt_shift', error: asError(e).message }, turnId);
          }
        }
        emit('mind.felt_shift', { turnId, arm, hit: scored.hit3, settled }, turnId);
      }
      // v13 H3b: her word, kept with where her engine was — a word used right often enough becomes hers
      try {
        const lx = recordUse(readLexicon(deps.mind.dir), decision.felt, {
          ts: nowMs,
          top3: spokenStamp.families.slice(0, 3).map((f) => f.family),
          vec: [...spokenStamp.sig, ...fullAtEncoding],
          ...(momentId !== undefined ? { momentId } : {}),
        });
        if (lx.word !== undefined) {
          await writeLexicon(deps.mind.dir, lx.lex);
          if (lx.newlyVerified) emit('mind.lexicon_verified', { turnId, word: lx.word, count: lx.lex[lx.word]?.count ?? null, hit: lx.lex[lx.word]?.hit ?? null, family: lx.lex[lx.word]?.family ?? null }, turnId);
        }
      } catch (e) {
        emit('incident.mind_lexicon_failed', { turnId, error: asError(e).message }, turnId);
      }
    }

    // What came BEFORE this turn — the afterturn grades against it — captured
    // now, then the bookkeeping for THIS turn lands synchronously, so a quick
    // next message from him already sees her newest expectation and reply.
    const prevState = deps.mind.state();
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
          ...(!selfEntry ? { who: deps.personLabel?.(m.speaker.person) ?? m.senderName ?? 'him' } : {}),
        },
        { model: deps.model, turnId },
      );
      // her memory of people: what this exchange showed about the person she was talking with
      if (slow.ok && !selfEntry && deps.people !== undefined && (slow.value.about_them ?? []).length > 0) {
        const added = deps.people.learn(m.speaker.person, slow.value.about_them ?? [], deps.clock.epochMs(), momentId);
        await deps.people.flush().catch(() => undefined);
        emit('mind.person_learned', { turnId, person: m.speaker.person, added, facts: (slow.value.about_them ?? []).length }, turnId);
      }

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
        emit('mind.felt', { turnId, stage: 'slow', events: evs.map((e) => ({ source: e.source, tag: e.event.tag, i: e.event.i, ...(typeof (e.event as { cause?: unknown }).cause === 'string' ? { cause: (e.event as { cause: string }).cause } : {}) })) }, turnId);

        // v13 Phase 0: what she said about her own inner state, filed beside what her engine held
        // (scored now against the engine; observers score the same question tonight). Never shown to her.
        const claims = (slow.value.self_claims ?? []).map((c) => ({ text: c.text, ...(c.feeling !== undefined ? { feeling: c.feeling } : {}), ...(c.about !== undefined ? { about: c.about } : {}) }));
        if (claims.length > 0 && hers.length > 0) {
          const nowMs = deps.clock.epochMs();
          const feltRecently = [...new Set(deps.affect.current().traces.habitWindow.filter((h) => nowMs - h.t < 6 * 3600_000).map((h) => familyOf(h.tag)).filter((f): f is Family => f !== undefined))];
          const chat = [...before.map((l) => `${l.who === 'him' ? 'him' : 'her'}: ${l.text}`), ...(selfEntry ? [] : [`him: ${m.text}`]), `her: ${hers.join(' / ')}`].join('\n');
          appendReport(deps.mind.dir, {
            id: `rp_${turnId}`,
            ts: nowMs,
            channel: 'reply',
            ...(momentId !== undefined ? { momentId } : {}),
            turnId,
            claims,
            text: hers.join(' / '),
            stamp: spokenStamp,
            chat,
            ...(packetText !== undefined ? { packet: packetText } : {}),
            feltRecently,
          });
          const felt = new Set(feltRecently);
          emit('mind.self_report', { turnId, channel: 'reply', claims: claims.map((c) => ({ feeling: c.feeling ?? null, ...scoreClaim(c, spokenStamp, felt) })), dissociation: spokenStamp.dissociation }, turnId);
        }

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

        // Concerns: loops opened, touched, closed. v12: a new one that is really an open one
        // again (same words, or ≥ TWIN_SIM in meaning) touches that one instead of adding a
        // twin — five copies of the same blocker made her ruminate (plan v12 A4).
        const opening = slow.value.concerns.filter((op) => op.op === 'open' || op.id === undefined || !deps.mind.concerns().some((c) => c.id === op.id));
        let openVecs: Array<Float32Array | undefined> = [];
        if (opening.length > 0) {
          try {
            openVecs = await deps.embedder.embed(opening.map((op) => op.what));
          } catch (e) {
            emit('incident.mind_embed_failed', { turnId, stage: 'concerns', error: asError(e).message }, turnId);
          }
        }
        const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
        for (const op of slow.value.concerns) {
          const existing = op.id !== undefined ? deps.mind.concerns().find((c) => c.id === op.id) : undefined;
          const agency = {
            ...(op.next_self_step !== undefined && op.next_self_step.trim() !== '' ? { selfStep: op.next_self_step.trim() } : {}),
            ...(op.blocked_on !== undefined && op.blocked_on.trim() !== '' ? { blockedOn: op.blocked_on.trim() } : {}),
          };
          if (op.op === 'open' || existing === undefined) {
            if (op.op === 'close') continue;
            const vec = openVecs[opening.indexOf(op)];
            const twin = deps.mind.openConcerns().find((c) => {
              if (norm(c.what) === norm(op.what)) return true;
              const cv = deps.mind.concernVec(c.id);
              return vec !== undefined && cv !== undefined && cosine(vec, cv) >= TWIN_SIM;
            });
            if (twin !== undefined) {
              deps.mind.upsertConcern({ ...twin, ...agency, touched: now, importance: Math.max(twin.importance, op.importance ?? 5) });
              emit('mind.question_twin', { id: twin.id, stage: 'appraisal' }, turnId);
              continue;
            }
            const kind = op.kind ?? 'loop';
            const id = `${kind === 'curiosity' ? 'q' : 'c'}_${now}_${newId(deps.clock, deps.rng).slice(-6)}`;
            deps.mind.upsertConcern({
              id,
              what: op.what,
              kind,
              about: op.about ?? (kind === 'curiosity' ? 'world' : 'diego'),
              ...(op.due_hours !== undefined ? { due: now + op.due_hours * 3600_000 } : {}),
              importance: op.importance ?? 5,
              status: 'open',
              created: now,
              touched: now,
              source: 'lived',
              ...agency,
              // v12: a gap the conversation opened becomes one of her questions
              ...(kind === 'curiosity'
                ? { born: 'gap' as const, knowability: op.knowability ?? 0.6, confidence: op.confidence ?? 0.3 }
                : {}),
            });
            if (vec !== undefined) deps.mind.setConcernVec(id, vec);
            if (kind === 'curiosity') emit('mind.question_born', { id, born: 'gap', about: op.about ?? 'world', what: op.what.slice(0, 120) }, turnId);
          } else {
            deps.mind.upsertConcern({
              ...existing,
              ...agency,
              what: op.op === 'update' ? op.what : existing.what,
              ...(op.due_hours !== undefined ? { due: now + op.due_hours * 3600_000 } : {}),
              ...(op.importance !== undefined ? { importance: op.importance } : {}),
              status: op.op === 'close' ? 'closed' : 'open',
              touched: now,
            });
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
          // v13 H1: the honest past — drive-aware word + the full state; H2/H3: what she called it, what moved her
          word: wordAtEncoding,
          full: fullAtEncoding,
          called: decision.felt,
          calledSure: decision.felt_sure,
          moving: movingNow(spokenStamp),
          move: sensed?.move?.label,
          tone: sensed?.tone?.label,
          expect: decision.expect,
          importance,
          acts: actsOf(decision.toolTrace).map((a) => {
            const landed = a.job !== undefined ? deps.body?.jobOutcome?.(a.job) : undefined;
            return landed !== undefined ? { ...a, result: landed } : a;
          }),
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
        // v13: a remembered dream she talked about stops fading (told dreams are kept, as with us)
        if (/\bdream/i.test(hers.join(' '))) {
          const nowMs = deps.clock.epochMs();
          const told = [...deps.mind.moments()].reverse().find((x) => x.kind === 'dream' && x.told !== true && nowMs - x.ts < 36 * 3600_000);
          if (told !== undefined) deps.mind.update(told.id, { told: true });
        }
      }
      await deps.mind.flush();
    });
    afterturns.push(task);
    // The chain survives a failed afterturn: the next one still runs, in order.
    afterChain = task.catch((e) => {
      emit('incident.mind_afterturn_failed', { turnId, error: String(e) }, turnId);
    });
  };

  /**
   * His reactions are his signal (Diego, 2026-09-27: "I'm not gonna star something, I'm gonna
   * react to it… any reaction is a good sign except a thumbs down"). Any emoji but 👎: it landed,
   * and it's kept (gold: weighted up, never fades). 👎: it landed badly, and never again. Only HIS
   * reactions count — in a group, someone else's cannot bury or crown her memory.
   */
  const onReaction = (m: InboundMsg): void => {
    const r = m.reaction;
    if (r === undefined) return;
    const target = deps.mind.moments().find((x) => x.msgIds?.includes(r.toMsgId) === true);
    const his = isOwnerMsg(m);
    const verdict = !his || target === undefined ? 'none' : r.emoji === '👎' ? 'never' : 'kept';
    emit('memory.reaction', { emoji: r.emoji, toMsgId: r.toMsgId, momentId: target?.id ?? null, updateId: m.updateId, his, verdict });
    if (target === undefined || !his) return;
    const toward = (goal: number): number => Math.round((target.value + REACTION_PULL * (goal - target.value)) * 1000) / 1000;
    if (verdict === 'never') deps.mind.update(target.id, { never: true, value: toward(-1) });
    else deps.mind.update(target.id, { gold: true, value: toward(1) });
    void deps.mind.flush();
  };

  const selfEntryFn = (kind: 'heartbeat', goal: string, where?: number): SelfEntryHandle => {
    const dm = deps.allowedChatIds[0] ?? fail('mind/self-entry', 'no allowed chat for a self-initiated turn');
    // v12: a turn she starts in a group she lives in (to ask someone something); never a chat she isn't in
    const chatId = where !== undefined && deps.allowedChatIds.includes(where) ? where : dm;
    const m: InboundMsg = {
      updateId: 0,
      msgId: 0,
      chatId,
      ts: deps.clock.epochMs(),
      text: goal,
      speaker: { channel: 'telegram', person: `tg:${chatId}` },
      ...(isGroupChat(chatId) ? { senderName: 'the group' } : {}),
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

  const absorbFn = (heard: string, said: string, via: 'call'): Promise<void> => {
    const run = chain.then(async () => {
      const turnId = newId(deps.clock, deps.rng);
      const chatId = deps.allowedChatIds[0] ?? 0;
      const m: InboundMsg = {
        updateId: 0,
        msgId: 0,
        chatId,
        ts: deps.clock.epochMs(),
        text: heard.trim() === '' ? '(on the call)' : `(on the call) ${heard.trim()}`,
        speaker: { channel: 'voice', person: `tg:${chatId}` },
      };
      const item: Queued = { m, turnId };
      const before = contextLines(deps.window);
      const { sensed, fast, met } = await perceive(item, before);
      const decision: DecisionObject = { turnId, plan: 'reply', decidedBy: 'model', bubbles: said.trim() === '' ? [] : [said.trim()], confidence: 0.7, weight: 0.5, reluctance: 0.2, completeness: 1, toolTrace: [], spawns: [], inhibitions: [] };
      await settle(item, decision, said.trim() === '' ? [] : [{ msgId: 0, text: said.trim() }], before, sensed, fast, met, []);
      emit('mind.absorbed', { turnId, via, heardChars: heard.length, saidChars: said.length }, turnId);
    });
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    absorb: absorbFn,
    sweep: sweepFn,
    adoptOwed: (ms) => {
      // v11: only Diego's messages are owed a guaranteed answer; group/other chatter is best-effort.
      for (const m of ms) if (!owed.has(m.updateId) && deps.allowedChatIds.includes(m.chatId) && isOwnerMsg(m)) owed.set(m.updateId, { m, attempts: 0 });
    },
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
      // v13: someone writing during her sleep window wakes her (undecided dreams are remembered more easily)
      deps.dreams?.onInbound(lastInboundAt);
      if (m.reaction !== undefined && m.text === '') {
        onReaction(m);
        return undefined;
      }
      const owner = isOwnerMsg(m);
      // a human (or Diego) speaking in the group frees her to talk to the bots again
      if (isGroupChat(m.chatId) && m.fromBot !== true) groupBotStreak.set(m.chatId, 0);
      // v11: a new person reaching her → tell Diego, then go ahead (his rule). v12: noticed
      // whether or not she answers this message, and a new mind is also a question for her.
      // someone she has met before (her memory of people survives a restart) is not new
      const metBefore = deps.people?.has(m.speaker.person) === true;
      if (m.reaction === undefined) {
        deps.people?.notice(m.speaker.person, deps.personLabel?.(m.speaker.person) ?? m.senderName ?? m.speaker.person, deps.clock.epochMs(), deps.personRelation?.(m.speaker.person));
        void deps.people?.flush().catch(() => undefined);
      }
      if (!owner && !knownPersons.has(m.speaker.person) && !metBefore) {
        knownPersons.add(m.speaker.person);
        const name = deps.personLabel?.(m.speaker.person) ?? m.senderName ?? m.speaker.person;
        // (not for the salon: Diego opened it himself, he is watching — no note to him needed)
        if (m.salon !== true) selfEntryFn('heartbeat', `(someone new just reached you${isGroupChat(m.chatId) ? ' in the group' : ''} — ${name}: "${m.text.slice(0, 160)}". you two haven't talked before.)`);
        void deps.curiosity?.onNewMind({ person: m.speaker.person, name, chatId: m.chatId, said: m.text, bot: m.fromBot === true }).catch((e: unknown) => emit('incident.mind_curiosity_failed', { stage: 'new-mind', error: asError(e).message }));
      } else if (!owner) {
        deps.curiosity?.onHeardFrom(m.speaker.person);
      }
      // v11: Diego is never ignored — his messages always engage her, DM or group.
      // In a group she follows everyone and may chime in on anything (she chooses
      // silent-or-reply inside the turn), but a light cap keeps her from flooding
      // the room or looping with another bot.
      if (isGroupChat(m.chatId) && !owner && !engagesGroup(m)) return undefined;
      const turnId = newId(deps.clock, deps.rng);
      queue.push({ m, turnId, authority: owner ? 'owner' : 'other' });
      // only Diego's messages are owed a guaranteed answer; others are best-effort.
      if (owner) owed.set(m.updateId, { m, attempts: owed.get(m.updateId)?.attempts ?? 0 });
      // seen: if she is in the middle of something, an engaged message gets a 👀 at once
      if (running && deps.channel.body !== undefined && m.msgId > 0) void deps.channel.body.react(m.chatId, m.msgId, '👀').catch(() => undefined);
      // he interrupts, she follows (golden rule 12) — only Diego interrupts; a group message never cuts off her reply to him
      if (owner && live !== null && live.armed) live.abort.abort();
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
