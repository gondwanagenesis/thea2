import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CorpusIndex } from '../../src/corpus/corpus-index.js';
import { corpusGravity, corpusNominator } from '../../src/corpus/nominator.js';
import type { AffectDim, Dimension, Exemplar } from '../../schemas/exemplar.js';
import { CREDIT_GAMMA, gravityMultiplier, scoreOf } from '../../src/assemble/index.js';
import { COMMITTED } from '../coupling/helpers.js';
import { cosineSimilarity } from '../../src/embed/index.js';
import { sceneBody, sceneFile } from '../probes/helpers.js';
import { buildIndex, type VectorMap } from '../../src/corpus/corpus-index.js';
import { makeFixedEmbedder } from '../../src/embed/fixed-embedder.js';

// ——— hand-built CorpusIndex double (drift.test.ts precedent) ——————————
// corpusNominator reads only idx.all() and idx.vectorOf(); a double lets the
// unit tests control kind/source/dimensions exactly, which real parsing makes
// awkward (derived ids are content hashes, lived needs encoding stamps).

const BODY_A = sceneBody('quiet, green lights all down the closet');
const BODY_B = sceneBody('it hums like a cat and that is my favorite sound');
const BODY_C = sceneBody('yeah. miss you too. obviously');
const STMT_A = 'i like machines that admit what they are.';
const PROC_A = '[tool] lookup {q: hal laning} → observation\n[outcome] good — came back fast';

const DIR_A = [1, 0, 0];
const vec3 = (d: readonly number[]): Float32Array => Float32Array.from(d);

let nextEx = 0;
const ex = (
  id: string,
  kind: Exemplar['kind'],
  source: Exemplar['source'],
  body: string,
  o: {
    dims?: Dimension[];
    register?: string[];
    weight?: number;
    affect?: Partial<Record<AffectDim, number>>;
    disposition?: boolean;
  } = {},
): Exemplar => ({
  id,
  kind,
  dimensions: o.dims ?? ['voice'],
  register: o.register ?? ['play'],
  affect: o.affect ?? {},
  context: 'nominator fixture',
  weight: o.weight ?? 1.0,
  disposition: o.disposition,
  source,
  body,
  tokens: 12,
  provenance:
    source === 'derived'
      ? { generator: 'g', generatorVersion: '1', canonIds: ['canon/x'], sourceHashes: ['sha256:aa'], model: 'm', judge: { version: 'jv', score: 5, pass: true } }
      : undefined,
  encoding:
    source === 'lived'
      ? { episodeIds: ['e1'], encodedAffect: { valence: 0.1 }, owner: 't', ts: 1, outcome: 'good' as const }
      : undefined,
  _n: nextEx++,
} as unknown as Exemplar);

const makeIdx = (exemplars: Exemplar[], vectors: Record<string, number[]> = {}): CorpusIndex => {
  const sorted = [...exemplars].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const idMap = new Map(sorted.map((e) => [e.id, e] as const));
  const vecMap = new Map(Object.entries(vectors).map(([k, v]) => [k, vec3(v)] as const));
  return {
    byId: (id) => idMap.get(id),
    byDimension: () => [...sorted],
    byRegister: () => [...sorted],
    byKind: () => [...sorted],
    bySource: () => [...sorted],
    all: () => [...sorted],
    tags: () => [],
    dimensions: () => ['voice'],
    vectorOf: (id) => vecMap.get(id),
    embedderId: () => 'test-fixture',
    size: () => sorted.length,
  };
};

const POPULATION = (): Exemplar[] => [
  ex('canon/voice/scene-a', 'scene', 'canon', BODY_A),
  ex('canon/voice/scene-b', 'scene', 'canon', BODY_B),
  ex('canon/voice/stmt-a', 'statement', 'canon', STMT_A, { dims: ['taste'] }),
  ex('sha256:derived-1', 'scene', 'derived', BODY_C),
  ex('sha256:lived-1', 'scene', 'lived', BODY_B, { register: ['friend'] }),
  ex('sha256:proc-1', 'procedure', 'derived', PROC_A, { dims: ['tool-use'], register: ['work'] }),
];

const QUERY = vec3(DIR_A);

describe('corpusNominator tier mapping', () => {
  it('canon statement -> disposition, canon/derived scene -> pattern, lived -> episode', async () => {
    const cs = await corpusNominator(makeIdx(POPULATION())).nominate({ queryVec: QUERY }, 10);
    const tierOf = Object.fromEntries(cs.map((c) => [c.id, c.tier]));
    expect(tierOf['canon/voice/stmt-a']).toBe('disposition');
    expect(tierOf['canon/voice/scene-a']).toBe('pattern');
    expect(tierOf['sha256:derived-1']).toBe('pattern');
    expect(tierOf['sha256:lived-1']).toBe('episode');
  });

  it('a canon scene flagged disposition: true nominates to the disposition tier, any kind', async () => {
    const idx = makeIdx([
      ex('canon/voice/flagged-scene', 'scene', 'canon', BODY_A, { disposition: true }),
      ex('canon/voice/flagged-stmt', 'statement', 'canon', STMT_A, { dims: ['taste'], disposition: true }),
    ]);
    const cs = await corpusNominator(idx).nominate({ queryVec: QUERY }, 10);
    const tierOf = Object.fromEntries(cs.map((c) => [c.id, c.tier]));
    expect(tierOf['canon/voice/flagged-scene']).toBe('disposition');
    expect(tierOf['canon/voice/flagged-stmt']).toBe('disposition');
  });

  it('a canon scene without the flag is not the keel — it stays pattern', async () => {
    const idx = makeIdx([ex('canon/voice/unflagged', 'scene', 'canon', BODY_A)]);
    const cs = await corpusNominator(idx).nominate({ queryVec: QUERY }, 10);
    expect(cs.map((c) => c.tier)).toEqual(['pattern']);
  });

  it('never nominates procedures (the procedural channel is M09’s)', async () => {
    const cs = await corpusNominator(makeIdx(POPULATION())).nominate({ queryVec: QUERY }, 10);
    expect(cs.some((c) => c.id === 'sha256:proc-1')).toBe(false);
  });
});

describe('corpusNominator ranking law', () => {
  it('baseScore = cos × weight × gravity, exact on the fixture geometry', async () => {
    const idx = makeIdx(POPULATION(), {
      'canon/voice/scene-a': DIR_A, // cos 1
      'canon/voice/scene-b': [0, 1, 0], // cos 0
      'canon/voice/stmt-a': [Math.SQRT1_2, Math.SQRT1_2, 0], // cos √½
    });
    const cs = await corpusNominator(idx, { g: 0.7 }).nominate({ queryVec: QUERY }, 10);
    const byId = Object.fromEntries(cs.map((c) => [c.id, c.baseScore]));
    expect(byId['canon/voice/scene-a']).toBeCloseTo(1 * 1.0 * 1.4, 12); // pattern/canon at g=.7 -> x1.4
    expect(byId['canon/voice/scene-b']).toBeCloseTo(0, 12);
    expect(byId['canon/voice/stmt-a']).toBeCloseTo(Math.SQRT1_2 * 1.0 * 1.0, 12); // disposition: no gravity
    expect(byId['sha256:lived-1']).toBeCloseTo(0 * 1.0 * 0.6, 12); // lived episode at g=.7 -> x0.6
  });

  it('orders by score desc, then id asc on ties', async () => {
    const idx = makeIdx(POPULATION().filter((e) => e.kind !== 'procedure')); // vector-free: every cos = 0
    const cs = await corpusNominator(idx).nominate({ queryVec: QUERY }, 3);
    const ids = cs.map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
  });

  it('k is the assembler’s lever — the nominator over-returns the full ranked population', async () => {
    const cs = await corpusNominator(makeIdx(POPULATION())).nominate({ queryVec: QUERY }, 1);
    expect(cs.length).toBe(5);
  });

  it('weight multiplies in; a vector-length mismatch ranks at cos 0 instead of crashing', async () => {
    const idx = makeIdx(
      [
        ex('canon/voice/heavy', 'scene', 'canon', BODY_A, { weight: 2.0 }),
        ex('canon/voice/other-dim', 'statement', 'canon', STMT_A, { dims: ['taste'] }),
      ],
      { 'canon/voice/heavy': DIR_A }, // query is 3-d, this is 3-d: fine; stmt has no vector
    );
    const cs = await corpusNominator(idx, { g: 0.7 }).nominate({ queryVec: vec3([1, 0, 0]) }, 10);
    const byId = Object.fromEntries(cs.map((c) => [c.id, c.baseScore]));
    expect(byId['canon/voice/heavy']).toBeCloseTo(2.8, 12); // 2.0 × 1.4
    expect(byId['canon/voice/other-dim']).toBe(0);
  });

  it('render() emits the situation frame above the body; identity fields ride along', async () => {
    const cs = await corpusNominator(makeIdx(POPULATION()), { g: 0.7 }).nominate({ queryVec: QUERY }, 10);
    const a = cs.find((c) => c.id === 'canon/voice/scene-a');
    expect(a?.render()).toBe(`situation: nominator fixture\n${BODY_A}`);
    expect(a?.channel).toBe('character');
    expect(a?.source).toBe('canon');
    expect(a?.tags).toEqual(['play']);
    expect(a?.dimension).toBe('voice');
    expect(a?.creditW).toBe(1.0);
    const lived = cs.find((c) => c.id === 'sha256:lived-1');
    expect(lived?.tags).toEqual(['friend']);
  });

  it('is deterministic across calls (no rng, stable tie-break)', async () => {
    const nom = corpusNominator(makeIdx(POPULATION()));
    const x = await nom.nominate({ queryVec: QUERY }, 10);
    const y = await nom.nominate({ queryVec: QUERY }, 10);
    expect(x.map((c) => [c.id, c.baseScore])).toEqual(y.map((c) => [c.id, c.baseScore]));
  });
});

describe('ADR-005 gravity conformance (mirrored formula === M11’s law)', () => {
  const tiers = ['disposition', 'pattern', 'episode', 'memory', 'procedure'] as const;
  const sources = ['canon', 'derived', 'lived', 'memory'] as const;
  for (const g of [0, 0.55, 0.7, 1]) {
    for (const tier of tiers) {
      for (const source of sources) {
        it(`g=${g} ${tier}/${source}`, () => {
          const mine = corpusGravity(tier as 'disposition', source as 'canon', g);
          const theirs = gravityMultiplier(tier, source, g);
          expect(mine).toBe(theirs);
        });
      }
    }
  }

  it('cosine used for ranking matches the embed module’s', () => {
    expect(cosineSimilarity(vec3(DIR_A), vec3(DIR_A))).toBeCloseTo(1, 12);
  });
});

// ——— integration: a REAL parsed canon index feeding the nominator ————————

describe('corpusNominator over a real buildIndex corpus', () => {
  it('ranks the parseable scene canon through the same law (parse → nominate is one path)', async () => {
    const files = [
      sceneFile('voice', 'server-hum', BODY_A),
      sceneFile('voice', 'one-word-worlds', BODY_B),
      sceneFile('voice', 'missing-you-honest', BODY_C),
    ];
    const index = buildIndex(files); // vector-free first, to read parse order
    const embedder = makeFixedEmbedder({ [BODY_A]: [1, 1, 0], [BODY_B]: [0, 1, 0], [BODY_C]: [1, 0, 0] });
    const vecs = await embedder.embed(index.all().map((e) => e.body));
    const vectors = new Map<string, Float32Array>(index.all().map((e, i) => [e.id, vecs[i]!])) as VectorMap;
    const cached = buildIndex(files, { vectors, embedderId: 'test-fixed' });

    const query = (await embedder.embed([BODY_C]))[0]!; // query aligned with the third exemplar
    const cs = await corpusNominator(cached).nominate({ queryVec: query }, 10);
    expect(cs.length).toBe(3);
    expect(cs.every((c) => c.tier === 'pattern')).toBe(true); // canon scenes are pattern tier
    expect(cs[0]!.render()).toBe(`situation: probe fixture\n${BODY_C}`); // cos 1 with itself wins
    expect(cs[0]!.baseScore).toBeCloseTo(1.4, 12); // cos 1 × weight 1 × gravity 1.4
    // ranked by score: cos 1 (itself), then 1/√2 (BODY_A is 45° off), then 0 (orthogonal)
    expect(cs.map((c) => c.id)).toEqual([
      'canon/voice/missing-you-honest',
      'canon/voice/server-hum',
      'canon/voice/one-word-worlds',
    ]);
  });
});

const T0 = 1_780_000_000_000; // a fixed 2026 morning (deterministic utime stamps)

describe("the credit seam (Round 2: M10's weights move selection)", () => {
  it("credit weight changes a candidate's score", async () => {
    // M10's gamma term goes live through creditPath (Round 2): the nightly
    // weights file must be able to move a candidate WITHOUT any code change.
    const dir = mkdtempSync(join(tmpdir(), 'thea2-credit-'));
    const weightsPath = join(dir, 'weights.json');
    const write = (w: number, mtimeMs: number): void => {
      writeFileSync(
        weightsPath,
        JSON.stringify({ version: 1, lastSeq: 1, decayDay: 0, weights: { 'canon/voice/scene-a': w } }),
      );
      utimesSync(weightsPath, mtimeMs / 1000, mtimeMs / 1000); // the cache is mtime-keyed (numeric seconds)
    };

    write(1.0, T0); // neutral: every id reads as 1.0
    const nom = corpusNominator(makeIdx(POPULATION()), { g: 0.7, creditPath: weightsPath });
    const neutral = (await nom.nominate({ queryVec: QUERY }, 10)).find((c) => c.id === 'canon/voice/scene-a')!;
    expect(neutral.creditW).toBe(1.0);

    write(2.0, T0 + 60_000); // the consolidator re-weighted this exemplar
    const boosted = (await nom.nominate({ queryVec: QUERY }, 10)).find((c) => c.id === 'canon/voice/scene-a')!;
    expect(boosted.creditW).toBe(2.0);

    // The score itself moves, by exactly the gamma term, at a NEUTRAL affect
    // vector (modulation = 0), so the delta isolates credit and nothing else.
    const zero: Float64Array = new Float64Array(12);
    const sBefore = scoreOf(zero, neutral, COMMITTED).score;
    const sAfter = scoreOf(zero, boosted, COMMITTED).score;
    expect(sAfter - sBefore).toBeCloseTo(CREDIT_GAMMA * (2.0 - 1.0), 12);

    // An exemplar the consolidator never scored stays neutral.
    const other = (await nom.nominate({ queryVec: QUERY }, 10)).find((c) => c.id === 'canon/voice/scene-b')!;
    expect(other.creditW).toBe(1.0);
  });
});
