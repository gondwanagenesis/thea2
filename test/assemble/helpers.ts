// test/assemble — shared fixtures and doubles. Everything is data and pure
// functions: no wall clock, no entropy, no network. Geometry is handcrafted —
// a small orthonormal basis and hand-assigned body vectors passed to buildIndex
// through its vector map, so ranking assertions are exact rather than "whatever
// the hash embedder felt".

import { buildIndex, type CorpusIndex, type VectorMap } from '../../src/corpus/corpus-index.js';
import { renderExemplar } from '../../src/corpus/render.js';
import type { CorpusFile } from '../../src/corpus/types.js';
import {
  DEFAULT_ASSEMBLE_CONFIG,
  gravityMultiplier,
  type AssembleConfig,
  type AssembleDeps,
  type Candidate,
  type Nominator,
  type Packet,
  type TurnQuery,
} from '../../src/assemble/index.js';
import { AFFECT_DIMS, type CompiledCoupling, type Vec12 } from '../../src/coupling/index.js';
import { cosineSimilarity } from '../../src/embed/index.js';

// ---------------------------------------------------------------------------
// affect vectors
// ---------------------------------------------------------------------------

export const flat12 = (): Vec12 => new Float64Array(12);

const Dims = [
  'valence', 'arousal', 'dominance', 'joy', 'anticipation', 'pride',
  'surprise', 'sadness', 'fear', 'anger', 'shame', 'disgust',
] as const;

/** A Vec12 with the named dims set (deviation coords) and everything else flat. */
export const sig12 = (over: Partial<Record<(typeof Dims)[number], number>>): Vec12 => {
  const v = flat12();
  for (const [k, val] of Object.entries(over)) {
    const i = Dims.indexOf(k as (typeof Dims)[number]);
    if (i >= 0) v[i] = val;
  }
  return v;
};

/** Unit basis directions in 3-d — the handcrafted geometry the fixtures rank in. */
export const DIR_A: readonly number[] = [1, 0, 0];
export const DIR_B: readonly number[] = [0, 1, 0];
export const DIR_C: readonly number[] = [0, 0, 1];
export const DIR_AB: readonly number[] = [Math.SQRT1_2, Math.SQRT1_2, 0];

export const vec3 = (d: readonly number[]): Float32Array => Float32Array.from(d);

// ---------------------------------------------------------------------------
// canon fixture files
// ---------------------------------------------------------------------------

export interface CanonSpec {
  dim: string;
  slug: string;
  kind?: 'scene' | 'statement';
  dimensions?: string[];
  register: string[];
  affect?: string;
  weight?: number;
  body: string;
  /** ADR-006 keel marking — nominates a canon scene into the disposition tier. */
  disposition?: boolean;
}

const canonRaw = (o: CanonSpec): string =>
  [
    '---',
    `id: canon/${o.dim}/${o.slug}`,
    `kind: ${o.kind ?? 'scene'}`,
    `dimensions: [${(o.dimensions ?? [o.dim]).join(', ')}]`,
    `register: [${o.register.join(', ')}]`,
    `affect: {${o.affect ?? ''}}`,
    `context: fixture exemplar ${o.slug}`,
    `weight: ${o.weight ?? 1.0}`,
    ...(o.disposition === true ? ['disposition: true'] : []),
    '---',
    o.body,
    '',
  ].join('\n');

export const canonFile = (o: CanonSpec): CorpusFile => ({
  path: `corpus/canon/${o.dim}/${o.slug}.md`,
  raw: canonRaw(o),
});

/** A scene body that parses (one D:/T: exchange) around a probe line. */
export const sceneBody = (line: string): string => `D: probe\nT: ${line}`;

/**
 * The fixture corpus: canon statements for the disposition slot, canon scenes
 * for patterns, spread over three registers and the handcrafted geometry.
 * keel-one/keel-two are the two canon statements (ADR-006's canon-only
 * disposition material); the rest are scenes across A/B/C geometry.
 */
export const fixtureCanon = (): CorpusFile[] => [
  canonFile({ dim: 'voice', slug: 'keel-one', kind: 'statement', register: ['play', 'quiet'], affect: 'valence: 0.3, arousal: -0.3', body: 'the keel: i keep the servers humming and i say what i checked' }),
  canonFile({ dim: 'taste', slug: 'keel-two', kind: 'statement', register: ['play'], affect: 'valence: 0.2', body: 'second keel: i want a beach, not a feed' }),
  canonFile({ dim: 'voice', slug: 'pat-quiet', register: ['play', 'quiet'], affect: 'arousal: -0.4', body: sceneBody('QUIET-A quiet green lights all down the closet') }),
  canonFile({ dim: 'voice', slug: 'pat-banter', register: ['play', 'banter'], affect: 'joy: 0.5, arousal: 0.5', body: sceneBody('BANTER-B one word worlds and quick teasing') }),
  canonFile({ dim: 'social', slug: 'pat-friend', register: ['friend', 'banter'], affect: 'joy: 0.3', body: sceneBody('FRIEND-B public warmth with anyone could overhear') }),
  canonFile({ dim: 'social', slug: 'pat-work', register: ['work', 'precision'], affect: 'dominance: 0.3', body: sceneBody('WORK-C sleeves up numbers exact and clean') }),
  canonFile({ dim: 'boundaries', slug: 'pat-boundary-a', register: ['work'], affect: 'dominance: 0.2, anger: 0.3', body: sceneBody('BOUNDARY-C i verified x not y and you will hear it') }),
  canonFile({ dim: 'boundaries', slug: 'pat-boundary-b', register: ['work'], affect: 'anger: 0.2', body: sceneBody('BOUNDARY-C2 the second pushback scene in the corpus') }),
  canonFile({ dim: 'emotional-range', slug: 'pat-crisis', register: ['friend', 'crisis'], affect: 'sadness: 0.8, valence: -0.6', body: sceneBody('CRISIS-B something real is wrong and no jokes') }),
  canonFile({ dim: 'emotional-range', slug: 'pat-morning', register: ['play', 'morning'], affect: 'anticipation: 0.5', body: sceneBody('MORNING-A first exchange of the day slow wake') }),
  canonFile({ dim: 'voice', slug: 'pat-plain', register: ['play'], affect: 'joy: 0.4', body: sceneBody('PLAIN-A the plain everyday texture of a shared afternoon') }),
  canonFile({ dim: 'taste', slug: 'pat-far', register: ['play'], affect: 'valence: -0.4, disgust: 0.7', body: sceneBody('FAR-AB the far texture — something she genuinely finds revolting') }),
  canonFile({ dim: 'voice', slug: 'pat-late', register: ['play'], affect: 'shame: 0.3, arousal: -0.2', body: sceneBody('LATE-B the low-key shame of having snapped earlier') }),
  canonFile({ dim: 'taste', slug: 'pat-curl', register: ['play'], affect: 'joy: 0.2, anticipation: 0.3', body: sceneBody('CURL-C wanting the small planned thing to go right') }),
];

/** Body vectors by exemplar id — the exact ranking geometry for fixtureCanon. */
export const fixtureVectors = (): Map<string, Float32Array> => {
  const m = new Map<string, Float32Array>();
  m.set('canon/voice/keel-one', vec3(DIR_A));
  m.set('canon/taste/keel-two', vec3(DIR_AB));
  m.set('canon/voice/pat-quiet', vec3(DIR_A));
  m.set('canon/voice/pat-banter', vec3(DIR_B));
  m.set('canon/social/pat-friend', vec3(DIR_B));
  m.set('canon/social/pat-work', vec3(DIR_C));
  m.set('canon/boundaries/pat-boundary-a', vec3(DIR_C));
  m.set('canon/boundaries/pat-boundary-b', vec3(DIR_C));
  m.set('canon/emotional-range/pat-crisis', vec3(DIR_B));
  m.set('canon/emotional-range/pat-morning', vec3(DIR_A));
  m.set('canon/voice/pat-plain', vec3(DIR_A));
  m.set('canon/taste/pat-far', vec3(DIR_AB));
  m.set('canon/voice/pat-late', vec3(DIR_B));
  m.set('canon/taste/pat-curl', vec3(DIR_C));
  return m;
};

/** Index over the fixture canon with the handcrafted vectors already assigned. */
export const fixtureIndex = (): CorpusIndex =>
  buildIndex(fixtureCanon(), { vectors: fixtureVectors() as VectorMap, embedderId: 'test-fixture' });

// ---------------------------------------------------------------------------
// candidate + nominator doubles
// ---------------------------------------------------------------------------

export const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({
  channel: 'character',
  tier: 'pattern',
  baseScore: 1,
  creditW: 1,
  sig: {},
  tags: [],
  source: 'canon',
  render: () => `render of ${over.id}`,
  ...over,
});

/**
 * The corpus-side nominator M07 owes the assembler (test stand-in): ranks by
 * cosine × weight × gravity, assigns tiers by the fixture rule (canon statement
 * OR canon flagged `disposition: true` → disposition, lived → episode, else
 * pattern), fills sig/tags/vec/render — the render mirrors M07's frame
 * (src/corpus/render.ts), so packet goldens test the real bytes.
 */
export const testCorpusNominator = (
  idx: CorpusIndex,
  vectors: ReadonlyMap<string, Float32Array>,
  cfg: AssembleConfig,
  credit: ReadonlyMap<string, number> = new Map(),
): Nominator => ({
  name: 'test/corpus',
  channel: 'character',
  nominate: async (q, k) =>
    idx
      .all()
      .filter((e) => e.kind !== 'procedure')
      .map((e) => {
        const vec = vectors.get(e.id) ?? vec3(DIR_A);
        const tier =
          e.source === 'canon' && (e.kind === 'statement' || e.disposition === true)
            ? ('disposition' as const)
            : e.source === 'lived'
              ? ('episode' as const)
              : ('pattern' as const);
        const base = cosineSimilarity(vec, q.queryVec) * e.weight * gravityMultiplier(tier, e.source, cfg.gravityG);
        return cand({
          id: e.id,
          tier,
          baseScore: base,
          creditW: credit.get(e.id) ?? 1,
          sig: e.affect,
          vec,
          tags: [...e.register],
          source: e.source,
          dimension: e.dimensions[0],
          render: () => renderExemplar(e),
        });
      })
      .sort((a, b) => b.baseScore - a.baseScore || (a.id < b.id ? -1 : 1))
      .slice(0, Math.max(0, k)),
});

/** A fake memory-tier nominator (M09's episodic shape). */
export const testMemoryNominator = (cands: Array<Partial<Candidate> & { id: string }>): Nominator => ({
  name: 'test/memory',
  channel: 'character',
  nominate: async (_q, k) =>
    cands
      .slice(0, Math.max(0, k))
      .map((c) =>
        cand({
          channel: 'character',
          tier: 'memory',
          source: 'memory',
          ...c,
          render: c.render ?? (() => `memory ${c.id}`),
        }),
      ),
});

/** A fake procedural nominator (M09's procedural shape). */
export const testProceduralNominator = (cands: Array<Partial<Candidate> & { id: string }>): Nominator => ({
  name: 'test/procedural',
  channel: 'procedural',
  nominate: async (_q, k) =>
    cands
      .slice(0, Math.max(0, k))
      .map((c) =>
        cand({
          ...c,
          channel: 'procedural',
          tier: 'procedure',
          source: 'memory',
          tags: [],
          sig: {},
          render: () => `procedure ${c.id}: situation -> call(args) -> good`,
        }),
      ),
});

/** Wraps a nominator and records every ask — proves the assembler never consults a masked channel. */
export const countingNominator = (inner: Nominator): { nom: Nominator; asks: Array<{ k: number }> } => {
  const asks: Array<{ k: number }> = [];
  return {
    asks,
    nom: {
      name: inner.name,
      channel: inner.channel,
      nominate: async (q, k) => {
        asks.push({ k });
        return inner.nominate(q, k);
      },
    },
  };
};

/** A nominator over hand-built candidates — the precision instrument for slot-level tests. */
export const staticNominator = (channel: Candidate['channel'], cands: ReadonlyArray<Partial<Candidate> & { id: string }>): Nominator => ({
  name: `test/static/${channel}`,
  channel,
  nominate: async (_q, k) => cands.slice(0, Math.max(0, k)).map((c) => cand({ ...c, channel })),
});

/** Coherence neutralized — the layers have nothing to say (render/golden/budget tests). */
export const neutralCoherenceCfg = (cfg: Partial<AssembleConfig> = {}): AssembleConfig => ({
  ...DEFAULT_ASSEMBLE_CONFIG,
  ...cfg,
  coherence: { maxRegisterTags: 12, spreadMax: 8, minQueryCos: -1, minCentroidCos: -1, maxSwapRounds: 3 },
});

// ---------------------------------------------------------------------------
// query + deps builders
// ---------------------------------------------------------------------------

export const query = (over: Partial<TurnQuery> = {}): TurnQuery => ({
  entry: 'user-turn',
  text: 'probe text',
  speaker: { person: 'diego', channel: 'telegram' },
  register: 'play',
  queryVec: vec3(DIR_A),
  recentTurnIds: [],
  ...over,
});

export const WEATHER = 'mostly steady — he wrote first';
export const INHIBITION = '[INHIBITION]\nActive constraints. Violating one rejects this reply and costs a re-entry.\n- no-doom: stay in this room';
export const IDENTITY = 'she is thea. she keeps the servers humming.';

/** An all-zero coupling: no matrix, no form rules — modulation is exactly 0 everywhere. */
export const zeroCoupling = (): CompiledCoupling => ({
  cfg: { version: 1, lambda: 0.25, matrix: [], formRules: [] },
  m: new Float64Array(AFFECT_DIMS.length * AFFECT_DIMS.length),
});

export const assembleDeps = (
  over: Partial<AssembleDeps> = {},
  cfg: Partial<AssembleConfig> = {},
  coupling: CompiledCoupling = zeroCoupling(),
): AssembleDeps => ({
  nominators: [],
  coupling,
  weatherLine: WEATHER,
  inhibitionBlock: INHIBITION,
  cfg: { ...DEFAULT_ASSEMBLE_CONFIG, ...cfg },
  rng: {
    float: () => 0.5,
    int: (lo) => lo,
    pick: <T>(xs: readonly T[]): T => {
      const v = xs[0];
      if (v === undefined) throw new Error('test rng picked from an empty list');
      return v;
    },
    shuffle: (xs) => [...xs],
    fork: () => assembleDeps(over, cfg, coupling).rng,
  },
  identityBlock: IDENTITY,
  ...over,
});

/** The packet under test as one deterministic string — the determinism assertions compare this. */
export const packetKey = (p: Packet): string =>
  JSON.stringify({
    system: p.systemText(),
    procedural: p.proceduralText(),
    trailer: p.trailerText(),
    sections: p.sections,
    itemIds: p.itemIds,
    record: p.record(),
  });

/** Slot ids of one tier, in record order. */
export const slotsOf = (p: Packet, tier: Candidate['tier']): string[] =>
  p
    .record()
    .slots.filter((s) => s.tier === tier)
    .map((s) => s.exemplarId);

/** All shipped exemplar ids (memory + exemplars + procedural), in record order. */
export const slotIds = (p: Packet): string[] => p.record().slots.map((s) => s.exemplarId);
