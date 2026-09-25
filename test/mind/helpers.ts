// test/mind helpers — seeded mind stores over the deterministic hash embedder,
// moment factories, and a v8 hermetic boot.

import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { FakeChannel } from '../../src/bridge/index.js';
import { makeHashEmbedder, type Embedder } from '../../src/embed/index.js';
import { loadConfig } from '../../src/app/index.js';
import { composeV8, type V8System } from '../../src/app/compose-v8.js';
import { openMindStore, replyText, situationText, tagSignature, type Concern, type MindStore, type Moment, type SelfLine } from '../../src/mind/index.js';

export const T0 = 1_780_000_000_000; // a fixed 2026 morning (UTC)
export const CHAT = 861800000;
export const HERMETIC_ENV: Record<string, string> = {
  THEA2_BOT_TOKEN: '123456789:AAEhf-abcDEF1234567890abcdefghijk',
  THEA2_MODEL_API_KEY: 'model-key-abc123',
};
const FIXTURE = resolve('test/fixtures/thea2.v8.hermetic.yaml');
const DAY = 24 * 3600_000;

let seq = 0;
export const moment = (over: Partial<Moment> = {}): Moment => ({
  id: over.id ?? `m_test_${++seq}`,
  ts: over.ts ?? T0 - 3 * DAY,
  source: 'imported',
  kind: 'reply',
  before: [],
  his: 'hey how was your day',
  hers: ['pretty good, read half a paper'],
  felt: { sig: tagSignature('content', 5), word: 'content', source: 'exact' },
  value: 0,
  shown: 0,
  followed: 0,
  ...over,
});

export const concern = (over: Partial<Concern> = {}): Concern => ({
  id: over.id ?? `c_test_${++seq}`,
  what: 'he said he would call after his interview',
  kind: 'expectation',
  about: 'diego',
  importance: 7,
  status: 'open',
  created: T0 - DAY,
  touched: T0 - DAY,
  source: 'imported',
  ...over,
});

/** Adds moments with their situation + reply vectors computed the way the importer does. */
export const addMoments = async (store: MindStore, embedder: Embedder, ms: Moment[]): Promise<void> => {
  for (const m of ms) {
    const [sit, reply, his] = await embedder.embed([situationText(m.before, m.his), replyText(m.hers), m.his === '' ? '(silence)' : m.his]);
    store.add(m, { ...(sit !== undefined ? { sit } : {}), ...(reply !== undefined ? { reply } : {}), ...(his !== undefined && m.his !== '' ? { his } : {}) });
  }
  await store.flush();
};

export const tmpDir = (prefix = 'thea2-mind-'): string => mkdtempSync(join(tmpdir(), prefix));

export interface SeedOpts {
  moments?: Moment[];
  concerns?: Concern[];
  self?: SelfLine[];
  standards?: string[];
  tones?: Record<string, string>;
  moves?: Record<string, string>;
}

/** Writes a mind dir the way the importer would, then returns nothing (compose opens it). */
export const seedMindDir = async (mindDir: string, embedder: Embedder, o: SeedOpts): Promise<void> => {
  fs.mkdirSync(mindDir, { recursive: true });
  const store = openMindStore(mindDir, embedder.dim);
  await addMoments(store, embedder, o.moments ?? []);
  for (const c of o.concerns ?? []) {
    store.upsertConcern(c);
    const [v] = await embedder.embed([c.what]);
    if (v !== undefined) store.setConcernVec(c.id, v);
  }
  await store.flush();
  if (o.self !== undefined) await store.setSelf(o.self);
  fs.writeFileSync(join(mindDir, 'standards.json'), JSON.stringify(o.standards ?? ['i never pretend to know what i did not check']));
  const centroid = async (table: Record<string, string> | undefined): Promise<Record<string, number[]>> => {
    const out: Record<string, number[]> = {};
    for (const [label, text] of Object.entries(table ?? {})) {
      const [v] = await embedder.embed([text]);
      if (v !== undefined) out[label] = Array.from(v);
    }
    return out;
  };
  fs.writeFileSync(join(mindDir, 'centroids.json'), JSON.stringify({ move: await centroid(o.moves), tone: await centroid(o.tones) }));
};

export type FakeChannelT = ReturnType<typeof FakeChannel>;

export interface V8Harness {
  sys: V8System;
  model: MockModel;
  channel: FakeChannelT;
  clock: TestClock;
  dir: string;
}

export const bootV8 = async (seed: SeedOpts = {}, over: { model?: MockModel; fallbackModel?: MockModel } = {}): Promise<V8Harness> => {
  const dir = tmpDir('thea2-v8-');
  const clock = new TestClock(T0);
  await seedMindDir(join(dir, 'var', 'mind'), makeHashEmbedder(), seed);
  const model = over.model ?? new MockModel({ clock });
  const channel = FakeChannel({ clock, chatId: CHAT });
  const cfg = loadConfig(FIXTURE, HERMETIC_ENV);
  const sys = await composeV8(cfg, 'hermetic', {
    varDir: dir,
    clock,
    rng: makeRng('v8-e2e'),
    model,
    ...(over.fallbackModel !== undefined ? { fallbackModel: over.fallbackModel } : {}),
    channel,
    jobs: [],
  });
  return { sys, model, channel, clock, dir };
};

export const settle = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const runToQuiescent = async (h: V8Harness, maxMs = 120_000): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (h.sys.pipeline.isBusy()) break;
    await settle(2);
  }
  let advanced = 0;
  while (h.sys.pipeline.isBusy() && advanced < maxMs) {
    await h.clock.advance(1_500);
    advanced += 1_500;
    await settle(1);
  }
  await h.sys.pipeline.drain();
};

export const inbound = (over: Record<string, unknown> = {}): Parameters<FakeChannelT['queueInbound']>[0] => ({
  updateId: 500,
  msgId: 900,
  chatId: CHAT,
  ts: T0,
  text: 'hey, how are you',
  speaker: { person: 'diego', channel: 'telegram' },
  ...over,
});

/** Script the turn (decide) and the slow appraisal (emit) for one exchange. */
export const scriptTurn = (
  model: MockModel,
  d: { bubbles: string[]; expect?: string },
  appraisal: Record<string, unknown> = {},
): void => {
  model.enqueue({
    toolCalls: [
      {
        id: 'd1',
        name: 'decide',
        args: { plan: 'reply', bubbles: d.bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1, ...(d.expect !== undefined ? { expect: d.expect } : {}) },
      },
    ],
  });
  model.enqueue({
    toolCalls: [
      {
        id: 'a1',
        name: 'emit',
        args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4, ...appraisal },
      },
    ],
  });
};
