// Reference schema — spec-v1. Source of truth migrates to src/corpus at stage S2; keep synced.
//
// Exemplar file format: Markdown + YAML frontmatter, one file per exemplar.
//   corpus/canon/<dimension>/<slug>.md   id = path-derived ('canon/voice/late-night-glue'), stable
//   corpus/derived/**.md                 id = contentHash of the output file
//   corpus/lived/**.md                   id = contentHash
//
// Body grammar (below the frontmatter):
//   - optional `Setup:` lines, then alternating `D:` / `T:` turns
//   - kind 'scene' requires at least one exchange; kind 'statement' may be bodyless prose
//   - kind 'procedure' embeds a tool-trace block ({situation -> call -> result -> outcome})
//     and belongs to the procedural channel / ProceduralStore — rendered as [PROCEDURAL]
//     beside the tool definitions, never inside [EXEMPLARS] (ADR-009)
//   - length: <= 500 tokens hard / 350 warn (packet-budget protection; M7 lint runs in CI)
//
// Tier (disposition/pattern/episode) is assigned by the corpus nominator and packet
// assembler (M7/M11) — EXCEPT the keel claim: a canon file may author
// `disposition: true` (below), which nominates it to the disposition tier. The
// disposition slot is canon-only (ADR-006); gravity multipliers apply to
// pattern/episode tiers (ADR-005).

import { z } from 'zod';

/** The 8 behavioral dimensions. Doubles as the corpus/canon/ directory vocabulary. */
export const DIMENSIONS = [
  'voice',
  'reasoning',
  'emotional-range',
  'social',
  'boundaries',
  'tool-use',
  'knowledge',
  'taste',
] as const;
export const Dimension = z.enum(DIMENSIONS);
export type Dimension = z.infer<typeof Dimension>;

/**
 * The 12 affect dimensions: PAD + the 9 Thea1 primaries. NOT pure Plutchik —
 * trust is excluded (it lives in the identity dials), pride and shame are added
 * (ADR-004). Must stay identical to the constant in src/affect/vocab.ts and
 * src/coupling/space.ts once those land.
 */
export const AFFECT_DIMS = [
  'valence', 'arousal', 'dominance',
  'joy', 'anticipation', 'pride', 'surprise',
  'sadness', 'fear', 'anger', 'shame', 'disgust',
] as const;
export const AffectDim = z.enum(AFFECT_DIMS);
export type AffectDim = z.infer<typeof AffectDim>;

/** Signed unit interval used by all affect coordinates (deviation coords). */
const signed1 = z.number().min(-1).max(1);

/**
 * Sparse affect signature: unlisted dims = 0. Exemplars typically tag 2-4 dims.
 * NOTE: z.partialRecord, NOT z.record — an enum-keyed z.record is EXHAUSTIVE
 * (every key required), which would reject every sparse exemplar. The
 * exhaustive record is correct only for LivedStamps.encodedAffect below.
 */
export const SparseAffect = z.partialRecord(AffectDim, signed1);
export type SparseAffect = Partial<Record<AffectDim, number>>;

export const ExemplarKind = z.enum(['scene', 'statement', 'procedure']);
export type ExemplarKind = z.infer<typeof ExemplarKind>;

/** Judge attestation on derived output; mirrors manifest entries (report section 2.3). */
export const JudgeStamp = z.object({
  version: z.string(),
  score: z.number(),
  pass: z.boolean(),
});
export type JudgeStamp = z.infer<typeof JudgeStamp>;

/** Provenance block carried by corpus/derived/ exemplars (generator pipeline, M8). */
export const DerivedProvenance = z.object({
  generator: z.string(),
  generatorVersion: z.string(),
  canonIds: z.array(z.string()).min(1),
  /** sha256 of each canon source at generation time; aligned index-wise with canonIds. */
  sourceHashes: z.array(z.string().regex(/^sha256:/)).min(1),
  /** Model id that produced the variation. */
  model: z.string(),
  judge: JudgeStamp,
});
export type DerivedProvenance = z.infer<typeof DerivedProvenance>;

/** Stamps carried by corpus/lived/ exemplars (consolidation output, M10). */
export const LivedStamps = z.object({
  episodeIds: z.array(z.string()).min(1),
  /** FULL 12-dim affect state at encoding — every dim present, not sparse. */
  encodedAffect: z.record(AffectDim, signed1),
  outcome: z.enum(['good', 'mixed', 'bad']),
});
export type LivedStamps = z.infer<typeof LivedStamps>;

/** Frontmatter fields common to every exemplar source (the authored contract). */
export const CanonFrontmatter = z.object({
  id: z.string().min(1),
  kind: ExemplarKind,
  /** Primary dimension first; vocabulary = the 8 behavioral dimensions. */
  dimensions: z.array(Dimension).min(1),
  /** From corpus/canon/registers.yaml: work/friend/play + modifiers (e.g. 'late-night'). */
  register: z.array(z.string().min(1)).min(1),
  /**
   * Keel marking (ADR-006): a canon file flagged `disposition: true` nominates
   * into the disposition tier regardless of kind, alongside `kind: statement`
   * files. Meaningful for canon only — the slot is canon-only and the flag is
   * Diego's hand, not a pipeline decision. Unset = no claim on the keel slot.
   */
  disposition: z.boolean().optional(),
  /** Sparse deviation-coordinate signature over the 12 affect dims, each in [-1, 1]. */
  affect: SparseAffect.default({}),
  /** One-line situation the body demonstrates. */
  context: z.string().min(1),
  /** Authorial prior. Runtime credit weight is a separate value, clamped [0.5, 2.0]. */
  weight: z.number().positive().default(1.0),
  /** Contrast/foil links (exemplar ids); feeds the contrast slot and exclusions. */
  counters: z.array(z.string()).optional(),
  /** What this demonstrates and what must survive derivation. Read by the judge; never rendered into packets. */
  notes: z.string().optional(),
});
export type CanonFrontmatter = z.infer<typeof CanonFrontmatter>;

/** Derived = canon fields + a nested provenance block. */
export const DerivedFrontmatter = CanonFrontmatter.extend({
  provenance: DerivedProvenance,
});
export type DerivedFrontmatter = z.infer<typeof DerivedFrontmatter>;

/** Lived = canon fields + episode stamps at top level (report section 2.8). */
export const LivedFrontmatter = CanonFrontmatter.extend(LivedStamps.shape);
export type LivedFrontmatter = z.infer<typeof LivedFrontmatter>;

/** Parsed, loaded exemplar as held by the CorpusIndex (M7). */
export interface Exemplar extends CanonFrontmatter {
  source: 'canon' | 'derived' | 'lived';
  body: string;
  /** Counted at parse; lint enforces <= 500 hard / 350 warn. */
  tokens: number;
  provenance?: DerivedProvenance;              // present iff source === 'derived'
  episodeIds?: string[];                       // lived only
  encodedAffect?: Record<AffectDim, number>;   // lived only, full 12-dim
  outcome?: 'good' | 'mixed' | 'bad';          // lived only
}

// Validation notes (M7 lint, runs as a CI test over the whole corpus):
//   - frontmatter zod (above); dimensions/register/affect keys within vocabularies
//   - derived/lived files must carry their extra blocks; canon files must not
//   - body token cap; scenes require >= 1 D:/T: exchange
//   - the identity anchor (corpus/canon/identity.md) and inhibitions.yaml sit beside
//     canon but are NOT exemplars and do not validate against this schema
