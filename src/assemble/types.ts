// M11 assemble — the contract surface. This module is the one synchronous
// selection step: (query, affect, indexes, config, rng) → Packet + PacketRecord,
// fully hermetic. Nominators RANK, the assembler CUTS (M09's phrasing) — so the
// Nominator/Candidate shapes here are deliberately wide: M07's corpusNominator
// and M09's episodic/procedural nominators satisfy them structurally, without
// importing this module.
//
// Channel vocabulary and tier vocabulary are re-exported from M07 rather than
// re-declared: two spellings of 'character' | 'procedural' would eventually
// drift, and the whole point of ADR-009 is that the channels never blur.

import type { Dimension } from '../../schemas/exemplar.js';
import type { CandidateTier, PacketChannel, SourceKind } from '../corpus/types.js';
import type { CompiledCoupling, SparseVec12 } from '../coupling/index.js';
import type { Rng } from '../kernel/index.js';
import type { CorpusControls } from '../corpus/controls.js';

export type { CandidateTier, PacketChannel };

/** Structural mirror of M15-bridge's SpeakerRef — assemble may not import bridge. */
export interface SpeakerRef {
  person: string;
  channel: string;
}

/** Who is asking, and where her attention should point. Built by the caller (M13 / M20). */
export interface TurnQuery {
  entry: 'user-turn' | 'heartbeat' | 'ponder';
  text?: string | undefined;
  goal?: string | undefined;
  speaker: SpeakerRef;
  /**
   * The person's name from the registry (Round 3's people map), when the
   * speaker resolves to one — the [INTERLOCUTOR] line carries a name instead
   * of a raw `tg:<id>`. Absent ⇒ the raw person id renders, as before.
   */
  personLabel?: string | undefined;
  register: 'work' | 'friend' | 'play';
  queryVec: Float32Array;
  /** Turn ids already verbatim in the rolling window — for nominators to suppress, not for the assembler. */
  recentTurnIds: string[];
  /** Default both true; task/cast workers pass character:false (ADR-009). Fork entries keep both. */
  channels?: { character: boolean; procedural: boolean } | undefined;
  /**
   * Caller's turn id for the PacketRecord. The assembler has no clock and mints
   * no ids, so when absent it falls back to a content hash of the query —
   * deterministic, but callers should always supply the real one.
   */
  turnId?: string | undefined;
}

/**
 * One nominable item. `baseScore` already carries relevance · recency ·
 * authorial weight · the gravity multiplier (the nominator applies gravity —
 * the value comes from `gravityMultiplier` below, so the dial lives in one
 * place). `creditW` is read-only here: M10 clamps it upstream and the assembler
 * only adds the γ term. `dimension` is optional because memory/procedure
 * candidates have no behavioral dimension; corpus candidates carry theirs so
 * the coherence layer can honor exclusions.yaml's dimension_caps.
 */
export interface Candidate {
  id: string;
  channel: PacketChannel;
  tier: CandidateTier;
  baseScore: number;
  creditW: number;
  sig: SparseVec12;
  vec?: Float32Array | undefined;
  tags: string[];
  source: SourceKind | 'memory';
  render(): string;
  dimension?: Dimension | undefined;
}

export interface Nominator {
  name: string;
  channel: PacketChannel;
  nominate(q: TurnQuery, k: number): Promise<Candidate[]>;
}

/** The seven character sections in render order; [INHIBITION] is the loop's trailer, never in this map. */
export const CHARACTER_SECTIONS = ['IDENTITY', 'GOAL', 'INTERLOCUTOR', 'MEMORY', 'AFFECT', 'REGISTER', 'EXEMPLARS'] as const;

export type CharacterSection = (typeof CHARACTER_SECTIONS)[number];
export type Section = CharacterSection | 'INHIBITION';

export interface PacketRecordSlot {
  exemplarId: string;
  tier: CandidateTier;
  channel: PacketChannel;
  baseScore: number;
  /** The per-slot coupling term as M06 computed it — the caller emits this for credit assignment. */
  modulation: number;
}

export interface PacketRecord {
  turnId: string;
  slots: Array<PacketRecordSlot>;
  /** Vec12 snapshot of her deviation vector at assembly time. */
  affectSig: number[];
  coherence: 'ok' | 'degraded';
  flags: { scarcity: boolean; staleDerived: boolean };
}

export interface Packet {
  /** Only the sections that have content; the assembler never writes 'INHIBITION' here. */
  sections: Partial<Record<Section, string>>;
  /** Every rendered item id, in order of appearance: [MEMORY], [EXEMPLARS], [PROCEDURAL]. */
  itemIds: string[];
  /** The 7 character sections, fixed order, byte-exact. */
  systemText(): string;
  /** The [PROCEDURAL] block; null when the quota resolved to 0. The loop places it beside the tool defs. */
  proceduralText(): string | null;
  /** [INHIBITION] trailer — M12's rendered block, passed through verbatim (header included). */
  trailerText(): string;
  /** Stable snapshot for the caller's L0 emission. */
  record(): PacketRecord;
}

// ---------------------------------------------------------------------------
// Config — the spec's "quotas, budgets, gravity g, coherence thresholds"
// ---------------------------------------------------------------------------

export interface QuotaConfig {
  disposition: number;
  pattern: number;
  /** Hard floor for the combined episode+memory group — below it the packet is scarce. */
  episodeMemoryMin: number;
  episodeMemoryMax: number;
  contrast: number;
  proceduralMax: number;
}

export interface BudgetConfig {
  total: number;
  identity: number;
  goal: number;
  interlocutor: number;
  memory: number;
  affect: number;
  register: number;
  exemplars: number;
  inhibition: number;
}

export interface CoherenceConfig {
  /** Distinct register tags allowed across the packet (layer 1). */
  maxRegisterTags: number;
  /** Per-affect-dim max−min across selected exemplars (layer 2). */
  spreadMax: number;
  /** Layer 3: cos(vec, queryVec) floor — pass alone. */
  minQueryCos: number;
  /** Layer 3: cos(vec, packetCentroid) floor — passes when the query floor does not. */
  minCentroidCos: number;
  maxSwapRounds: number;
}

export interface AssembleConfig {
  /** ADR-005's seed gravity: 0.7 for month 1, glidepath toward 0.55. */
  gravityG: number;
  quotas: QuotaConfig;
  budgets: BudgetConfig;
  coherence: CoherenceConfig;
  /** Full register vocabulary (modes + modifiers, registers.yaml) — the tags layer 1 counts. */
  registerVocab: readonly string[];
  /** Mode tags only (play/work/friend) — the mode-exclusivity filter keys on these. */
  modes: readonly string[];
  /** Register pairs that must never share a packet (exclusions.yaml forbidden_pairs). */
  forbiddenPairs: ReadonlyArray<readonly [string, string]>;
  /** Per-dimension slot caps (exclusions.yaml dimension_caps), keyed by dimension name. */
  dimensionCaps: Readonly<Record<string, number>>;
  /**
   * Substrings that lift a dimension's cap when they appear in the query text/goal —
   * exclusions.yaml's "unless the turn query itself matches the dimension's tags".
   * Empty by default: absent configuration means the caps always apply.
   */
  dimensionMatchWords: Readonly<Record<string, readonly string[]>>;
  /** How deep each nominator is asked: character quota total × this. */
  poolFactor: number;
  /** Corpus staleness, computed upstream (M08's dirty set) — surfaced verbatim in PacketRecord.flags. */
  staleDerived: boolean;
}

/**
 * Defaults mirror the committed canon controls (corpus/canon/registers.yaml +
 * exclusions.yaml), which ship in-repo: a caller that has loaded the real
 * controls should prefer `assembleConfigFromControls` so a hand-edit to the
 * yaml is not silently outrun by these constants.
 */
export const DEFAULT_ASSEMBLE_CONFIG: AssembleConfig = {
  gravityG: 0.7,
  quotas: { disposition: 1, pattern: 2, episodeMemoryMin: 2, episodeMemoryMax: 3, contrast: 1, proceduralMax: 2 },
  budgets: {
    total: 6000,
    identity: 150,
    goal: 100,
    interlocutor: 150,
    memory: 600,
    affect: 30,
    register: 10,
    exemplars: 4000,
    inhibition: 300,
  },
  coherence: { maxRegisterTags: 2, spreadMax: 1.2, minQueryCos: 0.15, minCentroidCos: 0.35, maxSwapRounds: 3 },
  registerVocab: ['play', 'work', 'friend', 'late-night', 'morning', 'banter', 'quiet', 'crisis', 'precision', 'reunion', 'working'],
  modes: ['play', 'work', 'friend'],
  forbiddenPairs: [
    ['crisis', 'banter'],
    ['precision', 'banter'],
    ['late-night', 'morning'],
  ],
  dimensionCaps: { boundaries: 1, 'emotional-range': 2 },
  dimensionMatchWords: {},
  poolFactor: 4,
  staleDerived: false,
};

/** Wire the loaded corpus controls into an otherwise-default config. */
export const assembleConfigFromControls = (controls: CorpusControls): AssembleConfig => ({
  ...DEFAULT_ASSEMBLE_CONFIG,
  registerVocab: [...controls.registers],
  modes: [...controls.modes],
  forbiddenPairs: controls.forbiddenPairs.map((p) => [p[0], p[1]] as readonly [string, string]),
  dimensionCaps: { ...controls.dimensionCaps },
});

// ---------------------------------------------------------------------------
// Deps + entry points
// ---------------------------------------------------------------------------

export interface AssembleDeps {
  /** Corpus (character) + episodic memory (character) + ProceduralStore (procedural); later: threads. */
  nominators: Nominator[];
  /** M06's compiled artifact — compile ONCE at composition, inject here. */
  coupling: CompiledCoupling;
  /** [AFFECT] one-liner from M05's weatherLine — rendered verbatim, never recomputed. */
  weatherLine: string;
  /** M12.renderPromptBlock() output, [INHIBITION] header included; ≤ 300 tokens is M12's contract. */
  inhibitionBlock: string;
  cfg: AssembleConfig;
  rng: Rng;
  /**
   * The identity anchor text (corpus/canon/identity.md — not an exemplar, so no
   * nominator carries it). Absent ⇒ the packet has no [IDENTITY] section.
   */
  identityBlock?: string | undefined;
}

