// M08 derive — public contract types (docs/modules/M08-derive.md §Interfaces).
// These shapes are the seam M20 consumes (the `derive` and `corpus:check` CLI
// verbs, plus the derive-check job body it wires into M16's scheduler) and the
// payload vocabulary M16's `derive.stale` alarm re-uses.

import type { Exemplar, JudgeStamp } from '../../schemas/exemplar.js';
import type { EventLog } from '../events/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import type { ModelClient, ToolDef } from '../model/index.js';

// ---------------------------------------------------------------------------
// Load-bearing constants (spec §Behavior; changing one is a design decision)
// ---------------------------------------------------------------------------

/** The six coarse mood buckets; at most one variant per bucket per canon scene. */
export const MOOD_BUCKETS = ['bright', 'tender', 'low', 'tense', 'wanting', 'flat'] as const;
export type MoodBucket = (typeof MOOD_BUCKETS)[number];

/** Fan-out cap: ≤6 mood variants per canon scene (ADR-007 / spec §2.3). */
export const MAX_VARIANTS_PER_SCENE = 6;

/** Global cap: derived:canon ≤ 8:1. Enforced at enumeration, never post-hoc. */
export const MAX_DERIVED_PER_CANON = 8;

/**
 * Judge attestation version + pass threshold. A draft scoring below the
 * threshold is retried once, then discarded. The spec pins the mechanism, not
 * the number; 4/5 is "the shape survived, the voice survived".
 */
export const JUDGE_VERSION = 'derive-judge-v1';
export const JUDGE_PASS_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Generators and targets
// ---------------------------------------------------------------------------

/** The canon/tool inputs a derive run enumerates over. Data only — no code. */
export interface DeriveInputs {
  /** Canon population, from M07's index. */
  canon: Exemplar[];
  /** Tool registry defs (M13's v1 set) for the procedural generator. */
  toolDefs: ToolDef[];
  /** derived:canon ceiling (8). */
  gravityCap: number;
  /** Coarse mood buckets to fan the variation generator across. */
  moodBuckets: readonly string[];
}

/** Where a target's content comes from, hashed. Manifest entries carry this verbatim. */
export interface TargetInputs {
  /** Canon sources of this target, with their content hashes at generation time. */
  canonIds: Array<{ id: string; sha256: string }>;
  /** Set only by the procedural generator: hash of the one ToolDef in the pair. */
  toolDefsHash?: string | undefined;
}

export interface DerivedTarget {
  /** sha256(generator + generatorVersion + sortedInputHashes + templateHash) — see keys.ts. */
  deriveKey: string;
  /** Hash of the generator's prompt/template text; editing a template dirties its family. */
  templateHash: string;
  inputs: TargetInputs;
  /** Mood bucket, for the variation generator only. */
  bucket?: string | undefined;
}

export interface GenerateDeps {
  model: ModelClient;
  rng: Rng;
  /**
   * The run's inputs. A target carries only the hashes of its sources, so
   * generate() needs the inputs to resolve the canon/tool content behind them.
   */
  inputs: DeriveInputs;
}

export interface Generator {
  name: string;
  version: string;
  /** Enumerate expected output targets from current inputs. Caps enforced HERE. */
  targets(inputs: DeriveInputs): DerivedTarget[];
  /**
   * Produce one target's file text: full exemplar markdown with frontmatter,
   * `id` left at the pending placeholder and NO provenance block — M08 owns
   * exactly those two fields (they are functions of the judged output).
   */
  generate(t: DerivedTarget, deps: GenerateDeps): Promise<string>;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  /** = contentHash of the output file (id line masked — see file.ts). */
  id: string;
  deriveKey: string;
  generator: string;
  generatorVersion: string;
  inputs: TargetInputs;
  /** Model id that produced the text. */
  model: string;
  /** epochMs from the injected clock. */
  createdAt: number;
  judge: JudgeStamp;
}

export interface Manifest {
  version: 1;
  embedderId: string;
  entries: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// Check (`thea2 corpus:check` — hermetic, CI)
// ---------------------------------------------------------------------------

export type CheckViolation =
  | { kind: 'missing-file'; id: string; message: string }
  | { kind: 'hash-mismatch'; id: string; fileHash: string; message: string }
  | { kind: 'judge-failed'; id: string; judge: JudgeStamp; message: string }
  | { kind: 'unclaimed-file'; id: string; message: string };

export interface CapsReport {
  ok: boolean;
  canonCount: number;
  /** Manifest entries that are still live (not orphans). */
  derivedCount: number;
  /** gravityCap × canonCount. */
  maxDerived: number;
  gravityCap: number;
  /** Per-scene mood-variant counts above MAX_VARIANTS_PER_SCENE. */
  scenesOver: Array<{ canonId: string; variants: number }>;
}

export interface CheckReport {
  ok: boolean;
  /** Expected targets with no manifest entry — regeneration owed. */
  dirty: DerivedTarget[];
  /** Manifest entries whose deriveKey left the expected set — GC-listed. */
  orphans: ManifestEntry[];
  violations: CheckViolation[];
  caps: CapsReport;
}

// ---------------------------------------------------------------------------
// Run (`thea2 derive` — dev/scheduled, real model)
// ---------------------------------------------------------------------------

export interface JudgeConfig {
  version: string;
  /** Minimum score (1–5) a draft needs to be written. */
  threshold: number;
}

export interface DeriveRunOptions {
  inputs: DeriveInputs;
  generators: readonly Generator[];
  /** Generation model (taskClass 'derive'). */
  model: ModelClient;
  /** The generation model's id, recorded in manifest entries + file provenance. */
  modelId: string;
  /** Reasoning-tier judge (taskClass 'judge'). */
  judgeModel: ModelClient;
  judge: JudgeConfig;
  /** Pinned into the manifest; a mismatch with the active embedder is reported, never absorbed. */
  embedderId: string;
  rng: Rng;
  events: EventLog;
  clock: Clock;
  /** Directory holding the derived population + manifest.json (corpus/derived). */
  outDir: string;
}

export interface DeriveFailure {
  deriveKey: string;
  generator: string;
  attempt: 1 | 2;
  stage: 'generate' | 'parse' | 'judge';
  code: string;
  message: string;
}

export interface DeriveReport {
  ok: boolean;
  /** Dirty targets the run attempted. */
  targets: number;
  /** Files written (== entries added). */
  written: number;
  /** Targets discarded after the judge failed them twice. */
  judgeFailed: number;
  /** Targets discarded after two unparseable generations. */
  parseFailed: number;
  orphans: ManifestEntry[];
  /** Proposals the 8:1 cap refused — the generator stopped, nothing was deleted. */
  droppedByCap: number;
  failures: DeriveFailure[];
  /** The full resulting manifest entry list (already sorted). */
  entries: ManifestEntry[];
  /** Set when the manifest on disk was pinned to a different embedder. */
  embedderMismatch?: { manifest: string; active: string } | undefined;
}

// ---------------------------------------------------------------------------
// L0 payloads. Kind constants exported so M16/M20 emit exactly these shapes.
// ---------------------------------------------------------------------------

export const DERIVE_RUN_EVENT = 'derive.run';
export const DERIVE_ORPHAN_GC_EVENT = 'derive.orphan_gc';
export const DERIVE_STALE_EVENT = 'derive.stale';

export interface DeriveRunEvent {
  targets: number;
  written: number;
  judgeFailed: number;
  parseFailed: number;
  orphans: number;
  droppedByCap: number;
  generators: Array<{ name: string; version: string }>;
  /** Set when the manifest on disk was pinned to a different embedder. */
  embedderMismatch?: { manifest: string; active: string } | undefined;
}

export interface DeriveOrphanGcEvent {
  id: string;
  deriveKey: string;
  file: string;
  removed: boolean;
  error?: string | undefined;
}

/** The weekly derive-check job's alarm payload (M16 job body, wired by M20). */
export interface DeriveStaleEvent {
  dirty: number;
  orphans: number;
  dirtyKeys: string[];
  orphanIds: string[];
}
