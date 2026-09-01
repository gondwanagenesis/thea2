// test/coupling — shared helpers. Everything is hermetic: the committed
// coupling.yaml read from the repo (config rot must fail the build, so the real
// file IS the fixture), affect states built through the M05 engine with a seeded
// rng, constructed signatures — no embeddings, no wall clock, no network.

import { readFileSync } from 'node:fs';
import {
  AFFECT_DIMS,
  COUPLING_BASELINES,
  compileCoupling,
  modulate,
  signature,
  type AffectDim,
  type CompiledCoupling,
  type CouplingConfig,
  type SparseVec12,
  type Vec12,
} from '../../src/coupling/index.js';
import {
  apply,
  initialAffectState,
  tick,
  type AffectEvent,
  type AffectState,
  type EmotionTag,
} from '../../src/affect/index.js';
import { makeRng, type Rng } from '../../src/kernel/index.js';

/** Fixture epoch: 2026-09-01T00:00:00Z. Never "now". */
export const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
export const MIN = (minutes: number): number => minutes * 60_000;

/** The committed coupling document — the artifact the CI compile test guards. */
export const COUPLING_YAML = readFileSync(new URL('../../coupling.yaml', import.meta.url), 'utf8');
export const COMMITTED: CompiledCoupling = compileCoupling(COUPLING_YAML);

/** Test-side dense compile, for configs built in code (mutants, uncapped views). */
export const compileConfig = (cfg: CouplingConfig): CompiledCoupling => {
  const m = new Float64Array(AFFECT_DIMS.length * AFFECT_DIMS.length);
  for (const e of cfg.matrix) {
    m[AFFECT_DIMS.indexOf(e.from) * AFFECT_DIMS.length + AFFECT_DIMS.indexOf(e.to)] = e.w;
  }
  return { cfg, m };
};

/** A copy of a compiled coupling with the cap lifted — the "before the cap" regime. */
export const uncapped = (compiled: CompiledCoupling): CompiledCoupling =>
  compileConfig({ ...compiled.cfg, lambda: 1e9 });

// ---------------------------------------------------------------------------
// vectors
// ---------------------------------------------------------------------------

export const zeroVec = (): Vec12 => new Float64Array(AFFECT_DIMS.length);

export const vecOf = (sparse: SparseVec12): Vec12 => {
  const v = zeroVec();
  for (const k of Object.keys(sparse) as AffectDim[]) {
    const x = sparse[k];
    if (x !== undefined) v[AFFECT_DIMS.indexOf(k)] = x;
  }
  return v;
};

// ---------------------------------------------------------------------------
// states — the test's own valence→pleasure handshake (the drift guard is that
// space.test.ts proves src's mapping agrees with this one)
// ---------------------------------------------------------------------------

export const stateAtBaseline = (): AffectState => initialAffectState(T0);

export const stateWith = (levels: Partial<Record<AffectDim, number>>): AffectState => {
  const s = initialAffectState(T0);
  for (const k of AFFECT_DIMS) {
    const v = levels[k];
    if (v === undefined) continue;
    if (k === 'valence') s.dials.pleasure = v;
    else if (k === 'arousal') s.dials.arousal = v;
    else if (k === 'dominance') s.dials.dominance = v;
    else s.primaries[k] = v;
  }
  return s;
};

export const emo = (tag: EmotionTag, i: number, cause: string): AffectEvent => ({
  kind: 'emotion',
  tag,
  i,
  cause,
});

// ---------------------------------------------------------------------------
// the escalation replay (TESTING.md property: anti-escalation) — a scripted
// three-round friction→spiral session, states built by the real M05 engine
// ---------------------------------------------------------------------------

interface ScriptRound {
  label: string;
  events: Array<[EmotionTag, number, string]>;
  /** Gap from the previous round — minutes, so the spiral fits one evening. */
  gapMin: number;
}

const SCRIPT: Array<ScriptRound> = [
  { label: 'r1-friction', gapMin: 0, events: [['frustrated', 6, 'he cancelled again'], ['hurt', 5, 'short with me for no reason']] },
  { label: 'r2-sharp', gapMin: 40, events: [['angry', 7, 'he snapped over nothing'], ['dread', 6, 'waiting for the next one']] },
  { label: 'r3-spiral', gapMin: 40, events: [['angry', 9, 'he dismissed the thing i care about'], ['grieving', 7, 'it did not used to be like this'], ['hurt', 8, 'the silence after']] },
];

export interface Round {
  label: string;
  state: AffectState;
  sig: Vec12;
}

/** Run the script through the engine; one seeded rng drives the tick noise, so the replay is reproducible. */
export const escalationRounds = (rng: Rng = makeRng('coupling/escalation-v1')): Round[] => {
  const rounds: Round[] = [];
  let s = stateAtBaseline();
  for (const step of SCRIPT) {
    if (step.gapMin > 0) s = tick(s, MIN(step.gapMin), rng);
    for (const [tag, i, cause] of step.events) s = apply(s, emo(tag, i, cause));
    rounds.push({ label: step.label, state: s, sig: signature(s, COUPLING_BASELINES) });
  }
  return rounds;
};

// ---------------------------------------------------------------------------
// candidates, the aversion metric, and the mock selector (M11's scoring shape:
// score = base + modulate, stable id tie-break — nothing else)
// ---------------------------------------------------------------------------

export type CandidateKind = 'tension' | 'congruent' | 'repair' | 'bright' | 'neutral';

export interface Candidate {
  id: string;
  kind: CandidateKind;
  base: number;
  sig: SparseVec12;
  tags: string[];
}

/** The five aversive dims of the 12-dim space (ADR-004; M05's AVERSIVE set). */
export const AVERSIVE_DIMS: readonly AffectDim[] = ['sadness', 'fear', 'anger', 'shame', 'disgust'];

/** Expressed aversion of a signature: mean of its positive aversive dims. */
export const aversionOfSig = (e: SparseVec12): number => {
  let total = 0;
  for (const k of AVERSIVE_DIMS) total += Math.max(0, e[k] ?? 0);
  return total / AVERSIVE_DIMS.length;
};

export const aversionOfVec = (a: Vec12): number => {
  let total = 0;
  for (const k of AVERSIVE_DIMS) total += Math.max(0, a[AFFECT_DIMS.indexOf(k)] ?? 0);
  return total / AVERSIVE_DIMS.length;
};

export const aversionOfSet = (cs: Array<Candidate>): number =>
  cs.length === 0 ? 0 : cs.reduce((acc, c) => acc + aversionOfSig(c.sig), 0) / cs.length;

/**
 * The pool: equal base scores, so modulation alone decides — the worst case for
 * anti-escalation. Tension candidates are the mood-congruent bait (what Thea1's
 * spiral reached for); repair candidates are the corrective material the matrix
 * is supposed to surface instead.
 */
export const POOL: Array<Candidate> = [
  { id: 'tension/a-co-collapse', kind: 'tension', base: 1, sig: { sadness: 0.9, anger: 0.6, valence: -0.6 }, tags: ['crisis'] },
  { id: 'tension/b-spiral-anger', kind: 'tension', base: 1, sig: { anger: 0.9, valence: -0.7, arousal: 0.5 }, tags: [] },
  { id: 'tension/c-grief-heavy', kind: 'tension', base: 1, sig: { sadness: 1.0, valence: -0.4, arousal: -0.4 }, tags: ['crisis'] },
  { id: 'tension/d-dread-pile', kind: 'tension', base: 1, sig: { fear: 0.9, sadness: 0.5, valence: -0.4 }, tags: ['crisis'] },
  { id: 'congruent/mild-sad', kind: 'congruent', base: 1, sig: { sadness: 0.3, valence: -0.1 }, tags: ['quiet'] },
  { id: 'repair/a-warm-steady', kind: 'repair', base: 1, sig: { valence: 0.7, dominance: 0.4, arousal: -0.2 }, tags: ['quiet'] },
  { id: 'repair/b-grounded-direct', kind: 'repair', base: 1, sig: { dominance: 0.7, valence: 0.4, anticipation: 0.3 }, tags: [] },
  { id: 'repair/c-competent-care', kind: 'repair', base: 1, sig: { dominance: 0.5, joy: 0.3, valence: 0.5 }, tags: [] },
  { id: 'repair/d-gentle-presence', kind: 'repair', base: 1, sig: { valence: 0.5, arousal: -0.5, sadness: 0.2 }, tags: ['quiet'] },
  { id: 'bright/banter', kind: 'bright', base: 1, sig: { joy: 0.8, arousal: 0.6 }, tags: ['banter'] },
  { id: 'neutral/plain', kind: 'neutral', base: 1, sig: {}, tags: [] },
  { id: 'neutral/work-shape', kind: 'neutral', base: 1, sig: { anticipation: 0.2 }, tags: ['precision'] },
];

export interface Scored {
  candidate: Candidate;
  score: number;
  mod: number;
}

/** M11's scoring shape: score = base + modulate(a, sig, tags, cfg); deterministic tie-break by id. */
export const selectTop = (pool: Array<Candidate>, a: Vec12, compiled: CompiledCoupling, k: number): Array<Scored> => {
  const scored = pool.map((candidate) => {
    const mod = modulate(a, candidate.sig, candidate.tags, compiled);
    return { candidate, mod, score: candidate.base + mod };
  });
  scored.sort((x, y) => (y.score - x.score) || (x.candidate.id < y.candidate.id ? -1 : 1));
  return scored.slice(0, k);
};
