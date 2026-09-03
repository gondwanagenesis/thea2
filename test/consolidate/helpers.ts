// test/consolidate — shared fixtures. Two deliberate choices:
//   * The episode store is an in-memory double with EXPLICIT vectors, so
//     clustering is controlled by construction instead of by whatever a real
//     embedder does to a summary string. The file-backed store has its own
//     suite (test/memory); the run only consumes the EpisodeStore contract.
//   * The corpus is a REAL buildIndex over real file bytes — gravity's seed
//     membership and dimension resolution must go through the same parser the
//     production corpus does.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AFFECT_DIMS } from '../../schemas/exemplar.js';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';
import { buildIndex, type CorpusIndex } from '../../src/corpus/corpus-index.js';
import { analyzeFile } from '../../src/corpus/parse.js';
import type { CorpusFile } from '../../src/corpus/types.js';
import type { Exemplar } from '../../schemas/exemplar.js';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import type { Episode, EpisodeStore } from '../../src/memory/index.js';
import { MockModel, type Responder, type ScriptedResponse } from '../../src/model/mock.js';
import {
  PACKET_RECORD_KIND,
  nightlyConfig,
  type ConsolidateConfig,
  type ConsolidateDeps,
  type PacketSlotView,
  type SlotTier,
} from '../../src/consolidate/index.js';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** A fixed "today": every fixture timestamp is expressed relative to this. */
export const T0 = 1_700_000_000_000;
export const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Dirs
// ---------------------------------------------------------------------------

export const tmpDir = (label: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), `thea2-consolidate-${label}-`));

export const rmDir = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true });

/**
 * Runs `fn`, returns the thrown error's namespaced `code` (or a sentinel).
 * Asserting on `.code` (not the message) is what pins one-code-per-failure-mode.
 */
export const errorCodeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : `no-code: ${(e as Error).message}`;
  }
  return 'did-not-throw';
};

/** The async twin, for rejections from promise-returning calls. */
export const errorCodeOfAsync = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : `no-code: ${(e as Error).message}`;
  }
  return 'did-not-throw';
};

/**
 * Parses a file the run wrote, through the real lived schema. Throws if the run
 * ever wrote a file the corpus would reject — tests fail HERE, not on a
 * downstream read of a broken frontmatter field.
 */
export const analyzeWritten = (raw: string, name: string): Exemplar => {
  const analysis = analyzeFile({ path: `var/lived/${name}`, raw }, 'lived');
  if (analysis.exemplar === undefined) {
    const first = analysis.issues[0];
    throw new Error(`fixture file '${name}' does not parse: ${first?.code} ${first?.message ?? ''}`);
  }
  return analysis.exemplar;
};

/** Every file in a tree as name -> bytes, for byte-level snapshot equality. */
export const snapshot = (root: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push([path.relative(root, full).replaceAll('\\', '/'), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(root);
  return out;
};

// ---------------------------------------------------------------------------
// Episode store double — explicit vectors
// ---------------------------------------------------------------------------

export type EpisodeRow = {
  id: string;
  turnId: string;
  /** Omit to simulate a store that never produced an embedding for this episode. */
  vec?: readonly number[];
  summary?: string;
  ts?: number;
  importance?: number;
  threads?: string[];
  /** Vec12 in AFFECT_DIMS order; defaults to flat. */
  affectAtEncoding?: readonly number[];
};

const FLAT12: readonly number[] = Array.from({ length: AFFECT_DIMS.length }, () => 0);

/** A Vec12 with the named dims set and everything else flat zero. */
export const stamp12 = (over: Partial<Record<(typeof AFFECT_DIMS)[number], number>> = {}): number[] =>
  AFFECT_DIMS.map((d) => over[d] ?? 0);

export const episodeStore = (rows: ReadonlyArray<EpisodeRow>): EpisodeStore => {
  const episodes: Episode[] = rows.map((r, i) => ({
    id: r.id,
    ts: r.ts ?? T0 - HOUR * (rows.length - i),
    turnId: r.turnId,
    summary: r.summary ?? `episode ${r.id}`,
    diaryLine: `diary for ${r.id}`,
    importance: r.importance ?? 5,
    emotions: [],
    threads: r.threads ?? [],
    affectAtEncoding: [...(r.affectAtEncoding ?? FLAT12)],
    ...(r.vec !== undefined ? { vec: new Float32Array(r.vec) } : {}),
  }));
  const vecs = new Map(
    episodes.flatMap((e) => (e.vec !== undefined ? [[e.id, e.vec] as const] : [])),
  );
  return {
    append: async () => {
      throw new Error('episodeStore double: append is not part of consolidate flows');
    },
    search: () => {
      throw new Error('episodeStore double: search is not part of consolidate flows');
    },
    recent: (n: number) => episodes.slice(-n),
    byThread: (id: string) => episodes.filter((e) => e.threads.includes(id)),
    all: () => [...episodes],
    size: () => episodes.length,
    vecsFor: async () => {}, // vectors are explicit in the rows
    vecOf: (id: string) => vecs.get(id),
  };
};

// ---------------------------------------------------------------------------
// EventLog double — records emissions, replays what it holds
// ---------------------------------------------------------------------------

export interface RecordingLog extends EventLog {
  events: EventEnvelope[];
  kinds: () => string[];
}

export const recordingLog = (seed: ReadonlyArray<Omit<EventEnvelope, 'seq'>> = []): RecordingLog => {
  const events: EventEnvelope[] = seed.map((e, i) => ({ ...e, seq: i + 1 }));
  return {
    events,
    kinds: () => events.map((e) => e.kind),
    emit: async (kind, payload, turnId) => {
      events.push({
        seq: events.length + 1,
        ts: 0,
        kind,
        ...(turnId !== undefined ? { turnId } : {}),
        payload,
      });
    },
    replay: async function* (filter): AsyncGenerator<EventEnvelope> {
      for (const e of events) {
        if (filter?.kinds !== undefined && !filter.kinds.includes(e.kind)) continue;
        if (filter?.sinceTs !== undefined && e.ts < filter.sinceTs) continue;
        yield e;
      }
    },
  };
};

export interface SlotSpec {
  exemplarId: string;
  tier: SlotTier;
  channel?: 'character' | 'procedural';
  slot?: 'contrast';
}

export const packetEnvelope = (over: {
  ts: number;
  turnId: string;
  slots: ReadonlyArray<SlotSpec>;
  affectSig?: readonly number[];
}): Omit<EventEnvelope, 'seq'> => ({
  ts: over.ts,
  kind: PACKET_RECORD_KIND,
  payload: {
    turnId: over.turnId,
    slots: over.slots.map(
      (s): PacketSlotView => ({
        exemplarId: s.exemplarId,
        tier: s.tier,
        channel: s.channel ?? 'character',
        baseScore: 1,
        modulation: 0,
        ...(s.slot !== undefined ? { slot: s.slot } : {}),
      }),
    ),
    affectSig: over.affectSig ?? [],
  },
});

export const outcomeEnvelope = (over: {
  ts: number;
  turnId: string;
  sign: -1 | 0 | 1;
  evidence: string;
}): Omit<EventEnvelope, 'seq'> => ({
  ts: over.ts,
  kind: 'memory.outcome_prev',
  payload: { turnId: over.turnId, sign: over.sign, evidence: over.evidence },
});

export const affectEnvelope = (over: { ts: number; tags: readonly string[] }): Omit<EventEnvelope, 'seq'> => ({
  ts: over.ts,
  kind: 'affect.applied',
  payload: { tags: over.tags, moved: [] },
});

// ---------------------------------------------------------------------------
// Corpus fixtures — real files, real parser
// ---------------------------------------------------------------------------

export const canonFile = (dimension: string, slug: string): CorpusFile => {
  const body = [
    '---',
    `id: canon/${dimension}/${slug}`,
    'kind: scene',
    `dimensions: [${dimension}]`,
    'register: [play]',
    'context: fixture canon scene',
    'notes: fixture',
    '---',
    'D: you there?',
    'T: always. say it',
    '',
  ].join('\n');
  return { path: `corpus/canon/${dimension}/${slug}.md`, raw: body };
};

/** Indexes the given canon fixtures plus whatever .md files a directory holds. */
export const corpusWith = (canon: ReadonlyArray<CorpusFile>, livedDir?: string): CorpusIndex => {
  const files: CorpusFile[] = [...canon];
  if (livedDir !== undefined && fs.existsSync(livedDir)) {
    for (const name of fs.readdirSync(livedDir).sort()) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const full = path.join(livedDir, name);
      if (fs.statSync(full).isDirectory()) continue;
      files.push({ path: `var/lived/${name}`, raw: fs.readFileSync(full, 'utf8') });
    }
  }
  return buildIndex(files);
};

// ---------------------------------------------------------------------------
// Model scripts
// ---------------------------------------------------------------------------

/** A valid consolidated draft. The seedHint is echoed into the body so the per-target
 * rng fork is load-bearing in the bytes — the reproducibility proof needs that.
 * Replies through the `emit` tool, like a real endpoint does on the structured
 * ladder's rung (b) — a content reply here would fail rung (b) and silently
 * detour through the seedless repair ask (the exact bug this once masked). */
export const draftResponder = (): Responder => (req) => {
  const seed = req.seedHint !== undefined ? String(req.seedHint) : 'noseed';
  return {
    toolCalls: [
      {
        id: 'd1',
        name: 'emit',
        args: {
          context: 'late night, one lamp, the fans humming',
          dimensions: ['voice'],
          register: ['play'],
          body: `Setup: a quiet terminal\nD: you there?\nT: always. seed ${seed}. say it and I keep it\n`,
        },
      },
    ],
  };
};

export const judgeSays = (score: number, reason = 'faithful to the episodes'): ScriptedResponse => ({
  toolCalls: [{ id: 'e1', name: 'emit', args: { score, reason } }],
});

export const stagedModel = (over: {
  draft?: Responder;
  judge?: () => ScriptedResponse;
  clock?: TestClock;
} = {}): MockModel => {
  const model = new MockModel({ clock: over.clock ?? new TestClock(T0) });
  model.onTask('consolidate', over.draft ?? draftResponder());
  const judge = over.judge ?? ((): ScriptedResponse => judgeSays(5));
  model.onTask('judge', () => judge());
  return model;
};

// ---------------------------------------------------------------------------
// The harness — ConsolidateDeps over temp dirs
// ---------------------------------------------------------------------------

export interface HarnessDirs {
  root: string;
  livedDir: string;
  proposalsDir: string;
  reportsDir: string;
  creditPath: string;
}

export const harnessDirs = (label: string): HarnessDirs => {
  const root = tmpDir(label);
  return {
    root,
    // Round 2: the consolidators' outputs are RUNTIME STATE under var/ —
    // corpus/lived + corpus/proposals are no longer theirs to write.
    livedDir: path.join(root, 'var', 'lived'),
    proposalsDir: path.join(root, 'var', 'proposals'),
    reportsDir: path.join(root, 'var', 'reports'),
    creditPath: path.join(root, 'var', 'credit', 'weights.json'),
  };
};

export interface Harness {
  dirs: HarnessDirs;
  deps: ConsolidateDeps;
  model: MockModel;
  clock: TestClock;
  log: RecordingLog;
  affectLog: RecordingLog;
}

export interface HarnessOver {
  episodes?: ReadonlyArray<EpisodeRow>;
  canon?: ReadonlyArray<CorpusFile>;
  l0?: ReadonlyArray<Omit<EventEnvelope, 'seq'>>;
  affectTags?: ReadonlyArray<{ ts: number; tags: readonly string[] }>;
  cfg?: Partial<ConsolidateConfig>;
  gravityWeek?: number;
  clock?: TestClock;
  seed?: number;
  model?: MockModel;
}

/** Assembles ConsolidateDeps with sane defaults; callers override any piece. */
export const harness = (label: string, over: HarnessOver = {}): Harness => {
  const dirs = harnessDirs(label);
  const clock = over.clock ?? new TestClock(T0);
  const model = over.model ?? stagedModel({ clock });
  const log = recordingLog(over.l0 ?? []);
  const affectLog = recordingLog((over.affectTags ?? []).map((a) => affectEnvelope(a)));
  const deps: ConsolidateDeps = {
    model,
    episodes: episodeStore(over.episodes ?? []),
    corpus: corpusWith(over.canon ?? [canonFile('voice', 'late-server')]),
    affectHistory: affectLog,
    creditPath: dirs.creditPath,
    events: log,
    clock,
    rng: makeRng(over.seed ?? 11),
    cfg: nightlyConfig(dirs, over.gravityWeek ?? 1, over.cfg),
  };
  return { dirs, deps, model, clock, log, affectLog };
};
