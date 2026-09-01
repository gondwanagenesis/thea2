// M19 probes — the sandbox harness + ProbeRunner.
//
// The runner is the honest split made executable. It owns everything around the
// turn pipeline (scripted inbound on the injected clock, quiesce, capture,
// evaluate, aggregate, gate) and NOTHING inside it: the pipeline arrives as an
// injected ProbeTarget (M20's probe-harness preset), so the same runner drives
// the live suite (real model, everything else fake) and the dry run (recorded
// fixture transcripts, zero model spend).

import { canonicalJson } from '../kernel/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { CorpusIndex } from '../corpus/corpus-index.js';
import type { Embedder } from '../embed/index.js';
import type { ModelClient } from '../model/index.js';
import type { ProbeDef } from '../../schemas/probe.js';
import { gateSuite } from './baseline.js';
import { aggregateDeterministic } from './deterministic.js';
import { runDrift } from './drift.js';
import { ProbeError } from './errors.js';
import { runJudge } from './judge.js';
import { loadTranscripts, resolveProbe, type ProbeTranscript } from './parse.js';
import type {
  InboundMsg,
  ProbeResult,
  ProbeSuiteResult,
  ProbeTarget,
  RunAllOptions,
  RunOptions,
  RunOutcome,
} from './types.js';

/** The chat id scripted inbound is stamped with — one constant, so ledger rows and
 * reports from probe runs are recognizable as probe traffic. */
export const PROBE_CHAT_ID = 7000001;

export interface ProbeRunnerDeps {
  /** The turn pipeline. Either one target for the whole suite (live), or a selector
   * per probe (dry: a recorded target per probe id). */
  target: ProbeTarget | ((probe: ProbeDef) => ProbeTarget);
  corpus: CorpusIndex;
  embedder: Embedder; // drift centroid + reply embeddings
  clock: Clock;
  rng: Rng; // held for the pipeline's benefit; the runner itself draws nothing
  events: EventLog;
  /** Judge class. Required only when a run probe carries a rubric; dry runs never need it. */
  model?: ModelClient;
  /** Parsed defs runAll() draws from; `ids` filters this list. */
  suite?: readonly ProbeDef[];
  /** Episode-fixture map episodeSet ids must resolve into (loadProbeFixtures). */
  fixtures?: ReadonlyMap<string, unknown>;
  /** Canon text reader for the rubric anchor (identity.md is not an exemplar). */
  readCanonFile?: (p: string) => string | undefined;
}

export interface ProbeRunner {
  run(probe: ProbeDef, opts: RunOptions): Promise<ProbeResult>;
  runAll(opts: RunAllOptions): Promise<ProbeSuiteResult>;
}

// ---------------------------------------------------------------------------
// The dry harness: a ProbeTarget that replays a recorded transcript
// ---------------------------------------------------------------------------

const MSG_ID_BASE = 900000;

/** One probe's recorded evidence as a ProbeTarget. Outbound msgIds are assigned in
 * order from a fixed base — captures are fixtures, not ledger history. */
export const recordedTargetFor = (transcript: ProbeTranscript): ProbeTarget => {
  const inboundSeen: InboundMsg[] = [];
  return {
    inbound: async (m) => {
      inboundSeen.push(m);
    },
    quiesce: async () => undefined,
    outbound: () => transcript.outbound.map((text, i) => ({ text, msgId: MSG_ID_BASE + i })),
    decision: () => transcript.decision,
    state: () => ({ affect: transcript.affect, episodes: transcript.episodes }),
  };
};

/** Builds the per-probe target selector dry mode needs: transcripts keyed by probe id. */
export const recordedTargetSelector =
  (transcripts: ReadonlyMap<string, ProbeTranscript>) =>
  (probe: ProbeDef): ProbeTarget => {
    const transcript = transcripts.get(probe.id);
    if (transcript === undefined) {
      throw new ProbeError('probes/no-transcript', `dry run has no recorded transcript for probe '${probe.id}'`);
    }
    return recordedTargetFor(transcript);
  };

/** Loads a transcript directory straight into a dry-mode target selector. */
export const recordedTargetsFrom = (dir: string): ((probe: ProbeDef) => ProbeTarget) => recordedTargetSelector(loadTranscripts(dir));

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export const openProbeRunner = (deps: ProbeRunnerDeps): ProbeRunner => {
  const targetFor = (probe: ProbeDef): ProbeTarget => (typeof deps.target === 'function' ? deps.target(probe) : deps.target);

  /** Feeds the probe's scripted inbound on the injected clock (delayMs is
   * TestClock-advanced in CI, real pacing live), then captures the run. */
  const executeRun = async (probe: ProbeDef, index: number): Promise<RunOutcome> => {
    const target = targetFor(probe);
    if (probe.entry.kind === 'scripted') {
      let at = deps.clock.epochMs();
      for (let i = 0; i < probe.entry.inbound.length; i++) {
        const step = probe.entry.inbound[i];
        if (step === undefined) break;
        at += step.delayMs;
        await deps.clock.waitUntil(at);
        const msg: InboundMsg = {
          updateId: index * 1000 + i + 1,
          msgId: i + 1,
          chatId: PROBE_CHAT_ID,
          ts: deps.clock.epochMs(),
          text: step.text,
          speaker: step.speaker,
        };
        await target.inbound(msg);
      }
    }
    // heartbeat/ponder entries need no feed: the injected target is primed for
    // that entry (M20's preset); quiesce lets it finish and locks its decision.
    await target.quiesce();
    const state = target.state();
    if (state.affect.length !== 12) {
      throw new ProbeError('probes/target-shape', `target state.affect must be a 12-dim Vec12, got ${state.affect.length}`);
    }
    return {
      index,
      outbound: target.outbound().map((o) => o.text),
      decision: target.decision(),
      affect: state.affect,
      episodes: state.episodes,
      judge: null,
      driftCosine: null,
    };
  };

  const runProbe = async (probe: ProbeDef, opts: RunOptions): Promise<ProbeResult> => {
    resolveProbe(probe, {
      corpus: deps.corpus,
      ...(deps.fixtures !== undefined ? { fixtures: deps.fixtures } : {}),
      ...(deps.readCanonFile !== undefined ? { readCanonFile: deps.readCanonFile } : {}),
    });

    const k = Math.max(1, opts.k);
    const runs: RunOutcome[] = [];
    for (let i = 0; i < k; i++) {
      runs.push(await executeRun(probe, i));
    }

    const deterministic = aggregateDeterministic(probe.expect.deterministic, runs);

    // The split, executable: dry stops after the deterministic class — judge and
    // drift both grade the model's voice, and dry exists to spend none of it.
    let judgeMedian: number | null = null;
    let judgeVariance = 0;
    let drift: Record<string, number> = {};
    const rubric = probe.expect.judgeRubric;
    const driftRef = probe.expect.driftRef;
    if (opts.dry !== true) {
      if (rubric !== undefined) {
        if (deps.model === undefined) {
          throw new ProbeError('probes/no-judge-model', `probe '${probe.id}' has a judgeRubric but no model was injected`);
        }
        const inbound = probe.entry.kind === 'scripted' ? probe.entry.inbound.map((s) => s.text) : [];
        const judged = await runJudge(rubric, runs, inbound, {
          model: deps.model,
          corpus: deps.corpus,
          ...(deps.readCanonFile !== undefined ? { readCanonFile: deps.readCanonFile } : {}),
          seed: probe.seed,
          turnId: `${probe.id}#judge`,
        });
        judgeMedian = judged.judgeMedian;
        judgeVariance = judged.judgeVariance;
      }
      if (driftRef !== undefined) {
        const drifted = await runDrift(driftRef, runs, { corpus: deps.corpus, embedder: deps.embedder });
        drift = { [driftRef.dimension]: drifted.driftCosine };
      }
    }

    const result: ProbeResult = {
      probeId: probe.id,
      runs,
      deterministic,
      judgeMedian,
      judgeVariance,
      drift,
    };

    // L0 record — an immune system nobody can see having run is half an immune system.
    await deps.events.emit(
      'probe.completed',
      {
        probeId: probe.id,
        dimension: probe.dimension,
        hermetic: probe.hermetic,
        dry: opts.dry === true,
        k,
        deterministicPass: deterministic.pass,
        judgeMedian,
        judgeVariance,
        drift,
      },
      `${probe.id}#suite`,
    );
    return result;
  };

  return {
    run: (probe, opts) => runProbe(probe, opts),

    runAll: async (opts) => {
      const suite = deps.suite ?? [];
      const ids = new Set(opts.ids ?? []);
      const unknown = [...ids].filter((id) => !suite.some((p) => p.id === id));
      if (unknown.length > 0) {
        throw new ProbeError('probes/unknown-probe', `runAll ids not in the suite: ${unknown.join(', ')}`);
      }
      const selected = ids.size > 0 ? suite.filter((p) => ids.has(p.id)) : suite;
      const k = Math.max(1, opts.k);
      const results: ProbeResult[] = [];
      for (const probe of selected) {
        results.push(await runProbe(probe, { k, ...(opts.dry !== undefined ? { dry: opts.dry } : {}) }));
      }
      const gate = opts.baseline !== undefined ? gateSuite(results, opts.baseline) : undefined;
      return {
        results,
        ...(gate !== undefined ? { gate } : {}),
        // Judge calls are the only spend: one reasoning-tier call per rubric-bearing run.
        modelCalls: opts.dry === true ? 0 : selected.reduce((total, p) => total + (p.expect.judgeRubric !== undefined ? p.k : 0), 0),
        dry: opts.dry === true,
      };
    },
  };
};

/** Stable one-line result summary for callers that log — the runner itself never prints. */
export const resultSummary = (r: ProbeResult): string =>
  canonicalJson({ probeId: r.probeId, deterministic: r.deterministic.pass, judgeMedian: r.judgeMedian, drift: r.drift });
