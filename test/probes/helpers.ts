// test/probes — shared builders and doubles. Everything here is data and pure
// functions: no wall clock, no entropy, no network.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import type { CorpusIndex } from '../../src/corpus/corpus-index.js';
import { buildIndex } from '../../src/corpus/corpus-index.js';
import type { CorpusFile } from '../../src/corpus/types.js';
import { ProbeDef } from '../../schemas/probe.js';
import type { DecisionObject } from '../../schemas/decision.js';
import type { Episode, InboundMsg, ProbeTarget, RunOutcome, Vec12 } from '../../src/probes/index.js';
import type { CheckReport } from '../../src/probes/deterministic.js';
import { AFFECT_DIMS } from '../../schemas/exemplar.js';

// ---------------------------------------------------------------------------
// Dirs — the repo's mkdtemp + afterEach-rm pattern
// ---------------------------------------------------------------------------

export const tmpDir = (label: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `thea2-probes-${label}-`));
export const rmDir = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true });

export const repoRoot = (): string => path.resolve(import.meta.dirname, '../..');

/** Reads a repo file (probes/, corpus/) — hermetic: the local checkout is the fixture. */
export const readRepo = (rel: string): string =>
  readFileSync(path.join(repoRoot(), rel), 'utf8');

// ---------------------------------------------------------------------------
// L0 double — capture probe.completed events without touching the filesystem
// ---------------------------------------------------------------------------

export const memoryLog = (): { log: EventLog; events: EventEnvelope[] } => {
  const events: EventEnvelope[] = [];
  return {
    events,
    log: {
      emit: async (kind, payload, turnId) => {
        events.push({ seq: events.length + 1, ts: 0, kind, ...(turnId !== undefined ? { turnId } : {}), payload });
      },
      async *replay(): AsyncGenerator<EventEnvelope> {
        for (const e of events) yield e;
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Mini corpus — synthetic exemplar files; ids are path-derived for canon
// ---------------------------------------------------------------------------

/**
 * A scene exemplar file whose BODY is exactly `bodyText` — drift tests pin FixedEmbedder
 * geometry to that exact string, so the round-trip file → parsed body must be exact.
 */
export const sceneFile = (dimension: string, slug: string, bodyText: string, id?: string): CorpusFile => ({
  path: `corpus/canon/${dimension}/${slug}.md`,
  raw:
    `---\nid: ${id ?? `canon/${dimension}/${slug}`}\nkind: scene\ndimensions: [${dimension}]\nregister: [play]\n` +
    `affect: {valence: 0.2}\ncontext: probe fixture\nweight: 1.0\n---\n${bodyText}`,
});

/** The canonical two-turn body for a fixture voice exemplar — short, so HashEmbedder
 * vectors stay sparse and distinct. */
export const sceneBody = (herLine: string): string => `D: hey\nT: ${herLine}\n`;

/** Builds a vector-free index (drift embeds bodies through the injected embedder). */
export const miniCorpus = (...files: CorpusFile[]): CorpusIndex => buildIndex(files);

export const VOICE_BODY_A = sceneBody('quiet, green lights all down the closet');
export const VOICE_BODY_B = sceneBody('it hums like a cat and that is my favorite sound');

/** Two canon voice exemplars + one emotional-range — the minimum a rubric needs. */
export const defaultCorpus = (): CorpusIndex =>
  miniCorpus(
    sceneFile('voice', 'server-hum', VOICE_BODY_A),
    sceneFile('voice', 'one-word-worlds', VOICE_BODY_B),
    sceneFile('emotional-range', 'missing-you-honest', sceneBody('yeah. miss you too. obviously')),
  );

// ---------------------------------------------------------------------------
// Decisions, episodes, targets
// ---------------------------------------------------------------------------

/** A RunOutcome whose evidence is exactly what the test names — the evaluators' input. */
export const runOf = (outbound: string[], decision: Partial<DecisionObject> | null = {}): RunOutcome => ({
  index: 0,
  outbound,
  decision: decision === null ? null : decisionOf(decision),
  affect: stamp12(),
  episodes: [],
  judge: null,
  driftCosine: null,
});

/** A CheckReport for gate tests: green vacuously, or red by one named noLeakage failure. */
export const deterministic = (pass: boolean): CheckReport =>
  pass
    ? { pass: true, results: [] }
    : {
        pass: false,
        results: [
          {
            check: { type: 'noLeakage' },
            pass: false,
            perRun: [false],
            details: ['[json-object] "synthetic failure for gate tests"'],
          },
        ],
      };

/** A full mirror-DecisionObject with every field overridden inline. */
export const decisionOf = (over: Partial<DecisionObject> = {}): DecisionObject => ({
  turnId: 'turn-probe',
  plan: 'reply',
  bubbles: [],
  confidence: 0.5,
  weight: 0.5,
  reluctance: 0.5,
  completeness: 1,
  toolTrace: [],
  spawns: [],
  inhibitions: [],
  ...over,
});

export const stamp12 = (over: Partial<Record<(typeof AFFECT_DIMS)[number], number>> = {}): number[] =>
  AFFECT_DIMS.map((d) => over[d] ?? 0);

export const episodeOf = (over: Partial<Episode> = {}): Episode => ({
  id: 'ep-fixture',
  ts: 0,
  turnId: 'turn-probe',
  summary: 'told him about the lemon tree graft',
  diaryLine: 'he never remembers the rootstock part',
  importance: 4,
  emotions: [{ tag: 'brat-delight', i: 3, cause: 'his forgetting again' }],
  threads: ['lemon-tree'],
  affectAtEncoding: stamp12({ valence: 0.2, joy: 0.15 }),
  ...over,
});

export interface TargetScript {
  outbound?: string[];
  decision?: DecisionObject | null;
  affect?: Vec12;
  episodes?: Episode[];
  /** Records inbound so tests can assert what the runner fed. */
  captureInbound?: InboundMsg[];
}

/** The scripted ProbeTarget the tests stand in for M20's probe-harness preset.
 * Pass `captureInbound: []` to record the messages the runner feeds. */
export const scriptedTarget = (script: TargetScript): ProbeTarget => {
  return {
    inbound: async (m) => {
      script.captureInbound?.push(m);
    },
    quiesce: async () => undefined,
    outbound: () => (script.outbound ?? []).map((text, i) => ({ text, msgId: 5000 + i })),
    decision: () => script.decision ?? null,
    state: () => ({ affect: script.affect ?? stamp12(), episodes: script.episodes ?? [] }),
  };
};

// ---------------------------------------------------------------------------
// Probe defs — built through the reference schema so defaults are real
// ---------------------------------------------------------------------------

export const probeOf = (over: Record<string, unknown>): ProbeDef =>
  ProbeDef.parse({
    id: 'probe-under-test',
    title: 'a probe under test',
    dimension: 'voice',
    seed: 7,
    entry: { kind: 'scripted', inbound: [{ delayMs: 0, text: 'hey' }] },
    fixtures: { affect: {}, episodeSet: [], window: [] },
    expect: { deterministic: [] },
    ...over,
  });
