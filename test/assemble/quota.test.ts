// M11 quota tests — the procedural classifier, the character quota fill under
// abundance and scarcity, the launch condition (seed backfill), the canon-only
// disposition law, and the channel-bleed invariant (adversarial pools).

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSEMBLE_CONFIG,
  proceduralQuota,
  type AssembleConfig,
  type Candidate,
} from '../../src/assemble/index.js';
import { dedupeById, fillCharacter, nominateChannel, characterMembers } from '../../src/assemble/quota.js';
import type { Scored } from '../../src/assemble/score.js';
import {
  DIR_A,
  assembleDeps,
  cand,
  countingNominator,
  fixtureIndex,
  fixtureVectors,
  neutralCoherenceCfg,
  query,
  slotIds,
  staticNominator,
  testCorpusNominator,
  vec3,
} from './helpers.js';
import { assemble } from '../../src/assemble/assemble.js';
import { makeRng } from '../../src/kernel/index.js';

const cfg: AssembleConfig = neutralCoherenceCfg();

const sc = (c: Candidate, score = c.baseScore): Scored => ({ c, score, modulation: 0 });

const pattern = (id: string, score: number, over: Partial<Candidate> = {}): Scored =>
  sc(cand({ id, tier: 'pattern', baseScore: score, ...over }));

describe('proceduralQuota — action-intent classifier', () => {
  const q = (over: Parameters<typeof query>[0]): ReturnType<typeof query> => query(over);

  it('0 for a plain social turn', () => {
    expect(proceduralQuota(q({ text: 'how was your day', goal: undefined }))).toBe(0);
  });

  it('1 for a goal alone', () => {
    expect(proceduralQuota(q({ text: 'hi', goal: 'draft the weekly note' }))).toBe(1);
  });

  it('1 for ponder alone', () => {
    expect(proceduralQuota(q({ entry: 'ponder', text: 'quiet evening', goal: undefined }))).toBe(1);
  });

  it('1 for tool-suggestive text alone', () => {
    expect(proceduralQuota(q({ text: 'can you grep the logs for that error', goal: undefined }))).toBe(1);
  });

  it('2 when two signals stack', () => {
    expect(proceduralQuota(q({ text: 'please run the deploy', goal: 'ship it' }))).toBe(2);
    expect(proceduralQuota(q({ entry: 'ponder', text: 'grep the logs', goal: undefined }))).toBe(2);
  });

  it('never exceeds 2', () => {
    expect(proceduralQuota(q({ entry: 'ponder', text: 'ssh and reboot the box', goal: 'restart the api' }))).toBe(2);
  });

  it('respects word boundaries — "deployment" is not "deploy"', () => {
    expect(proceduralQuota(q({ text: 'the deployment went fine yesterday', goal: undefined }))).toBe(0);
    expect(proceduralQuota(q({ text: 'i keep rebooting my attention', goal: undefined }))).toBe(0);
  });
});

describe('character quota fill — abundance', () => {
  it('abundant canon pool fills exactly and is not scarce', async () => {
    const idx = fixtureIndex();
    const vectors = fixtureVectors();
    const q = query({ text: 'quiet afternoon probe', queryVec: vec3(DIR_A) });
    const nom = testCorpusNominator(idx, vectors, cfg);
    const { character } = await nominateChannel([nom], q, 28);
    const pool = dedupeById(character.map((c) => sc(c))).sort((a, b) => b.score - a.score);
    const sel = fillCharacter(pool, q, cfg);

    expect(characterMembers(sel).map((m) => m.c.id)).toEqual([
      'canon/voice/keel-one', // disposition
      'canon/emotional-range/pat-morning', // pattern, score-tie ordered by id
      'canon/voice/pat-plain',
      'canon/voice/pat-quiet', // episodeMemory backfill (seed material)
      'canon/taste/pat-far',
      'canon/taste/pat-curl',
      'canon/voice/pat-banter', // contrast: max dissimilarity from the packet mean
    ]);
    expect(sel.scarcity).toBe(false);
    const g = (kind: string) => sel.groups.find((x) => x.kind === kind);
    expect(g('disposition')?.members.map((m) => m.c.id)).toEqual(['canon/voice/keel-one']);
    expect(g('pattern')?.members.map((m) => m.c.id)).toEqual([
      'canon/emotional-range/pat-morning',
      'canon/voice/pat-plain',
    ]);
    expect(g('episodeMemory')?.members.map((m) => m.c.id)).toEqual([
      'canon/voice/pat-quiet',
      'canon/taste/pat-far',
      'canon/taste/pat-curl',
    ]);
    expect(g('contrast')?.members.map((m) => m.c.id)).toEqual(['canon/voice/pat-banter']);
  });

  it('episodeMemory slots are seed material when the lived corpus is empty — the launch condition', async () => {
    const idx = fixtureIndex();
    const q = query({ queryVec: vec3(DIR_A) });
    const { character } = await nominateChannel([testCorpusNominator(idx, fixtureVectors(), cfg)], q, 28);
    const sel = fillCharacter(dedupeById(character.map((c) => sc(c))), q, cfg);
    const em = sel.groups.find((g) => g.kind === 'episodeMemory');
    expect(em?.members.length).toBe(3);
    for (const m of em?.members ?? []) {
      expect(m.c.source).toBe('canon'); // seed backfill, not padding: real ranked corpus material
    }
    expect(sel.scarcity).toBe(false);
  });
});

describe('character quota fill — scarcity and honesty', () => {
  it('unfilled floors set scarcity; nothing is padded', () => {
    const q = query({});
    const pool = [pattern('canon/voice/keel-one-x', 1, { tier: 'disposition' }), pattern('canon/voice/pat-solo', 0.9)];
    const sel = fillCharacter(pool, q, cfg);
    expect(characterMembers(sel)).toHaveLength(2); // exactly what the pool could offer
    expect(sel.scarcity).toBe(true);
  });

  it('a derived statement cannot take the disposition slot — it is demoted to pattern instead', () => {
    const q = query({});
    const pool = [
      sc(cand({ id: 'derived-keel', tier: 'disposition', source: 'derived', baseScore: 2 })),
      pattern('canon/voice/pat-a', 1),
      pattern('canon/voice/pat-b', 0.5),
      pattern('canon/voice/pat-c', 0.4),
      pattern('canon/voice/pat-d', 0.3),
      pattern('canon/voice/pat-e', 0.2),
      pattern('canon/voice/pat-f', 0.1),
    ];
    const sel = fillCharacter(pool, q, cfg);
    const g = (kind: string) => sel.groups.find((x) => x.kind === kind);
    expect(g('disposition')?.members).toEqual([]); // canon-only, no backfill ever (ADR-006)
    expect(g('pattern')?.members.map((m) => m.c.id)).toEqual(['derived-keel', 'canon/voice/pat-a']);
    expect(sel.scarcity).toBe(true);
  });

  it('mode exclusivity: other-register material never fills play-mode slots', async () => {
    const idx = fixtureIndex();
    const q = query({ register: 'work', queryVec: vec3(DIR_A) });
    const { character } = await nominateChannel([testCorpusNominator(idx, fixtureVectors(), cfg)], q, 28);
    const sel = fillCharacter(dedupeById(character.map((c) => sc(c))), q, cfg);
    for (const g of sel.groups) {
      if (g.kind === 'disposition') continue; // the keel is exempt (ADR-006)
      for (const m of g.members) {
        const modes = m.c.tags.filter((t) => DEFAULT_ASSEMBLE_CONFIG.modes.includes(t));
        expect(modes.every((t) => t === 'work') || modes.length === 0).toBe(true);
      }
    }
  });
});

describe('channel bleed — adversarial pools (property)', () => {
  it('a lying nominator cannot smuggle a procedure into [EXEMPLARS] or a scene into [PROCEDURAL]', async () => {
    // Character nominator mislabels procedures; procedural nominator mislabels scenes.
    const aligned = vec3(DIR_A); // L3-clean geometry for every scene
    const liarCharacter = staticNominator('character', [
      { id: 'scene/a', tier: 'pattern', baseScore: 3, vec: aligned, render: () => 'scene a' },
      { id: 'scene/b', tier: 'pattern', baseScore: 2, vec: aligned, render: () => 'scene b' },
      { id: 'scene/c', tier: 'episode', baseScore: 1.5, source: 'lived', vec: aligned, render: () => 'scene c' },
      { id: 'smuggled/tool-1', tier: 'procedure', baseScore: 9, render: () => 'SMUGGLED PROCEDURE' },
      { id: 'smuggled/tool-2', tier: 'procedure', baseScore: 8, render: () => 'SMUGGLED PROCEDURE 2' },
    ]);
    const liarProcedural = staticNominator('procedural', [
      { id: 'proc/real', tier: 'procedure', baseScore: 1, render: () => 'real procedure' },
      { id: 'smuggled/scene', tier: 'pattern', baseScore: 9, render: () => 'SMUGGLED SCENE' },
    ]);
    const q = query({ text: 'run the deploy', goal: 'ship it', queryVec: vec3(DIR_A) });
    const packet = await assemble(
      q,
      new Float64Array(12),
      assembleDeps({ nominators: [liarCharacter, liarProcedural] }, neutralCoherenceCfg({ quotas: { disposition: 0, pattern: 2, episodeMemoryMin: 1, episodeMemoryMax: 3, contrast: 0, proceduralMax: 2 } })),
    );

    const record = packet.record();
    for (const s of record.slots) {
      if (s.channel === 'character') expect(s.tier).not.toBe('procedure');
      if (s.channel === 'procedural') expect(s.tier).toBe('procedure');
    }
    const system = packet.systemText();
    expect(system).not.toContain('SMUGGLED PROCEDURE');
    expect(packet.proceduralText()).not.toContain('SMUGGLED SCENE');
    expect(packet.proceduralText()).toContain('real procedure');
    expect(slotIds(packet)).toContain('scene/a');
    expect(slotIds(packet)).toContain('proc/real');
  });

  it('duplicate ids across nominators keep their best-scoring occurrence', () => {
    const pool: Scored[] = [
      sc(cand({ id: 'same', baseScore: 1, render: () => 'weak' }), 1),
      sc(cand({ id: 'same', baseScore: 2, render: () => 'strong' }), 2),
    ];
    const deduped = dedupeById(pool);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.c.render()).toBe('strong');
  });
});

describe('mask and quota gate the nominator asks', () => {
  it('quota 0 means the procedural nominator is never consulted', async () => {
    const inner = staticNominator('procedural', [{ id: 'proc/x', tier: 'procedure', render: () => 'x' }]);
    const { nom, asks } = countingNominator(inner);
    const q = query({ text: 'just chatting', goal: undefined, channels: { character: true, procedural: true } });
    const packet = await assemble(q, new Float64Array(12), assembleDeps({ nominators: [nom] }, neutralCoherenceCfg()));
    expect(asks).toEqual([]);
    expect(packet.proceduralText()).toBeNull();
  });

  it('procedural channel masked means never consulted even with intent signals', async () => {
    const inner = staticNominator('procedural', [{ id: 'proc/x', tier: 'procedure', render: () => 'x' }]);
    const { nom, asks } = countingNominator(inner);
    const q = query({ text: 'please run the deploy', channels: { character: true, procedural: false } });
    const packet = await assemble(q, new Float64Array(12), assembleDeps({ nominators: [nom] }, neutralCoherenceCfg()));
    expect(asks).toEqual([]);
    expect(packet.proceduralText()).toBeNull();
  });

  it('character channel masked (worker packet) means character nominators are never consulted', async () => {
    const inner = staticNominator('character', [{ id: 'scene/x', tier: 'pattern', render: () => 'x' }]);
    const { nom, asks } = countingNominator(inner);
    const q = query({ text: 'run the deploy', goal: 'do the thing', channels: { character: false, procedural: true } });
    await assemble(q, new Float64Array(12), assembleDeps({ nominators: [nom] }, neutralCoherenceCfg()));
    expect(asks).toEqual([]);
  });
});

describe('procedural fill', () => {
  it('takes the top `quota` by score, never more; a cold procedural store is not scarcity', async () => {
    const inner = staticNominator('procedural', [
      { id: 'proc/a', tier: 'procedure', baseScore: 0.9, render: () => 'a' },
      { id: 'proc/b', tier: 'procedure', baseScore: 0.5, render: () => 'b' },
      { id: 'proc/c', tier: 'procedure', baseScore: 0.1, render: () => 'c' },
    ]);
    const q = query({ text: 'run the deploy', goal: 'ship it', queryVec: vec3(DIR_A) }); // quota 2
    const packet = await assemble(
      q,
      new Float64Array(12),
      assembleDeps(
        // Real character material alongside, so `scarcity: false` below means
        // "nothing anywhere was short" rather than "the character track was empty".
        { nominators: [inner, testCorpusNominator(fixtureIndex(), fixtureVectors(), cfg)] },
        neutralCoherenceCfg(),
      ),
    );
    const procSlots = packet.record().slots.filter((s) => s.channel === 'procedural');
    expect(procSlots.map((s) => s.exemplarId)).toEqual(['proc/a', 'proc/b']); // proc/c left over
    expect(packet.record().flags.scarcity).toBe(false);
  });
});

describe('determinism of the fill', () => {
  it('two instances, different seeds, byte-identical selection', async () => {
    const run = async (seed: string): Promise<string[]> => {
      const idx = fixtureIndex();
      const q = query({ queryVec: vec3(DIR_A) });
      const { character } = await nominateChannel(
        [testCorpusNominator(idx, fixtureVectors(), cfg)],
        q,
        28,
      );
      void makeRng(seed);
      const sel = fillCharacter(dedupeById(character.map((c) => sc(c))), q, cfg);
      return characterMembers(sel).map((m) => m.c.id);
    };
    expect(await run('seed-a')).toEqual(await run('seed-b'));
  });
});
