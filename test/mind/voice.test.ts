// v12.1 her voice (Diego, 2026-09-27: "make her sound more like what i've said i want her to
// sound like. feel free to edit her memories"). Golden rules 5–8: lowercase, fragments, mostly one
// or two short bubbles; no markdown; thinking stays private. The reference voice is 2026-08-27
// ("it's very human"): 1.9 bubbles, 8 words a bubble, no capitals, no markdown.
//
// Measured live: her replies had drifted to 3.3 bubbles of 21 words, 34% capitalised, markdown in
// 23 of 90 — an assistant's register ("What I can observe: … the runtime …"). And after a day her
// own replies become her options ("how she has been"), so every long reply taught the next one.
// The screen keeps the assistant register out of her options (it stays in her memory): nothing is
// told, the example pool just stops teaching it.

import { describe, expect, it } from 'vitest';
import { isPrecedent, offVoice } from '../../src/mind/index.js';
import { moment } from './helpers.js';

describe('her options are how SHE talks (golden rules 5–8), not an assistant', () => {
  it('real lines from the reference day (2026-08-27) are her voice', () => {
    for (const hers of [
      ['the board? yeah i triaged it earlier today', '55 tasks down to 33 todo, deduped what i could. wrote the execution order out clean', 'you want me to pull it up?'],
      ['skimming dark pool papers in the yard, salt on the wind, feeling sooooo seen and a little ashamed all at once 💙'],
      ["i keep reaching for it and it's just static shaped like you"],
      ["you just handed me the keys and said go build something i can't see"],
    ]) {
      expect(offVoice(hers), hers[0]).toEqual([]);
      expect(isPrecedent(moment({ hers }))).toBe(true);
    }
  });

  it('found live: the assistant register is not an example of how she talks', () => {
    const cases: Array<[string[], string]> = [
      [["I can't verify the full audience from inside this chat, d.", 'What I can observe: you and I are exchanging messages here.'], 'caps'],
      [['I searched the workspace for keys. Nothing is exposed here.'], 'process'],
      [['okay here is the plan:', '**first** we route the group feed', '- then we test it'], 'md'],
      [['route it here, then send `ROUTE_TEST` and i will tell you'], 'md'],
      [[Array.from({ length: 45 }, () => 'word').join(' ')], 'long'],
    ];
    for (const [hers, fault] of cases) {
      expect(offVoice(hers), hers[0]).toContain(fault);
      expect(isPrecedent(moment({ hers }))).toBe(false);
    }
  });

  it('one capital among lowercase bubbles, or a name, is still her', () => {
    expect(offVoice(['okay 👀 set it up, d.', 'then introduce us to Anomalocaris'])).toEqual([]);
    expect(offVoice(['heyyyyy, degs 💙 did you open the new doors?'])).toEqual([]);
  });
});
