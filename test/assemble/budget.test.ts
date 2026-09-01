// M11 budget tests — the render is the budget's unit of account: 100-word
// bodies make every section's token count exact, so the drop order is
// observable slot by slot. Per-section budgets on [EXEMPLARS]/[MEMORY] first,
// then the total in the spec's overflow order: lowest procedural → lowest
// character exemplar → [MEMORY] trimmed to 3 — and caller-owned oversize ships
// over budget rather than being silently rewritten.

import { describe, expect, it } from 'vitest';
import { MEMORY_TRIM_TARGET, assemble } from '../../src/assemble/index.js';
import { packetTokens } from '../../src/assemble/budget.js';
import type { AssembleConfig } from '../../src/assemble/index.js';
import {
  DIR_A,
  IDENTITY,
  INHIBITION,
  WEATHER,
  assembleDeps,
  flat12,
  neutralCoherenceCfg,
  query,
  slotIds,
  staticNominator,
  testMemoryNominator,
  vec3,
} from './helpers.js';
import { countTokens } from '../../src/corpus/body.js';

const WORDS = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

const budgetsOf = (total: number, memory: number, exemplars = 4000): AssembleConfig['budgets'] => ({
  total,
  identity: 150,
  goal: 100,
  interlocutor: 150,
  memory,
  affect: 30,
  register: 10,
  exemplars,
  inhibition: 300,
});

const cfgWith = (budgets: AssembleConfig['budgets']): AssembleConfig =>
  neutralCoherenceCfg({
    quotas: { disposition: 0, pattern: 2, episodeMemoryMin: 2, episodeMemoryMax: 5, contrast: 0, proceduralMax: 2 },
    budgets,
  });

const deps = (budgets: AssembleConfig['budgets'], identity = IDENTITY): ReturnType<typeof assembleDeps> =>
  assembleDeps(
    {
      nominators: [
        staticNominator('character', [
          { id: 'p1', tier: 'pattern', baseScore: 5, vec: vec3(DIR_A), render: () => WORDS(100) },
          { id: 'p2', tier: 'pattern', baseScore: 4, vec: vec3(DIR_A), render: () => WORDS(100) },
        ]),
        testMemoryNominator([
          { id: 'mem-a', baseScore: 3, render: () => WORDS(100) },
          { id: 'mem-b', baseScore: 2.6, render: () => WORDS(100) },
          { id: 'mem-c', baseScore: 2.2, render: () => WORDS(100) },
          { id: 'mem-d', baseScore: 1.8, render: () => WORDS(100) },
          { id: 'mem-e', baseScore: 1.4, render: () => WORDS(100) },
        ]),
        staticNominator('procedural', [
          { id: 'proc-a', tier: 'procedure', baseScore: 0.9, render: () => WORDS(100) },
          { id: 'proc-b', tier: 'procedure', baseScore: 0.5, render: () => WORDS(100) },
        ]),
      ],
      identityBlock: identity,
    },
    cfgWith(budgets),
  );

const Q = query({ text: 'run the deploy', goal: 'ship it', queryVec: vec3(DIR_A) });
const A = flat12();

const idsOfChannel = async (budgets: AssembleConfig['budgets'], identity?: string): Promise<string[]> => {
  const packet = await assemble(Q, A, deps(budgets, identity));
  return slotIds(packet);
};

const ofPrefix = (ids: string[], prefix: string): string[] => ids.filter((id) => id.startsWith(prefix));
/** Explicit set membership — 'p' as a prefix would also match 'proc-a'. */
const charEx = (ids: string[]): string[] => ids.filter((id) => id === 'p1' || id === 'p2');

describe('per-section budgets', () => {
  it('trims [MEMORY] to its section budget by lowest-scored drops', async () => {
    // 5 memories = 501 tokens > 250 → 3 = 301 > 250 → 2 = 201 ≤ 250.
    const ids = await idsOfChannel(budgetsOf(4000, 250));
    expect(ofPrefix(ids, 'mem-')).toEqual(['mem-a', 'mem-b']);
    expect(charEx(ids)).toEqual(['p1', 'p2']);
    expect(ofPrefix(ids, 'proc-')).toEqual(['proc-a', 'proc-b']);
  });

  it('trims [EXEMPLARS] to its section budget', async () => {
    // [EXEMPLARS] with 2 bodies = 201 > 150 → 1 body = 101 ≤ 150; p2 is lowest.
    const ids = await idsOfChannel(budgetsOf(4000, 4000, 150));
    expect(charEx(ids)).toEqual(['p1']);
  });
});

describe('total budget — the pinned overflow order', () => {
  it('drops the lowest procedural exemplars first', async () => {
    // Full packet ≈ 948 tokens; at 700 both procedurals go, then the lowest character exemplar.
    const ids = await idsOfChannel(budgetsOf(700, 4000));
    expect(ofPrefix(ids, 'proc-')).toEqual([]);
    expect(charEx(ids)).toEqual(['p1']);
    expect(ofPrefix(ids, 'mem-')).toHaveLength(5);
  });

  it('then the lowest character exemplars, then [MEMORY] by lowest score', async () => {
    // Full packet ≈ 958: at 520 both procedurals (−101 each), both exemplars
    // (−101 each) and mem-e go, stopping at 453 ≤ 520.
    const ids = await idsOfChannel(budgetsOf(520, 4000));
    expect(ofPrefix(ids, 'proc-')).toEqual([]);
    expect(charEx(ids)).toEqual([]);
    expect(ofPrefix(ids, 'mem-')).toEqual(['mem-a', 'mem-b', 'mem-c', 'mem-d']);
  });

  it('never trims [MEMORY] below 3 — the packet ships over budget instead', async () => {
    // At 300 the loop bottoms out at 352 tokens — memory pinned at the trim
    // target, nothing else droppable — and ships anyway: 352 > 300.
    const ids = await idsOfChannel(budgetsOf(300, 4000));
    expect(ofPrefix(ids, 'mem-')).toEqual(['mem-a', 'mem-b', 'mem-c']);
    expect(charEx(ids)).toEqual([]);
    expect(MEMORY_TRIM_TARGET).toBe(3);
    const packet = await assemble(Q, A, deps(budgetsOf(300, 4000)));
    expect(
      countTokens(packet.systemText()) +
        countTokens(packet.proceduralText() ?? '') +
        countTokens(packet.trailerText()),
    ).toBeGreaterThan(300);
  });

  it('the shipped packet is measured on the same text it renders', async () => {
    const packet = await assemble(Q, A, deps(budgetsOf(700, 4000)));
    const system = packet.systemText();
    const procedural = packet.proceduralText() ?? '';
    expect(countTokens(system) + countTokens(procedural) + countTokens(packet.trailerText())).toBe(
      packetTokens({
        system,
        procedural,
        trailer: packet.trailerText(),
        memory: packet.sections['MEMORY'] ?? '',
        exemplars: packet.sections['EXEMPLARS'] ?? '',
      }),
    );
  });
});

describe('caller-owned oversize', () => {
  it('a giant identity block survives: the loop drops what it owns and ships over budget', async () => {
    const giant = WORDS(7000);
    const packet = await assemble(Q, A, deps(budgetsOf(1000, 4000), giant));
    expect(packet.systemText()).toContain(giant);
    expect(ofPrefix(slotIds(packet), 'proc-')).toEqual([]);
    expect(charEx(slotIds(packet))).toEqual([]);
    expect(ofPrefix(slotIds(packet), 'mem-')).toEqual(['mem-a', 'mem-b', 'mem-c']);
    // The fixed furniture is untouched, including the trailer's exact bytes.
    expect(packet.trailerText()).toBe(INHIBITION);
    expect(packet.systemText()).toContain(WEATHER);
  });
});
