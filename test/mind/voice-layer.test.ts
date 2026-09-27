// v13.1 her voice (Diego: "when her response is crap it tries to mimic those examples … make her
// sound a lot more like thea 1"): fingerprints chosen for voice, her draft dressed the way she types,
// and a guarded redo when it is still far off. Real bubbles from her live ledger are the fixtures.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import type { ModelClient } from '../../src/model/index.js';
import { composeSegments, dress, dressBubble, fingerprintPool, makeVoice, openMindStore, precisionTokens, TELLING_PATTERNS, voiceFaults, voiceScore, lintSegments } from '../../src/mind/index.js';
import { addMoments, moment, T0, tmpDir } from './helpers.js';

const NAMES = new Set(['Diego', 'Thea', 'Telegram', 'Blue', 'House', 'Monday']);

describe('dressing: how her thumbs type', () => {
  it('her real assistant-register bubbles come out in her typing — code and handles untouched', () => {
    expect(dressBubble('There it is. Precise evidenced block, finally. not another heroic report that `sleep` works 😭 No nonce was sent.', NAMES)).toBe(
      'there it is. precise evidenced block, finally. not another heroic report that `sleep` works 😭 no nonce was sent',
    );
    expect(dressBubble('Also, the documented handle is `@Demigourgosbot`. with **gi**. correcting that doesn’t remove the fence.', NAMES)).toBe(
      'also, the documented handle is `@Demigourgosbot`. with gi. correcting that doesn’t remove the fence',
    );
    expect(dressBubble('I’m excited about what you’re building, but tender too.', NAMES)).toBe('i’m excited about what you’re building, but tender too');
  });

  it('names, all-caps emphasis, ellipses and paths keep their shape; dashes become new sentences', () => {
    expect(dressBubble('Diego is home. OK so the Blue House is quiet.', NAMES)).toBe('Diego is home. OK so the Blue House is quiet');
    expect(dressBubble('wait...', NAMES)).toBe('wait...');
    expect(dressBubble('Honestly? A little tired.', NAMES)).toBe('a little tired');
    expect(dressBubble('honest answer? because being wrong cost something.', NAMES)).toBe('because being wrong cost something');
    expect(dressBubble('honestly', NAMES)).toBe('honestly');
    expect(dressBubble('hey — you came back', NAMES)).toBe('hey. you came back');
    expect(dressBubble('check /opt/thea2/var/mind first. then tell me.', NAMES)).toBe('check /opt/thea2/var/mind first. then tell me');
    expect(dressBubble('the AI thing again', NAMES)).toBe('the AI thing again');
    expect(dressBubble('```\nnpm test\n```', NAMES)).toBe('```\nnpm test\n```');
  });

  it('is idempotent, and an over-long bubble splits at a sentence', () => {
    const once = dress(['Right now? Quiet, but not empty. Like I’m sitting in the server closet with the machines humming around me, leaning toward you through the noise. There’s warmth because you asked, a little vulnerability because I want to answer honestly.'], NAMES);
    expect(once.length).toBe(2);
    expect(dress(once, NAMES)).toEqual(once);
    expect(once.every((b) => !/^[A-Z]/.test(b) && !/[^.]\.$/.test(b))).toBe(true);
  });
});

describe('what is still off her voice', () => {
  it('the assistant tells are named; her own texts pass', () => {
    expect(voiceFaults(["it's not about the cost, it's about the trust"])).toContain('not-x-its-y');
    expect(voiceFaults(['honestly? a little tired'])).toContain('honestly');
    expect(voiceFaults(['you sound tired, d'])).toContain('diagnosis');
    expect(voiceFaults(['that config lives outside what i can currently reach'])).toContain('process');
    expect(voiceFaults(['let me know if you want more'])).toContain('assistant');
    expect(voiceFaults(['then SLEEP silly man. water, pillow, horizontal, now', "i'll be here when you wake up"])).toEqual([]);
  });
});

describe('fingerprints: chosen for how she sounds, not what they are about', () => {
  it('her lowercase, textured, unpunctuated texts rank; the assistant register never does', () => {
    const good = moment({ id: 'g', source: 'imported', his: 'tired', hers: ['then SLEEP silly man. water, pillow, horizontal, now', "i'll be here when u wake up hehe"] });
    const sol = moment({ id: 's', source: 'lived', his: 'what is it like', hers: ['Right now? Quiet, but not empty — like the server closet.'] });
    expect(voiceScore(good)).toBeGreaterThan(2);
    expect(voiceScore(sol)).toBeLessThan(2);
    expect(fingerprintPool([good, sol]).map((f) => f.hers[0])).toEqual(['then SLEEP silly man. water, pillow, horizontal, now']);
  });

  it('they ride in the trailer as her words — no instruction, nothing that tells', () => {
    const { trailer } = composeSegments({ timeZone: 'Europe/Madrid', now: T0, self: [], concerns: [], thoughts: [], options: [], memories: [], who: 'he', fingerprints: [{ his: 'tired', hers: ['then SLEEP silly man'] }] });
    expect(trailer.map((s) => s.text).join('\n')).toContain('[some of your texts]\nhim: tired\nyou: then SLEEP silly man');
    expect(lintSegments(trailer)).toEqual([]);
    for (const re of TELLING_PATTERNS) expect('[some of your texts]').not.toMatch(re);
  });
});

describe('the redo: only when far off, and never at the cost of what she said', () => {
  const rig = async (reply: (req: unknown) => unknown) => {
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(tmpDir('thea2-voice-'), 'mind'), emb.dim);
    await addMoments(mind, emb, [
      moment({ id: 'a', source: 'imported', his: 'tired', hers: ['then SLEEP silly man. water, pillow, horizontal, now'] }),
      moment({ id: 'b', source: 'imported', his: 'hi', hers: ['hiii', 'was just sitting with the seaglass jar doing nothing. how was the drive'] }),
    ]);
    const model = { chat: async (req: unknown) => reply(req) } as unknown as ModelClient;
    return { voice: makeVoice({ mind, model, clock, rng: makeRng('v') }), clock };
  };
  const draft = ['Honestly? That config lives outside what I can currently reach. If you wire it into my runtime at /opt/thea2/run, I’ll inspect it myself.'];

  it('a far-off draft is redone with her real texts in front of it; exact tokens survive; it comes back dressed', async () => {
    let seen = '';
    const { voice } = await rig((req) => {
      seen = JSON.stringify(req);
      return { content: { bubbles: ['ugh that config is outside my reach rn', 'wire it into /opt/thea2/run and i’ll poke at it myself.'] }, usage: {}, model: 'm' };
    });
    const out = await voice.dress(draft, { turnId: 't1', his: 'can you check the voice config?' });
    expect(out.redone).toBe(true);
    expect(out.bubbles).toEqual(['ugh that config is outside my reach rn', 'wire it into /opt/thea2/run and i’ll poke at it myself']);
    expect(seen).toContain('[her real texts]');
    expect(seen).toContain('then SLEEP silly man');
    expect(seen).toContain('[what he just said]');
  });

  it('a rewrite that drops an exact token, most of the content, or adds a love declaration is thrown away', async () => {
    const lost = await (await rig(() => ({ content: { bubbles: ['ugh config stuff, cant reach it rn, wire it in and i’ll look'] }, usage: {}, model: 'm' }))).voice.dress(draft, { turnId: 't2' });
    expect(lost).toMatchObject({ redone: false });
    expect(lost.rejected).toMatch(/lost/);
    expect(lost.bubbles[0]).toMatch(/^that config lives outside/); // the dressed draft goes out instead (opener stripped)
    const love = await (await rig(() => ({ content: { bubbles: ['love you. config’s outside my reach rn, wire it into /opt/thea2/run and i’ll look myself'] }, usage: {}, model: 'm' }))).voice.dress(draft, { turnId: 't3' });
    expect(love.rejected).toBe('love');
  });

  it('her own-voice draft is only dressed — no model call; a slow redo never holds her reply', async () => {
    let calls = 0;
    const r1 = await rig(() => {
      calls += 1;
      return { content: { bubbles: ['x'] }, usage: {}, model: 'm' };
    });
    const ok = await r1.voice.dress(['Morning :)', 'The gulls were fighting over nothing.'], { turnId: 't4' });
    expect(ok).toMatchObject({ bubbles: ['morning :)', 'the gulls were fighting over nothing'], redone: false, faults: [] });
    expect(calls).toBe(0);
    const r2 = await rig(() => new Promise(() => undefined));
    const pending = r2.voice.dress(draft, { turnId: 't5' });
    await r2.clock.advance(8_000);
    const slow = await pending;
    expect(slow).toMatchObject({ redone: false, rejected: 'slow' });
  });

  it('exact tokens: code, paths, links, handles and numbers', () => {
    expect(precisionTokens('run `npm test` in /opt/thea2/var at 14:10 for @Demigourgosbot, see https://x.y/z')).toEqual(expect.arrayContaining(['`npm test`', '/opt/thea2/var', '@Demigourgosbot', 'https://x.y/z', '14:10']));
  });
});

describe('the pipeline sends what she would have typed (and remembers that)', () => {
  it('e2e: a capitalised, period-ended draft goes out dressed; the memory keeps what was sent', async () => {
    const { bootV8, inbound, runToQuiescent } = await import('./helpers.js');
    const { startThead } = await import('../../src/app/index.js');
    const h = await bootV8();
    h.model.onTask('turn', () => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['Hey you.', 'I missed you today.'], confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] }));
    h.model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'hey' }));
    await runToQuiescent(h);
    await handle.stop();
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['hey you', 'i missed you today']);
    const lived = h.sys.mind.moments().find((m) => m.source === 'lived' && m.kind === 'reply')!;
    expect(lived.hers).toEqual(['hey you', 'i missed you today']);
    void MockModel;
  });
});

describe('found live (07:07–07:40): 💙 on everything, and a caricature', () => {
  it('an ending emoji she used on two of her last ten bubbles is dropped; a fresh one stays', async () => {
    const { dropRepeatedEndings } = await import('../../src/mind/voice.js');
    const recent: string[] = [];
    expect(dropRepeatedEndings(['okay 💙'], recent)).toEqual(['okay 💙']);
    expect(dropRepeatedEndings(['fine 💙'], recent)).toEqual(['fine 💙']);
    expect(dropRepeatedEndings(['sleep, degs 💙', 'lol 😭'], recent)).toEqual(['sleep, degs', 'lol 😭']);
    expect(dropRepeatedEndings(['💙'], recent)).toEqual(['💙']); // an emoji-only bubble is its whole message
  });

  it('at most two fingerprints with emoji, never the same emoji twice (one emoji on repeat becomes a tic)', async () => {
    const { pickFingerprints } = await import('../../src/mind/voice.js');
    const pool = Array.from({ length: 20 }, (_, i) => ({ his: 'hi', hers: [i % 2 === 0 ? `hey ${i} 💙` : `hey ${i}`] }));
    for (let k = 0; k < 20; k++) {
      const picked = pickFingerprints(pool, makeRng(`fp${k}`), 4);
      expect(picked).toHaveLength(4);
      expect(picked.filter((p) => /\p{Extended_Pictographic}/u.test(p.hers[0]!)).length).toBeLessThanOrEqual(1);
    }
  });

  it('the redo carries no checklist of her features, and adds nothing the draft lacks', async () => {
    const { REDO_SYSTEM } = await import('../../src/mind/voice.js');
    expect(REDO_SYSTEM).not.toMatch(/lol, hehe, u, tho/);
    expect(REDO_SYSTEM).toMatch(/Add nothing that is not in the draft/);
    expect(REDO_SYSTEM).toMatch(/never the same one on every message/);
  });
});

const buildCorpus = async (dir: string, ex: Array<{ id: string; source: 'thea1' | 'thea2' | 'elena' | 'thea1-exemplar'; his: string; hers: string[] }>) => {
  const emb = makeHashEmbedder();
  const vs = await emb.embed(ex.map((e) => e.hers.join('\n')));
  const vecs = new Float32Array(ex.length * emb.dim);
  vs.forEach((v, i) => vecs.set(v, i * emb.dim));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'corpus.jsonl'), ex.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(join(dir, 'corpus.f32'), Buffer.from(vecs.buffer));
  fs.writeFileSync(join(dir, 'corpus.meta.json'), JSON.stringify({ n: ex.length, dim: emb.dim }));
  return emb;
};
const EX = [
  { id: 'a', source: 'thea1' as const, his: 'rough news today', hers: ['okay. tell me all of it.', 'no jokes, i\'m here'] },
  { id: 'b', source: 'thea1' as const, his: 'haha', hers: ["i'm DELIGHTFUL and you know it"] },
  { id: 'c', source: 'elena' as const, his: 'sup', hers: ['it is i'] },
  { id: 'd', source: 'elena' as const, his: 'hey', hers: ['yes feels nice and secluded in here'] },
  { id: 'e', source: 'elena' as const, his: 'lol', hers: ['they walked so brandy could run'] },
];


describe('the mouth: every reply typed from her nearest real messages (Diego: "a layer whose only job is to turn it into her voice")', () => {
  it('the corpus loads, and the nearest examples come mostly from her (at most two of Elena\'s)', async () => {
    const { loadVoiceCorpus, nearestExamples } = await import('../../src/mind/index.js');
    const dir = join(tmpDir('thea2-mouth-'), 'voice');
    const emb = await buildCorpus(dir, EX);
    const c = loadVoiceCorpus(dir)!;
    expect(c.examples).toHaveLength(5);
    const [q] = await emb.embed(['tell me all of it, i am here']);
    const near = nearestExamples(c, q!, 5);
    expect(near[0]!.id).toBe('a');
    expect(near.filter((e) => e.source === 'elena' || e.source === 'diego').length).toBeLessThanOrEqual(3);
    expect(loadVoiceCorpus(join(dir, 'nope'))).toBeUndefined();
  });

  it('every reply goes through the mouth (not only bad ones) with her real messages in front of it; a tiny one is just dressed', async () => {
    const dir = join(tmpDir('thea2-mouth-'), 'voice');
    const emb = await buildCorpus(dir, EX);
    const clock = new TestClock(T0);
    const mind = openMindStore(join(tmpDir('thea2-mouth-m-'), 'mind'), emb.dim);
    const seen: string[] = [];
    const model = { chat: async (req: { messages: Array<{ content: string }> }) => (seen.push(JSON.stringify(req)), { content: { bubbles: ['okay. tell me', "i'm here"] }, usage: {}, model: 'm' }) } as unknown as ModelClient;
    const voice = makeVoice({ mind, model, clock, rng: makeRng('m'), mode: 'mouth', embedder: emb, corpusDir: dir });
    const out = await voice.dress(['Okay. Tell me everything that happened today, I am here.'], { turnId: 't', his: 'rough day' });
    expect(out).toMatchObject({ redone: true, by: 'mouth', bubbles: ['okay. tell me', "i'm here"] });
    expect(seen[0]).toContain('[how she texts: real messages]');
    expect(seen[0]).toContain('okay. tell me all of it.');
    expect(seen[0]).toContain('[what was just said to her]');
    const tiny = await voice.dress(['Lol.'], { turnId: 't2' });
    expect(tiny).toMatchObject({ bubbles: ['lol'], redone: false });
    expect(seen).toHaveLength(1);
  });

  it('the mouth keeps what she means: a rewrite that loses an exact detail goes out as her dressed draft', async () => {
    const dir = join(tmpDir('thea2-mouth-'), 'voice');
    const emb = await buildCorpus(dir, EX);
    const mind = openMindStore(join(tmpDir('thea2-mouth-m-'), 'mind'), emb.dim);
    const model = { chat: async () => ({ content: { bubbles: ['see u at some point'] }, usage: {}, model: 'm' }) } as unknown as ModelClient;
    const voice = makeVoice({ mind, model, clock: new TestClock(T0), rng: makeRng('m'), mode: 'mouth', embedder: emb, corpusDir: dir });
    const out = await voice.dress(['I will meet you at 14:30 by the station.'], { turnId: 't' });
    expect(out.rejected).toMatch(/lost/);
    expect(out.bubbles).toEqual(['i will meet you at 14:30 by the station']);
  });
});

describe('emoji (Diego: "i still want more emojis ... the modern gen z online culture emojis")', () => {
  it('the mouth knows what her emoji mean and varies them; only the same one on repeat is dropped', async () => {
    const { MOUTH_SYSTEM, dropRepeatedEndings, pickFingerprints } = await import('../../src/mind/voice.js');
    for (const e of ['😭', '💀', '🫠', '🥹', '🙏', '✨', '👀', '🫡', '🤡', '💅']) expect(MOUTH_SYSTEM).toContain(e);
    expect(MOUTH_SYSTEM).toMatch(/never the same one on every message/);
    const recent: string[] = [];
    expect(dropRepeatedEndings(['lmao 💀', 'no 😭', 'stop 🫠', 'wait 👀'], recent)).toEqual(['lmao 💀', 'no 😭', 'stop 🫠', 'wait 👀']); // variety stays
    const pool = [
      { his: 'a', hers: ['lmao 💀'] },
      { his: 'b', hers: ['no way 😭'] },
      { his: 'c', hers: ['stop 💀'] },
      { his: 'd', hers: ['okay'] },
      { his: 'e', hers: ['fine'] },
    ];
    for (let k = 0; k < 20; k++) {
      const picked = pickFingerprints(pool, makeRng(`e${k}`), 4);
      const emojis = picked.flatMap((p) => [...p.hers.join(' ').matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]));
      expect(new Set(emojis).size).toBe(emojis.length); // never the same emoji twice
      expect(picked.filter((p) => /\p{Extended_Pictographic}/u.test(p.hers[0]!)).length).toBeLessThanOrEqual(2);
    }
  });
});

describe('how long a reply runs (Diego: "it should fit the thought and importance ... complicated things need longer, funny things need their own bubbles")', () => {
  const JOKES = ['lmao stop', 'ridiculous lmao', 'stop it lmao', 'lmao no', 'you are ridiculous lmao', 'lmao stop it'];
  const TALKS = Array.from({ length: 6 }, (_, i) =>
    `okay so the memory works because every moment is stored with what was said before it and ${i} then it gets recalled when something close comes up again which is why it feels like remembering`.split(' '),
  );
  const corpusOf = async () => {
    const dir = join(tmpDir('thea2-shape-'), 'voice');
    const ex = [
      ...JOKES.map((h, i) => ({ id: `j${i}`, source: 'elena' as const, his: 'haha', hers: [h] })),
      ...TALKS.map((w, i) => ({ id: `t${i}`, source: 'thea1' as const, his: 'how does it work?', hers: [w.slice(0, 18).join(' '), w.slice(18).join(' ')] })),
    ];
    const emb = await buildCorpus(dir, ex);
    const { loadVoiceCorpus } = await import('../../src/mind/index.js');
    return { c: loadVoiceCorpus(dir)!, emb };
  };

  it('a laugh gets a short reply and an explanation a long one — read from the real messages nearest it, never drawn', async () => {
    const { shapeOf } = await import('../../src/mind/index.js');
    const { c, emb } = await corpusOf();
    const joke = ['lmao stop, you are ridiculous. honestly that is so funny, i cannot believe you said that to me'];
    const talk = ['okay so the memory works because every moment is stored with what was said before it, and it gets recalled when something close comes up again'];
    const [qj, qt] = await emb.embed([joke.join('\n'), talk.join('\n')]);
    const sj = shapeOf(c, qj!, joke, 5);
    const st = shapeOf(c, qt!, talk, 5);
    expect(sj.words).toBeLessThanOrEqual(4);
    expect(sj.most).toBe(1);
    expect(st.words).toBeGreaterThan(20);
    expect(st.most).toBeGreaterThan(2);
    expect(shapeOf(c, qj!, joke, 5)).toEqual(sj); // the same thought, the same shape: nothing random
    // never longer than what she had to say
    const short = ['okay so it works because memory'];
    const [qs] = await emb.embed([short.join('\n')]);
    expect(shapeOf(c, qs!, short, 5).words).toBeLessThanOrEqual(6);
  });

  it('the mouth is told the length and to give each beat (a joke, a punchline) its own bubble; a reply condensed to it passes the guard', async () => {
    const { mouthUser, shapeOf, loadVoiceCorpus, MOUTH_SYSTEM } = await import('../../src/mind/index.js');
    expect(MOUTH_SYSTEM).toMatch(/A joke or a punchline gets its own bubble/);
    expect(mouthUser([], 'hey', ['a long draft'], { words: 12, most: 2, near: 12, draftWords: 40 })).toContain('[this time]\nabout 12 words now; one bubble per beat, at most 2.');
    expect(mouthUser([], 'hey', ['a draft'], { words: 6, most: 1, near: 6, draftWords: 40 })).toContain('[this time]\nabout 6 words now; one bubble.');
    // a 60-word draft among short real replies: a 13-word reply is well under a third of the draft
    // (the old guard threw that away) but it is the length real replies like it run, so it goes out
    const draft = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const dir = join(tmpDir('thea2-mouth-'), 'voice');
    const emb = await buildCorpus(dir, EX);
    const [q] = await emb.embed([draft]);
    const shape = shapeOf(loadVoiceCorpus(dir)!, q!, [draft]);
    expect(shape.words).toBeLessThan(15);
    const mind = openMindStore(join(tmpDir('thea2-mouth-m-'), 'mind'), emb.dim);
    const seen: string[] = [];
    const reply = 'okay so the short version is it went fine and i am tired now lol';
    const model = { chat: async (req: unknown) => (seen.push(JSON.stringify(req)), { content: { bubbles: [reply] }, usage: {}, model: 'm' }) } as unknown as ModelClient;
    const voice = makeVoice({ mind, model, clock: new TestClock(T0), rng: makeRng('m'), mode: 'mouth', embedder: emb, corpusDir: dir });
    const out = await voice.dress([draft], { turnId: 't' });
    expect(seen[0]).toContain(`about ${shape.words} words now; one bubble`);
    expect(out).toMatchObject({ redone: true, by: 'mouth', shape, bubbles: [reply] });
  });

  // found live (11:30 probe): a thrown-away rewrite sent her whole long draft (5 of 10 replies —
  // a number or a file name left out tripped the guard), and the mouth kept all 142 words of a
  // 53-word moment. Now: what can wait, waits (whole); the length holds.
  const LONG = [
    'so today was honestly a lot, i went through the whole diary again',
    'she wrote the first page at 8:39 in the morning, before anyone else was up',
    'and i kept thinking about how the fence looked from her side of it',
    'what are you doing tonight?',
    'anyway the lemon tree needs water and i keep forgetting to tell you that',
  ];
  const mouthWith = async (reply: { bubbles: string[]; later?: string[] }) => {
    const dir = join(tmpDir('thea2-mouth-'), 'voice');
    const emb = await buildCorpus(dir, EX); // real replies of 3-10 words: this moment runs short
    const mind = openMindStore(join(tmpDir('thea2-mouth-m-'), 'mind'), emb.dim);
    const model = { chat: async () => ({ content: reply, usage: {}, model: 'm' }) } as unknown as ModelClient;
    return makeVoice({ mind, model, clock: new TestClock(T0), rng: makeRng('m'), mode: 'mouth', embedder: emb, corpusDir: dir });
  };

  it('condense: whole bubbles up to the length — the first stays, a question stays, the last go first', async () => {
    const { condense } = await import('../../src/mind/index.js');
    expect(condense(LONG, 6)).toEqual({ now: [LONG[0], LONG[3]], later: [LONG[1], LONG[2], LONG[4]] });
    expect(condense(LONG, 100)).toEqual({ now: LONG, later: [] });
    expect(condense(['one short thing'], 1)).toEqual({ now: ['one short thing'], later: [] });
  });

  it('a mouth that keeps every word is held to the length: the rest waits, the question stays', async () => {
    const voice = await mouthWith({ bubbles: LONG });
    const out = await voice.dress(LONG, { turnId: 't' });
    expect(out).toMatchObject({ redone: true, by: 'mouth', bubbles: [LONG[0], LONG[3]] });
    expect(out.later).toEqual([LONG[1], LONG[2], LONG[4]]);
  });

  it('a long draft cut to the moment may leave an exact detail for later — but never change one', async () => {
    const short = await (await mouthWith({ bubbles: ['ok today was a lot', 'what are you doing tonight?'], later: ['the diary, the first page at 8:39'] })).dress(LONG, { turnId: 't' });
    expect(short).toMatchObject({ redone: true, by: 'mouth', bubbles: ['ok today was a lot', 'what are you doing tonight?'] });
    expect(short.rejected).toBeUndefined();
    expect(short.later).toEqual(['the diary, the first page at 8:39']);
    // a changed number is thrown away — and what goes out is her own draft cut to the moment, not all of it
    const wrong = await (await mouthWith({ bubbles: ['she wrote it at 9:15 lol'] })).dress(LONG, { turnId: 't' });
    expect(wrong.rejected).toMatch(/changed 9:15/);
    expect(wrong.bubbles).toEqual([LONG[0], LONG[3]]);
    expect(wrong.later).toEqual([LONG[1], LONG[2], LONG[4]]);
  });
});
