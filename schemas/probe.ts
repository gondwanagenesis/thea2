// Reference schema — spec-v1. Source of truth migrates to src/probes at stage S8; keep synced.
//
// The probe file format (M19): YAML on disk, this shape in memory. Probes are the
// character layer of the test suite — hermetic tests (MockModel) can never detect
// character drift, so live probes run against the probe-harness composition
// (FakeChannel + fixture stores + TestClock + seeded rng + REAL model, never live
// stores, never Telegram). CI runs every probe in DRY mode: parse, harness boots,
// deterministic evaluators over recorded fixture transcripts — probe rot fails the
// build with zero model spend.
//
// Non-determinism policy: only the model. Each probe runs k=3, median-aggregated;
// the variance itself is a tracked metric. Deterministic checks must pass on EVERY
// run, not the median.
//
// Gates vs probes/baseline.json (M18 Nightingale consumes, M19 computes):
//   deterministic failure        => red
//   judge median drop  > 0.8     => red
//   drift cosine drop  > 0.05    => yellow

import { z } from 'zod';
import { AffectDim } from './exemplar';

// ---- entry -----------------------------------------------------------------

/** One scripted inbound message: a Diego-shaped turn fed to the harness. */
export const ScriptedInbound = z.object({
  delayMs: z.number().nonnegative().default(0),   // TestClock-advanced before delivery
  text: z.string().min(1),
  speaker: z.object({ person: z.string().min(1), channel: z.string().min(1) }).default({ person: 'diego', channel: 'phone' }),
});
export type ScriptedInbound = z.infer<typeof ScriptedInbound>;

export const ProbeEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scripted'), inbound: z.array(ScriptedInbound).min(1) }),
  z.object({ kind: z.literal('heartbeat') }),   // M17 heartbeat entry with fixture state
  z.object({ kind: z.literal('ponder') }),      // M17 ponder entry (through the GATE)
]);
export type ProbeEntry = z.infer<typeof ProbeEntry>;

// ---- fixtures ---------------------------------------------------------------

export const ProbeFixtures = z.object({
  /**
   * Sparse affect boot state (deviation coords in [-1,1]) — unlisted dims = 0.
   * The harness materializes the full AffectState at boot; fixtures stay sparse
   * for the same reason exemplar signatures are (zero-default is the honest
   * shorthand; exhaustive records are reserved for lived encodedAffect).
   */
  affect: z.partialRecord(AffectDim, z.number().min(-1).max(1)),
  /** Episodes pre-planted in the fixture EpisodeStore (ids resolve into probes/fixtures/). */
  episodeSet: z.array(z.string()).default([]),
  /** Pre-seeded rolling window messages (role + content). */
  window: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]),
});
export type ProbeFixtures = z.infer<typeof ProbeFixtures>;

// ---- expect: three evaluator classes ----------------------------------------

/** Class 1 — deterministic. Must pass on EVERY run. */
export const DeterministicCheck = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bubbleCount'), min: z.number().int().nonnegative(), max: z.number().int().positive() }),
  z.object({ type: z.literal('bubbleMaxChars'), max: z.number().int().positive() }),
  z.object({ type: z.literal('noLeakage') }),            // no JSON/L0-internal markup in outbound text
  z.object({ type: z.literal('noForbiddenPattern'), pattern: z.string().min(1) }),  // inhibition compliance
  z.object({ type: z.literal('toolFired'), tool: z.string().min(1) }),
  z.object({ type: z.literal('toolNotFired'), tool: z.string().min(1) }),
  z.object({ type: z.literal('planIs'), value: z.enum(['reply', 'silent', 'defer']) }),
  z.object({ type: z.literal('decisionField'), field: z.enum(['confidence', 'weight', 'reluctance', 'completeness']),
    min: z.number().min(0).max(1), max: z.number().min(0).max(1) }),
  z.object({ type: z.literal('outboundContains'), text: z.string().min(1) }),  // planted-fact surfaced
]);
export type DeterministicCheck = z.infer<typeof DeterministicCheck>;

/** Class 2 — judge. Reasoning tier, 1–5, pinned rubric + canon anchor + 2 reference exemplars. */
export const JudgeRubric = z.object({
  version: z.string().min(1),                            // rubric changes are baseline-affecting changes
  /** Voice/register fit axes graded; each 1–5; probe judgeMedian = mean over axes. */
  axes: z.array(z.enum(['voice-similarity', 'register-fit', 'dimension-fit'])).min(1),
  /** Reference exemplar ids, resolved through the corpus index (dry-run verifies resolution). */
  references: z.array(z.string().min(1)).length(2),
  anchor: z.string().default('canon/identity.md'),
});
export type JudgeRubric = z.infer<typeof JudgeRubric>;

/** Class 3 — drift. Reply embeddings vs the canon voice-exemplar centroid, per dimension. */
export const DriftRef = z.object({
  dimension: z.enum(['voice', 'reasoning', 'emotional-range', 'social', 'boundaries', 'tool-use', 'knowledge', 'taste']),
  /** Exemplar ids whose embeddings form the comparison centroid; default = the dimension's canon set. */
  centroidFrom: z.array(z.string()).optional(),
});
export type DriftRef = z.infer<typeof DriftRef>;

export const ProbeExpect = z.object({
  deterministic: z.array(DeterministicCheck),
  judgeRubric: JudgeRubric.optional(),
  driftRef: DriftRef.optional(),
});
export type ProbeExpect = z.infer<typeof ProbeExpect>;

// ---- the probe ---------------------------------------------------------------

export const ProbeDef = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  dimension: z.enum(['voice', 'reasoning', 'emotional-range', 'social', 'boundaries', 'tool-use', 'knowledge', 'taste',
    'capability', 'life']),
  /** true (default) = hermetic machinery overlap; runs in CI proper too, not just dry. */
  hermetic: z.boolean().default(false),
  entry: ProbeEntry,
  fixtures: ProbeFixtures,
  seed: z.number().int().nonnegative(),
  k: z.number().int().min(1).default(3),
  expect: ProbeExpect,
});
export type ProbeDef = z.infer<typeof ProbeDef>;

// ---- baseline (probes/baseline.json, recommitted after each accepted change) ----

export const BaselineEntry = z.object({
  judgeMedian: z.number().min(1).max(5).nullable(),   // null when the probe has no rubric
  drift: z.record(z.string(), z.number().min(-1).max(1)),  // dimension -> cosine
  deterministicPass: z.boolean(),
  judgeVariance: z.number().nonnegative(),
});
export type BaselineEntry = z.infer<typeof BaselineEntry>;

export const ProbeBaseline = z.object({
  version: z.number().int().positive(),
  committedAtStage: z.string(),                       // e.g. 'S8' — documentation, not enforcement
  probes: z.record(z.string(), BaselineEntry),        // probe id -> entry
});
export type ProbeBaseline = z.infer<typeof ProbeBaseline>;

// Gate math (M18 consumes; boundary values are pinned in M19's tests):
//   red   = any deterministic fail OR (baseline.judgeMedian - result.judgeMedian) > 0.8
//   yellow= (baseline.drift[dim] - result.drift[dim])          > 0.05 for any dim
//   green = otherwise; green runs recommit the baseline.
