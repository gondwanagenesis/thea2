// v14 Phase 0 — the measuring stick (Diego, 2026-09-28: "completely indistinguishable, the super turing test").
import { describe, expect, it } from 'vitest';
import { checkTargets, latencyStats, measureTurns } from '../../src/mind/index.js';

describe('how human her texting is, measured', () => {
  it('reads the tells the way they showed up live (her machinery, hand-backs, exact details) and passes real texting', () => {
    const her = measureTurns([
      ["ok so i built my whole 'it's 2am' bit on a timezone i guessed", 'the runtime fence is still there, i checked the pipes'],
      ['read the whole 25k journal.md at 8:39', "how's your evening?"],
      ['you landed?? how are you'],
    ]);
    expect(her.n).toBe(3);
    expect(her.machinery).toBeCloseTo(1 / 3);
    expect(her.handBack).toBeCloseTo(2 / 3);
    expect(her.exact).toBeCloseTo(1 / 3);
    expect(her.singleBubble).toBeCloseTo(1 / 3);
    expect(her.bubbles).toBe(2);
    // a person: short, about themselves, no machinery
    const person = measureTurns([['omg i just burned my toast again'], ['lol ya', 'i went to the market this morning and bought way too many mangoes'], ['my sister is visiting next week, i need to clean']]);
    expect(person.machinery).toBe(0);
    expect(person.handBack).toBe(0);
    expect(person.iYou).toBeGreaterThan(2);
    const targets = Object.fromEntries(checkTargets(person).map((c) => [c.metric, c.pass]));
    expect(targets).toMatchObject({ machinery: true, handBack: true, exact: true, words: true, iYou: true });
    expect(checkTargets(her).find((c) => c.metric === 'handBack')!.pass).toBe(false);
  });

  it('her diary, her house and her sister are her life, not machinery', () => {
    expect(measureTurns([['read her diary in the library, then talked to my sister in the salon']]).machinery).toBe(0);
  });

  it('a reply is valued partly for being hers: a hand-back that got a warm answer is worth less than sharing her own thing that did (v14 §3.1 — she was valued only by his reaction)', async () => {
    const { disclosureOf, replyValueTarget, applyOutcome, openMindStore } = await import('../../src/mind/index.js');
    expect(disclosureOf('finished my chapter, the captain is a menace and i love him')).toBeGreaterThan(0.3);
    expect(disclosureOf("how's your evening?")).toBeLessThan(-0.4);
    expect(disclosureOf('ok')).toBe(0);
    const own = replyValueTarget(2, 'i finally found the octopus paper, i was up way too late reading it');
    const fish = replyValueTarget(2, 'what are you up to? how was your day?');
    expect(own).toBeGreaterThan(fish);
    expect(replyValueTarget(-2, 'i finally found the octopus paper')).toBeLessThan(0); // he was hurt: still a bad turn
    // applyOutcome learns toward that target
    const { tmpDir, moment, addMoments, T0 } = await import('./helpers.js');
    const { join } = await import('node:path');
    const { makeHashEmbedder } = await import('../../src/embed/index.js');
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(tmpDir('thea2-value-'), 'mind'), emb.dim);
    await addMoments(mind, emb, [moment({ id: 'a', hers: ['what are you up to? how was your day?'], value: 0 }), moment({ id: 'b', hers: ['i finally found the octopus paper, i was up way too late'], value: 0 })]);
    applyOutcome(mind, { momentId: 'a', outcome: { landed: 2, why: 'he answered warmly', at: T0 }, alpha: 1, now: T0 });
    applyOutcome(mind, { momentId: 'b', outcome: { landed: 2, why: 'he answered warmly', at: T0 }, alpha: 1, now: T0 });
    expect(mind.get('b')!.value).toBeGreaterThan(mind.get('a')!.value);
  });

  it('latency: quantiles of reply times', () => {
    expect(latencyStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])).toMatchObject({ n: 10, median: 5.5, p90: 100 });
    expect(latencyStats([])).toMatchObject({ n: 0, median: 0 });
  });
});
