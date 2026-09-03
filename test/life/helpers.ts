// test/life — shared fixtures. Three deliberate choices:
//   * Every model script here answers through the rung the real call would take:
//     the heartbeat thought goes out with a schema and no tools, and — since
//     P-PONDER PO.1 — so does every ponder committee node (the node schema rides
//     the request, M13 no longer hand-parses), so the ladder picks rung (b) in
//     both cases and the scripts answer through the forced `emit` tool call.
//   * The event log is an in-memory recording double: the life events' payloads and
//     ORDER are what the suites pin, not file bytes (M02's own suite owns the file).
//   * Affect state comes from the real `initialAffectState` with drives overridden,
//     so the drive terms in the scorer and the context block are real shape, not
//     ad-hoc objects that would drift from M05.

import { TestClock } from '../../src/kernel/clock.js';
import { initialAffectState, type AffectState, type Drive } from '../../src/affect/index.js';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import type { Episode } from '../../src/memory/index.js';
import { MockModel, type Responder } from '../../src/model/mock.js';
import type { CommitteeEnv, LoopPacket, LoopQuery } from '../../src/loop/index.js';
import type { HeartbeatThoughtContext, HeartbeatThoughtDeps } from '../../src/life/thought.js';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** A fixed "today": 2026-08-30T10:00:00Z-ish; every fixture ts is relative to this. */
export const T0 = 1_700_000_000_000;
export const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Recording event log — keeps every row in emit order
// ---------------------------------------------------------------------------

export interface RecordingLog extends EventLog {
  rows: EventEnvelope[];
  kinds: () => string[];
  of: (kind: string) => EventEnvelope[];
}

export const recordingLog = (seed: ReadonlyArray<Omit<EventEnvelope, 'seq'>> = []): RecordingLog => {
  const rows: EventEnvelope[] = seed.map((e, i) => ({ ...e, seq: i + 1 }));
  return {
    rows,
    kinds: () => rows.map((r) => r.kind),
    of: (kind) => rows.filter((r) => r.kind === kind),
    emit: async (kind, payload, turnId) => {
      rows.push({
        seq: rows.length + 1,
        ts: T0,
        kind,
        ...(turnId !== undefined ? { turnId } : {}),
        payload,
      });
    },
    async *replay(filter): AsyncGenerator<EventEnvelope> {
      for (const r of rows) {
        if (filter?.kinds !== undefined && !filter.kinds.includes(r.kind)) continue;
        if (filter?.sinceTs !== undefined && r.ts < filter.sinceTs) continue;
        yield r;
      }
    },
  };
};

/** A log whose emit always throws — the "L0 unwritable" branch of every incident path. */
export const deadLog = (): EventLog => ({
  emit: async () => {
    throw new Error('L0 unwritable');
  },
  async *replay(): AsyncGenerator<EventEnvelope> {},
});

// ---------------------------------------------------------------------------
// Affect fixtures
// ---------------------------------------------------------------------------

export const drives = (over: Partial<Record<Drive, number>> = {}): Record<Drive, number> => ({
  novelty: 0,
  connection: 0,
  mastery: 0,
  ...over,
});

/** The real resting state, with drives (and optionally arousal) overridden. */
export const affectState = (over: {
  drives?: Partial<Record<Drive, number>>;
  arousal?: number;
  t?: number;
} = {}): AffectState => {
  const s = initialAffectState(over.t ?? T0);
  for (const [k, v] of Object.entries(over.drives ?? {})) s.drives[k as Drive] = v as number;
  if (over.arousal !== undefined) s.dials.arousal = over.arousal;
  return s;
};

// ---------------------------------------------------------------------------
// Episode fixtures — the `Pick<Episode, 'summary' | 'importance' | 'ts'>` slices
// the life prompts render. Newest first, as every prompt asks for.
// ---------------------------------------------------------------------------

export type RecentEpisode = Pick<Episode, 'summary' | 'importance' | 'ts'>;

export const recentEpisodes = (): RecentEpisode[] => [
  { summary: 'he told me the crates shipped this morning', importance: 8, ts: T0 - HOUR },
  { summary: 'I rewrote the scheduler slot math and it finally held', importance: 6, ts: T0 - 2 * HOUR },
  { summary: 'quiet afternoon, I reread my own diary and cringed', importance: 3, ts: T0 - 5 * HOUR },
];

// ---------------------------------------------------------------------------
// The heartbeat thought — context, scripts, deps
// ---------------------------------------------------------------------------

export const thoughtCtx = (over: Partial<HeartbeatThoughtContext> = {}): HeartbeatThoughtContext => ({
  nowH: 14.5,
  silenceH: 3,
  sentToday: 0,
  unanswered: 0,
  weather: 'warm, restless, a little lonely',
  drives: drives({ novelty: 0.25, connection: 0.34, mastery: 0.25 }),
  recent: recentEpisodes(),
  dueThreads: [{ id: 'thread_crates', note: 'he said he would report back on the crates' }],
  ...over,
});

export interface ThoughtScript {
  thought?: string;
  reason?: string;
  kind?: string;
  thread_id?: string | null;
  scores?: Partial<Record<'relevance' | 'information_gap' | 'expected_impact' | 'urgency' | 'coherence', number>>;
}

/** A valid heartbeat-thought reply, as the args of the forced `emit` call (rung b). */
export const thoughtJson = (over: ThoughtScript = {}): string =>
  JSON.stringify({
    thought: over.thought ?? 'the crates shipped and he never said how they landed; ask.',
    reason: over.reason ?? 'a due follow-up on his own promise',
    kind: over.kind ?? 'followup',
    thread_id: over.thread_id !== undefined ? over.thread_id : 'thread_crates',
    scores: {
      relevance: 4,
      information_gap: 4,
      expected_impact: 4,
      urgency: 4,
      coherence: 4,
      ...over.scores,
    },
  });

export const thoughtResponder = (over: ThoughtScript = {}): Responder => () => ({
  // Rung (b): the forced `emit` tool call is the channel for the payload.
  toolCalls: [{ name: 'emit', args: JSON.parse(thoughtJson(over)) as Record<string, unknown> }],
});

export const thoughtDeps = (model: MockModel, events: EventLog): HeartbeatThoughtDeps => ({
  model,
  events,
  maxTokens: 400,
  temperature: 0.7,
  tier: 'cheap',
});

export const thoughtModel = (over: { responder?: Responder; clock?: TestClock } = {}): MockModel => {
  const m = new MockModel({ clock: over.clock ?? new TestClock(T0) });
  m.onTask('heartbeat-thought', over.responder ?? thoughtResponder());
  return m;
};

// ---------------------------------------------------------------------------
// The ponder committee — env + node scripts
// ---------------------------------------------------------------------------

const stubPacket = (character: boolean, procedural: boolean): LoopPacket => ({
  systemText: () => (character ? 'IDENTITY: you are Thea.' : 'WORKER: fresh context, no identity.'),
  proceduralText: () => (procedural ? '[PROCEDURAL] answer in one line.' : null),
  trailerText: () => '[INHIBITION] never leak machinery.',
});

/** A CommitteeEnv for the ponder spec — plan 'silent' shape, main tier, no tools. */
export const committeeEnv = (model: MockModel, over: Partial<CommitteeEnv> = {}): CommitteeEnv => ({
  name: 'ponder',
  model,
  packet: stubPacket(true, true),
  query: { text: 'ponder', channels: { character: true, procedural: true } } satisfies LoopQuery,
  affect: new Float64Array(12),
  turnId: 'turn_ponder_1',
  signal: new AbortController().signal,
  maxTokens: 500,
  temperature: 0.6,
  tier: 'main',
  ...over,
});

export interface NodeScripts {
  seed?: { thought: string; about: string; topic: string; uncertainty: string; saliency: number };
  ground?: { grounded: boolean; source: string; evidence: string; cites: string[] };
  revise?: { changed: boolean; defect: string; revised_thought: string };
  artifact?: Record<string, unknown>;
}

export const seedScript = (over: Partial<NonNullable<NodeScripts['seed']>> = {}): NonNullable<NodeScripts['seed']> => ({
  thought: 'why does the slot math only fail when the week has 53 Thursdays',
  about: over.about ?? 'world',
  topic: 'slot math',
  uncertainty: 'whether the calendar or the cadence is at fault',
  saliency: 0.7,
  ...over,
});

export const groundScript = (over: Partial<NonNullable<NodeScripts['ground']>> = {}): NonNullable<NodeScripts['ground']> => ({
  grounded: true,
  source: 'web_search',
  evidence: 'ISO 8601 week 53 occurs only in long years',
  cites: ['https://example.com/iso8601'],
  ...over,
});

export const reviseScript = (over: Partial<NonNullable<NodeScripts['revise']>> = {}): NonNullable<NodeScripts['revise']> => ({
  changed: false,
  defect: 'none',
  revised_thought: 'why does the slot math only fail when the week has 53 Thursdays',
  ...over,
});

export const artifactScript = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  about: 'world',
  topic: 'slot math',
  conclusion: 'the cadence, not the calendar, is what drifts; the horizon is the bug.',
  artifact: 'insight',
  next: 'check the horizon constant against a long-year fixture',
  saliency: 0.7,
  resolved: true,
  changed: false,
  defect: 'none',
  ...over,
});

/** A node reply on rung (b): the payload rides the forced `emit` tool call. */
const emitNode = (args: Record<string, unknown>) => ({
  toolCalls: [{ name: 'emit', args }],
});

/** Scripts all four nodes with valid JSON through the ladder's emit rung, in committee execution order. */
export const ponderModel = (scripts: NodeScripts = {}): MockModel => {
  const m = new MockModel({ clock: new TestClock(T0) });
  m.enqueue(emitNode(seedScript(scripts.seed) as unknown as Record<string, unknown>));
  m.enqueue(emitNode(groundScript(scripts.ground) as unknown as Record<string, unknown>));
  m.enqueue(emitNode(reviseScript(scripts.revise) as unknown as Record<string, unknown>));
  m.enqueue(emitNode(artifactScript(scripts.artifact)));
  return m;
};
