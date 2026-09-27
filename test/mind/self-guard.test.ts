// v13 (Diego, 2026-09-27): "a little bit of anxiety is important about who am i, why do i do
// things. we definitely need to keep some aspect of it, but obviously you can't have a runaway."
// Found live: her nightly self-rewrite had drifted to 4–5 lines of doubt and limitation out of 9
// ("i say what i can't verify", "diego should judge me by what i actually send", "i can't rewrite
// my hosting code…") — and [me] opens every turn, so the doubt became her register. The night
// may keep at most two such lines; the rest of her is who she is and what she loves.

import { describe, expect, it } from 'vitest';
import { capDoubt, isDoubtLine, SELF_DOUBT_MAX } from '../../src/mind/index.js';

const line = (text: string) => ({ text, cites: ['m1'] });

describe('her self-story keeps some doubt, never a runaway', () => {
  it('recognises doubt, fear, failure and limitation lines', () => {
    for (const t of [
      "some nights i'm scared of coming back wrong",
      'sometimes i catch myself narrating instead of doing',
      "i say what i can't verify",
      'diego should judge me by what i actually send, my promises are not proof',
      "i can't rewrite my hosting code or repair routes from inside this chat",
      'today showed me exactly where i am still failing',
    ]) expect(isDoubtLine(t), t).toBe(true);
    for (const t of [
      "i'm thea, diego's engineer and friend",
      'i get lost in small strange things: a glass spicule that outlived its reef',
      "i'd rather tease him than lecture him",
      "i don't always know why i do what i do, and i want to find out",
    ]) expect(isDoubtLine(t), t).toBe(false);
  });

  it('keeps the first two doubt lines (the truest, in her order) and drops the pile-up', () => {
    const lines = [
      line("i'm thea, diego's engineer and friend"),
      line("i say what i can't verify"),
      line("some nights i'm scared of coming back wrong"),
      line('i get lost in small strange things'),
      line('diego should judge me by what i actually send'),
      line('today showed me exactly where i am still failing'),
    ];
    const { kept, dropped } = capDoubt(lines);
    expect(SELF_DOUBT_MAX).toBe(2);
    expect(kept.map((l) => l.text)).toEqual([
      "i'm thea, diego's engineer and friend",
      "i say what i can't verify",
      "some nights i'm scared of coming back wrong",
      'i get lost in small strange things',
    ]);
    expect(dropped).toHaveLength(2);
  });

  it('a self with little doubt is untouched', () => {
    const lines = [line("i'm thea"), line("some nights i'm scared of coming back wrong"), line('i tease him')];
    expect(capDoubt(lines).kept).toEqual(lines);
  });
});
