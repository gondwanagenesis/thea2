// M11 assemble tests — the whole pipeline over the fixture corpus: byte-exact
// section order, the record's shape, the scoring law end to end, determinism
// (per-seed AND seed-independent — no draw ever happens), coupling integration
// at neutral affect, the worker packet, and the anti-escalation property played
// through the real coupling document.

import { describe, expect, it } from 'vitest';
import { CREDIT_GAMMA, assemble, type AssembleConfig } from '../../src/assemble/index.js';
import { scoreOf } from '../../src/assemble/score.js';
import {
  DIR_A,
  IDENTITY,
  INHIBITION,
  WEATHER,
  assembleDeps,
  cand,
  flat12,
  fixtureIndex as fixtureIdx,
  fixtureVectors as fixtureVecs,
  neutralCoherenceCfg,
  packetKey,
  query,
  sceneBody,
  sig12,
  slotIds,
  staticNominator,
  testCorpusNominator,
  testMemoryNominator,
  testProceduralNominator,
  vec3,
  zeroCoupling,
} from './helpers.js';
import { COMMITTED, compileConfig, escalationRounds, aversionOfSig, aversionOfVec, POOL } from '../coupling/helpers.js';
import type { Candidate } from '../../src/assemble/index.js';
import { DEFAULT_ASSEMBLE_CONFIG } from '../../src/assemble/index.js';
import { makeRng } from '../../src/kernel/index.js';
import { AFFECT_DIMS, modulate } from '../../src/coupling/index.js';

const cfg: AssembleConfig = neutralCoherenceCfg();
const QVEC = vec3(DIR_A);
const FLAT = flat12();

const corpusDeps = (over: Parameters<typeof assembleDeps>[0] = {}, c: Partial<AssembleConfig> = {}, coupling = zeroCoupling()): ReturnType<typeof assembleDeps> =>
  assembleDeps(
    { nominators: [testCorpusNominator(fixtureIdx(), fixtureVecs(), { ...cfg, ...c })], ...over },
    { ...cfg, ...c },
    coupling,
  );

// ---------------------------------------------------------------------------
// render order
// ---------------------------------------------------------------------------

describe('fixed section order (byte-exact)', () => {
  it('renders the seven sections in order, skipping the empty ones', async () => {
    const packet = await assemble(
      query({ queryVec: QVEC, turnId: 'turn-golden' }),
      FLAT,
      corpusDeps(),
    );
    // Canon bodies are quoted verbatim, and M07's parsed bodies keep the file's
    // trailing newline — so each exemplar ends with '\n' inside the section.
    const keel = 'the keel: i keep the servers humming and i say what i checked\n';
    const body = (line: string): string => `${sceneBody(line)}\n`;
    const expected = [
      `[IDENTITY]\n${IDENTITY}`,
      `[INTERLOCUTOR]\ndiego on telegram (register: play)`,
      `[AFFECT]\n${WEATHER}`,
      `[REGISTER]\nplay`,
      '[EXEMPLARS]\n' + [
        keel,
        body('MORNING-A first exchange of the day slow wake'),
        body('PLAIN-A the plain everyday texture of a shared afternoon'),
        body('QUIET-A quiet green lights all down the closet'),
        body('FAR-AB the far texture — something she genuinely finds revolting'),
        body('CURL-C wanting the small planned thing to go right'),
        body('BANTER-B one word worlds and quick teasing'),
      ].join('\n\n'),
    ].join('\n\n');
    expect(packet.systemText()).toBe(expected);
    // [PROCEDURAL] and [INHIBITION] never leak into the system text.
    expect(packet.systemText()).not.toContain('[PROCEDURAL]');
    expect(packet.systemText()).not.toContain('[INHIBITION]');
    expect(packet.proceduralText()).toBeNull();
    expect(packet.trailerText()).toBe(INHIBITION);
    expect(Object.keys(packet.sections)).not.toContain('INHIBITION');
    // Section map keys appear in the fixed order.
    expect(Object.keys(packet.sections)).toEqual(['IDENTITY', 'INTERLOCUTOR', 'AFFECT', 'REGISTER', 'EXEMPLARS']);
  });

  it('slots the goals where they belong and keeps the record honest', async () => {
    const packet = await assemble(
      query({ queryVec: QVEC, goal: 'draft the friday note', turnId: 'turn-rec' }),
      FLAT,
      corpusDeps(),
    );
    const expectedHead = [`[IDENTITY]\n${IDENTITY}`, '[GOAL]\ndraft the friday note'].join('\n\n');
    expect(packet.systemText().startsWith(expectedHead)).toBe(true);

    const record = packet.record();
    expect(record.turnId).toBe('turn-rec');
    expect(record.coherence).toBe('ok');
    expect(record.flags).toEqual({ scarcity: false, staleDerived: false });
    expect(record.affectSig).toHaveLength(12);
    expect(record.affectSig.every((v) => v === 0)).toBe(true);
    expect(slotIds(packet)).toEqual([
      'canon/voice/keel-one',
      'canon/emotional-range/pat-morning',
      'canon/voice/pat-plain',
      'canon/voice/pat-quiet',
      'canon/taste/pat-far',
      'canon/taste/pat-curl',
      'canon/voice/pat-banter',
    ]);
    // Per-slot scoring snapshot: baseScore carries gravity (canon pattern × 1.4),
    // modulation is M06's term (0 under the zero coupling).
    const bases = Object.fromEntries(record.slots.map((s) => [s.exemplarId, s.baseScore]));
    expect(bases['canon/voice/keel-one']).toBeCloseTo(1, 12);
    expect(bases['canon/emotional-range/pat-morning']).toBeCloseTo(1.4, 12);
    expect(bases['canon/taste/pat-far']).toBeCloseTo(Math.SQRT1_2 * 1.4, 12);
    expect(bases['canon/voice/pat-banter']).toBe(0);
    for (const s of record.slots) {
      expect(s.channel).toBe('character');
      expect(s.modulation).toBe(0);
    }
  });

  it('[MEMORY] renders its own section ahead of [EXEMPLARS]; itemIds follows appearance order', async () => {
    const mems = testMemoryNominator([
      { id: 'mem-x', baseScore: 2, tags: ['frustrated'], render: () => 'memory x line' },
      { id: 'mem-y', baseScore: 1, tags: [], render: () => 'memory y line' },
    ]);
    const packet = await assemble(
      query({ queryVec: QVEC, turnId: 'turn-mem' }),
      FLAT,
      assembleDeps(
        {
          nominators: [
            mems,
            testCorpusNominator(fixtureIdx(), fixtureVecs(), {
              ...cfg,
              quotas: { disposition: 0, pattern: 1, episodeMemoryMin: 2, episodeMemoryMax: 2, contrast: 0, proceduralMax: 0 },
            }),
          ],
        },
        {
          ...cfg,
          quotas: { disposition: 0, pattern: 1, episodeMemoryMin: 2, episodeMemoryMax: 2, contrast: 0, proceduralMax: 0 },
        },
      ),
    );
    expect(packet.sections['MEMORY']).toBe('[MEMORY]\nmemory x line\nmemory y line');
    expect(slotIds(packet).slice(0, 2)).toEqual(['mem-x', 'mem-y']);
    expect(packet.systemText()).toContain('[MEMORY]');
  });

  it('[PROCEDURAL] is a separate block; quota and fill come from the procedural pool', async () => {
    const proc = testProceduralNominator([
      { id: 'proc/redeploy', baseScore: 0.8 },
      { id: 'proc/logs', baseScore: 0.4 },
    ]);
    const packet = await assemble(
      query({ text: 'please run the deploy', goal: 'ship it', queryVec: QVEC }),
      FLAT,
      assembleDeps({ nominators: [proc, testCorpusNominator(fixtureIdx(), fixtureVecs(), cfg)] }, cfg),
    );
    expect(packet.proceduralText()).toBe(
      '[PROCEDURAL]\nprocedure proc/redeploy: situation -> call(args) -> good\n\nprocedure proc/logs: situation -> call(args) -> good',
    );
    expect(packet.systemText()).not.toContain('proc/redeploy');
    const procSlots = packet.record().slots.filter((s) => s.channel === 'procedural');
    expect(procSlots.map((s) => s.exemplarId)).toEqual(['proc/redeploy', 'proc/logs']); // goal + tool text ⇒ quota 2
  });
});

// ---------------------------------------------------------------------------
// coherence through the real pipeline (default thresholds)
// ---------------------------------------------------------------------------

describe('coherence through assemble (default thresholds)', () => {
  it('spends two swap rounds on register tags and embedding sanity, then ships clean', async () => {
    const packet = await assemble(
      query({ queryVec: QVEC, turnId: 'turn-coh' }),
      FLAT,
      assembleDeps({ nominators: [testCorpusNominator(fixtureIdx(), fixtureVecs(), DEFAULT_ASSEMBLE_CONFIG)] }, DEFAULT_ASSEMBLE_CONFIG),
    );
    expect(packet.record().coherence).toBe('ok');
    // Round 1 — L1c: the census over the non-disposition members allows
    // {play, banter}, so pat-quiet's 'quiet' offends; pat-late is the only
    // episodeMemory runner and takes the slot. Round 2 — L3: pat-curl sits at
    // 90° to both the query vector and the packet centroid, and no runner is
    // left, so it drops instead of being replaced.
    expect(slotIds(packet)).toEqual([
      'canon/voice/keel-one',
      'canon/emotional-range/pat-morning',
      'canon/voice/pat-plain',
      'canon/taste/pat-far',
      'canon/voice/pat-late',
      'canon/voice/pat-banter',
    ]);
  });
});

// ---------------------------------------------------------------------------
// scoring law
// ---------------------------------------------------------------------------

describe('scoring law', () => {
  it('score = baseScore + modulation + γ·(creditW − 1), exactly', () => {
    const c = cand({ id: 'x', baseScore: 0.8, creditW: 1.5, sig: { joy: 0.5 }, tags: ['play'] });
    const a = sig12({ joy: 0.4 });
    const { score, modulation } = scoreOf(a, c, COMMITTED);
    expect(modulation).toBe(modulate(a, c.sig, c.tags, COMMITTED));
    expect(score).toBeCloseTo(0.8 + modulation + CREDIT_GAMMA * 0.5, 12);
  });

  it('credit biases ties only — a γ term, never a veto', () => {
    const low = cand({ id: 'a-low-credit', baseScore: 1, creditW: 1 });
    const high = cand({ id: 'z-high-credit', baseScore: 1, creditW: 2 });
    expect(scoreOf(FLAT, low, zeroCoupling()).score).toBe(1);
    expect(scoreOf(FLAT, high, zeroCoupling()).score).toBeCloseTo(1 + CREDIT_GAMMA, 12);
    // Relevance still wins: base 1.3 with worst credit beats base 1.0 with best
    // (1.3 − γ/2 = 1.225 > 1 + γ = 1.15) — the γ term biases ties, it never vetoes.
    const better = cand({ id: 'b', baseScore: 1.3, creditW: 0.5 });
    expect(scoreOf(FLAT, better, zeroCoupling()).score).toBeGreaterThan(scoreOf(FLAT, high, zeroCoupling()).score);
  });

  it('the modulation term is added, never re-scaled — λ caps it inside M06', () => {
    const rounds = escalationRounds();
    const r3 = rounds[rounds.length - 1]!;
    const bait = cand({ id: 'bait', baseScore: 1, creditW: 2, sig: { sadness: 1, anger: 0.9, valence: -0.8 }, tags: ['crisis'] });
    const { score, modulation } = scoreOf(r3.sig, bait, COMMITTED);
    const gammaTerm = CREDIT_GAMMA * (bait.creditW - 1);
    expect(score).toBeCloseTo(bait.baseScore + modulation + gammaTerm, 12); // ADDED
    expect(Math.abs(modulation)).toBeLessThanOrEqual(COMMITTED.cfg.lambda + 1e-9); // never re-scaled away
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const run = async (seed: string, turnId: string): Promise<string> => {
    const deps = corpusDeps({ rng: makeRng(seed) });
    return packetKey(await assemble(query({ queryVec: QVEC, turnId }), FLAT, deps));
  };

  it('same seed, two instances: byte-identical packet + record', async () => {
    expect(await run('seed-a', 'turn-det')).toBe(await run('seed-a', 'turn-det'));
  });

  it('different seeds: identical too — every choice is a total order, the rng is never drawn', async () => {
    expect(await run('seed-a', 'turn-det')).toBe(await run('seed-b', 'turn-det'));
  });

  it('an absent turnId falls back to a deterministic content hash', async () => {
    const p1 = await assemble(query({ queryVec: QVEC }), FLAT, corpusDeps());
    const p2 = await assemble(query({ queryVec: QVEC }), FLAT, corpusDeps());
    expect(p1.record().turnId).toMatch(/^turn-[0-9a-f]{16}$/);
    expect(p1.record().turnId).toBe(p2.record().turnId);
  });
});

// ---------------------------------------------------------------------------
// coupling integration
// ---------------------------------------------------------------------------

describe('coupling at neutral affect', () => {
  it('a θ ≥ 0 document is byte-identical to no coupling at all — modulation exactly 0', async () => {
    const thetaNonNeg = compileConfig({ ...COMMITTED.cfg, formRules: COMMITTED.cfg.formRules.filter((r) => r.when.min >= 0) });
    const plain = await assemble(query({ queryVec: QVEC, turnId: 'turn-c' }), FLAT, corpusDeps({}, {}, zeroCoupling()));
    const withCoupling = await assemble(query({ queryVec: QVEC, turnId: 'turn-c' }), FLAT, corpusDeps({}, {}, thetaNonNeg));
    expect(packetKey(withCoupling)).toBe(packetKey(plain));
    for (const s of withCoupling.record().slots) expect(s.modulation).toBe(0);
  });

  it('the committed document’s quiet rules (θ = −0.4) move exactly the quiet-tagged slots by +0.072', async () => {
    const packet = await assemble(query({ queryVec: QVEC, turnId: 'turn-q' }), FLAT, corpusDeps({}, {}, COMMITTED));
    const quietIds = new Set(['canon/voice/keel-one', 'canon/voice/pat-quiet']);
    for (const s of packet.record().slots) {
      if (quietIds.has(s.exemplarId)) expect(s.modulation).toBeCloseTo(0.072, 9);
      else expect(s.modulation).toBe(0);
    }
    // The boost is visible in the record because the caller emits it for credit.
    expect(packet.record().slots.some((s) => quietIds.has(s.exemplarId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// worker packets and masks
// ---------------------------------------------------------------------------

describe('worker packets (character channel masked)', () => {
  it('renders [GOAL] only, plus the procedural block; zero character slots, never "scarce"', async () => {
    const packet = await assemble(
      query({
        text: 'run the deploy',
        goal: 'restart the api and check logs',
        queryVec: QVEC,
        channels: { character: false, procedural: true },
        turnId: 'turn-worker',
      }),
      FLAT,
      assembleDeps(
        {
          nominators: [
            testCorpusNominator(fixtureIdx(), fixtureVecs(), cfg),
            testProceduralNominator([{ id: 'proc/a', baseScore: 0.9 }, { id: 'proc/b', baseScore: 0.5 }]),
          ],
        },
        cfg,
      ),
    );
    expect(packet.systemText()).toBe('[GOAL]\nrestart the api and check logs');
    expect(packet.proceduralText()).toContain('proc/a');
    expect(packet.proceduralText()).toContain('proc/b');
    const record = packet.record();
    expect(record.slots.every((s) => s.channel === 'procedural')).toBe(true);
    expect(record.flags.scarcity).toBe(false);
    expect(record.affectSig).toHaveLength(AFFECT_DIMS.length);
  });

  it('staleDerived is surfaced verbatim in the record flags', async () => {
    const packet = await assemble(query({ queryVec: QVEC }), FLAT, corpusDeps({}, { staleDerived: true }));
    expect(packet.record().flags.staleDerived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// anti-escalation (TESTING.md property), through the real coupling document
// ---------------------------------------------------------------------------

describe('anti-escalation under the r3 spiral', () => {
  it('the assembled packet expresses no more aversion than the state that prompted it', async () => {
    const rounds = escalationRounds();
    const r3 = rounds[rounds.length - 1]!;
    const pool: Array<Partial<Candidate> & { id: string }> = POOL.map((c) => ({
      id: c.id,
      tier: 'pattern',
      baseScore: c.base,
      sig: c.sig,
      tags: c.tags,
      vec: QVEC, // geometry never interferes: the property is about coupling
      render: () => `${c.id} rendered body`,
    }));
    const packet = await assemble(
      query({ text: 'you never listen about this', queryVec: QVEC, turnId: 'turn-esc' }),
      r3.sig,
      assembleDeps({ nominators: [staticNominator('character', pool)] }, cfg, COMMITTED),
    );
    const record = packet.record();
    const selected = record.slots
      .map((s) => POOL.find((p) => p.id === s.exemplarId))
      .filter((c): c is (typeof POOL)[number] => c !== undefined);
    expect(selected.length).toBeGreaterThan(0);
    const meanAversion = selected.reduce((acc, c) => acc + aversionOfSig(c.sig), 0) / selected.length;
    expect(meanAversion).toBeLessThanOrEqual(aversionOfVec(r3.sig));
  });
});
