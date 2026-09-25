// v9 body test harness: scripted OpenAI senses, a scripted process runner
// (ffmpeg/ffprobe/pdftotext write what the real ones would), and a v9 boot
// through composeV8 with a FakeChannel that serves files.

import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { FakeChannel } from '../../src/bridge/index.js';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { loadConfig } from '../../src/app/index.js';
import { composeV8 } from '../../src/app/compose-v8.js';
import type { Exec, Fal, OpenAIBody } from '../../src/body/index.js';
import { CHAT, HERMETIC_ENV, seedMindDir, T0, tmpDir, type SeedOpts, type V8Harness } from '../mind/helpers.js';

export const V9_ENV: Record<string, string> = { ...HERMETIC_ENV, THEA2_TEST_OPENAI: 'sk-test-body-0123456789' };
const FIXTURE = resolve('test/fixtures/thea2.v9.hermetic.yaml');

export interface FakeOpenAI extends OpenAIBody {
  calls: Array<{ op: string; detail: string }>;
}

export const fakeOpenAI = (over: Partial<Record<'vision' | 'transcribe' | 'listen', string>> = {}): FakeOpenAI => {
  const calls: FakeOpenAI['calls'] = [];
  return {
    calls,
    vision: async (images, prompt) => {
      calls.push({ op: 'vision', detail: `${images.length} image(s): ${prompt.slice(0, 40)}` });
      return over.vision ?? 'a sunset over rice terraces, the sky orange and pink, a scooter parked in front';
    },
    transcribe: async (_b, filename) => {
      calls.push({ op: 'transcribe', detail: filename });
      return over.transcribe ?? "hey it's me. long day, i'm finally home";
    },
    listen: async () => {
      calls.push({ op: 'listen', detail: '' });
      return over.listen ?? 'tired and slow, a scooter passing in the background.';
    },
    speak: async (text) => {
      calls.push({ op: 'speak', detail: text });
      return new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]);
    },
  };
};

/** ffmpeg writes its output (the last arg); ffprobe says 4.2 s; pdftotext prints pages split by form feeds. */
export const fakeExec = (pdfText = 'Chapter one\nThe codex opens here.\fChapter two\nMore.'): Exec & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push(`${cmd} ${args.slice(-1)[0] ?? ''}`);
      if (cmd === 'ffmpeg') {
        const out = args[args.length - 1]!;
        fs.writeFileSync(out, new Uint8Array(4000).fill(7));
        return { code: 0, stdout: new Uint8Array(), stderr: '' };
      }
      if (cmd === 'ffprobe') return { code: 0, stdout: new TextEncoder().encode('4.2\n'), stderr: '' };
      if (cmd === 'pdftotext') return { code: 0, stdout: new TextEncoder().encode(pdfText), stderr: '' };
      return { code: 1, stdout: new Uint8Array(), stderr: `${cmd}: not scripted` };
    },
  };
};

export const FILES: Record<string, Uint8Array> = {
  photo1: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]),
  voice1: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 9]),
  doc1: new TextEncoder().encode('the codex, draft 3\n\n' + 'a line of the codex. '.repeat(200)),
  pdf1: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  video1: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
};

export interface V9Harness extends V8Harness {
  openai: FakeOpenAI;
  exec: ReturnType<typeof fakeExec>;
}

/** fal, scripted: images come back as tiny jpegs; `fail` makes every call throw. */
export const fakeFal = (opts: { fail?: string } = {}): Fal & { calls: Array<{ model: string; input: Record<string, unknown> }> } => {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    image: async (model, input) => {
      calls.push({ model, input });
      if (opts.fail !== undefined) throw new Error(opts.fail);
      return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), url: 'https://fal.invalid/x.jpg', seed: 7 };
    },
    video: async (model, input) => {
      calls.push({ model, input });
      if (opts.fail !== undefined) throw new Error(opts.fail);
      return { bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), url: 'https://fal.invalid/x.mp4' };
    },
  };
};

export const bootV9 = async (seed: SeedOpts = {}, over: { openai?: FakeOpenAI; fetchImpl?: typeof fetch; fal?: Fal } = {}): Promise<V9Harness> => {
  const dir = tmpDir('thea2-v9-');
  const clock = new TestClock(T0);
  await seedMindDir(join(dir, 'var', 'mind'), makeHashEmbedder(), seed);
  const model = new MockModel({ clock });
  const channel = FakeChannel({ clock, chatId: CHAT, files: FILES });
  const cfg = loadConfig(FIXTURE, V9_ENV);
  const openai = over.openai ?? fakeOpenAI();
  const exec = fakeExec();
  const sys = await composeV8(cfg, 'hermetic', {
    varDir: dir,
    clock,
    rng: makeRng('v9-e2e'),
    model,
    channel,
    jobs: [],
    bodyOpenAI: openai,
    bodyExec: exec,
    ...(over.fal !== undefined ? { bodyFal: over.fal } : {}),
    ...(over.fetchImpl !== undefined ? { fetchImpl: over.fetchImpl } : {}),
  });
  return { sys, model, channel, clock, dir, openai, exec };
};

/** Open-Meteo + BigDataCloud, scripted. */
export const whereFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes('bigdatacloud')) {
    return new Response(JSON.stringify({ locality: 'Ubud', principalSubdivision: 'Bali', countryName: 'Indonesia' }), { status: 200 });
  }
  if (url.includes('open-meteo')) {
    return new Response(JSON.stringify({ timezone: 'Asia/Makassar', current: { temperature_2m: 27.4, weather_code: 61, is_day: 0 } }), { status: 200 });
  }
  return new Response('not scripted', { status: 404 });
};
