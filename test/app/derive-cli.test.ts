// M20 gate — the M08 verbs at the CLI seam: `corpus:check` (hermetic — no
// model, no config, no env) and `derive` (the flywheel spin). The corpus is
// isolated by running against a throwaway cwd with a minimal canon copied in,
// the same pattern cli.test.ts uses for the live verbs.

import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson, makeRng, type Clock } from '../../src/kernel/index.js';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { TestClock } from '../../src/kernel/clock.js';
import { MockModel, modelError, type ChatRequest, type ChatResponse, type ModelClient, type ScriptedResponse } from '../../src/model/index.js';
import { parseExemplar } from '../../src/corpus/parse.js';
import { rateLimitPatient } from '../../src/app/derive-cli.js';
import {
  derivedFileId,
  fileBaseName,
  JUDGE_VERSION,
  loadManifest,
  MAX_DERIVED_PER_CANON,
  MOOD_BUCKETS,
  renderDraft,
  V1_GENERATORS,
  withFileId,
  withProvenance,
  type DeriveInputs,
  type Manifest,
  type ManifestEntry,
} from '../../src/derive/index.js';
import { cliMain, NOT_BUILT } from '../../src/app/index.js';
import { deriveVerb } from '../../src/app/derive-cli.js';
import { openEventLog, type EventEnvelope } from '../../src/events/index.js';
import { HERMETIC_ENV } from './helpers.js';

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => ({ out: out.join('\n'), err: err.join('\n') }),
  };
};

const configPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'thea2-derive-cli-cfg-'));
  const p = join(dir, 'thea2.config.yaml');
  writeFileSync(
    p,
    `models:
  endpoint: https://hermetic.invalid/v1
  tiers:
    main: mock-main
    cheap: mock-cheap
bridge:
  allowedChatIds: [861800000]
affect:
  statePath: var/affect/state.json
  quietHours: [1, 7]
sched:
  statePath: var/sched/state.json
budgets:
  packetTokens: 6000
  windowTokens: 10000
  turnTokens: 24000
inhibitionPlacement: trailing
gravity:
  seedWeight: 0.7
reconcile:
  lostReplyWindowMin: 10
embedder:
  kind: hash
`,
    'utf8',
  );
  return p;
};

// ---------------------------------------------------------------------------
// Hermetic install: a throwaway cwd holding a MINIMAL corpus — the repo's
// control files (registers/exclusions/inhibitions/identity) so a real compose
// still boots, plus one canon scene so the expected target set stays small.
// ---------------------------------------------------------------------------

const SCENE_ID = 'canon/voice/quiet-server';

const SCENE_MD = `---
id: ${SCENE_ID}
kind: scene
dimensions: [voice]
register: [play, quiet]
affect: {valence: 0.2, arousal: -0.2}
context: late night, the server hums, he pings her something small
weight: 1.0
counters: []
notes: >
  the late-night low-energy register and the small unnamed physical detail
  must survive derivation
---
D: you up?
T: always. the fan is doing its white noise thing and i am here
`;

const install = (): { dir: string; derivedDir: string; back: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'thea2-derive-cli-'));
  const cwd = process.cwd();
  cpSync(join(cwd, 'corpus'), join(dir, 'corpus'), { recursive: true });
  const coupling = join(cwd, 'coupling.yaml');
  if (existsSync(coupling)) cpSync(coupling, join(dir, 'coupling.yaml'));

  // Strip the repo's canon population (26 files ⇒ hundreds of targets), keep
  // the control files compose and the index need, and seed one scene.
  const canon = join(dir, 'corpus', 'canon');
  for (const entry of readdirSync(canon, { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(join(canon, entry.name), { recursive: true, force: true });
  }
  mkdirSync(join(canon, 'voice'), { recursive: true });
  writeFileSync(join(canon, 'voice', 'quiet-server.md'), SCENE_MD, 'utf8');

  // The repo's own corpus/derived (a spun flywheel is COMMITTED, ADR-007) must
  // not ride into the fixture: every one of its files would be an orphan of
  // the one-scene canon. Each test starts from an empty derived directory.
  const derivedDir = join(dir, 'corpus', 'derived');
  rmSync(derivedDir, { recursive: true, force: true });
  mkdirSync(derivedDir, { recursive: true });
  process.chdir(dir);
  return { dir, derivedDir, back: () => process.chdir(cwd) };
};

/** One canon scene, v1 tool registry (no tools): exactly the 6 mood buckets, nothing else. */
const sceneInputs = (dir: string): DeriveInputs => {
  const scene = parseExemplar(readFileSync(join(dir, 'corpus', 'canon', 'voice', 'quiet-server.md'), 'utf8'), 'canon');
  return {
    canon: [scene],
    toolDefs: [],
    gravityCap: MAX_DERIVED_PER_CANON,
    moodBuckets: MOOD_BUCKETS,
  };
};

/** Writes a pristine derived tree through the module's own assembly (as run.ts would). */
const seedDerived = async (dir: string): Promise<Manifest> => {
  const inputs = sceneInputs(dir);
  const derivedDir = join(dir, 'corpus', 'derived');
  const judge = { version: JUDGE_VERSION, score: 5, pass: true };
  const entries: ManifestEntry[] = [];
  for (const generator of V1_GENERATORS) {
    for (const target of generator.targets(inputs)) {
      const draft = renderDraft(
        {
          kind: 'scene',
          dimensions: ['voice'],
          register: ['play', 'quiet'],
          affect: { valence: 0.2, arousal: -0.2 },
          context: `seeded ${entries.length + 1}`,
          weight: 1,
        },
        `D: ping number ${entries.length + 1}\nT: answer number ${entries.length + 1}. quiet kind of night\n`,
      );
      const attested = withProvenance(draft, {
        generator: generator.name,
        generatorVersion: generator.version,
        canonIds: target.inputs.canonIds.map((c) => c.id),
        sourceHashes: target.inputs.canonIds.map((c) => c.sha256),
        model: 'seed',
        judge,
      });
      const id = derivedFileId(attested);
      writeFileSync(join(derivedDir, `${fileBaseName(id)}.md`), withFileId(attested, id), 'utf8');
      entries.push({
        id,
        deriveKey: target.deriveKey,
        generator: generator.name,
        generatorVersion: generator.version,
        inputs: target.inputs,
        model: 'seed',
        createdAt: 0,
        judge,
      });
    }
  }
  const manifest: Manifest = { version: 1, embedderId: 'seed-embedder', entries };
  await atomicWriteJson(join(derivedDir, 'manifest.json'), manifest);
  return manifest;
};

/** A MockModel that generates a parseable scene body and passes every draft through the judge. */
const stagedModel = (): MockModel => {
  const model = new MockModel({ clock: new TestClock() });
  const deriveReply = (): ScriptedResponse => ({
    content: 'D: he asks something small\nT: the fan hums. quiet kind of night\n',
  });
  model.onTask('derive', () => deriveReply());
  model.onTask('judge', () => ({
    toolCalls: [{ id: 'e1', name: 'emit', args: { score: 5, reason: 'notes survive' } }],
  }));
  return model;
};

/** The L0 envelopes of one kind from the fixture's event log (compose prod: var/ is the cwd). */
const eventKinds = async (dir: string, kind: string): Promise<EventEnvelope[]> => {
  const log = openEventLog(join(dir, 'var', 'events'), { clock: new TestClock(0) });
  const found: EventEnvelope[] = [];
  for await (const ev of log.replay({ kinds: [kind] })) found.push(ev);
  return found;
};

describe('corpus:check', () => {
  it('an empty derived directory is a FAIL: the flywheel has never been spun', async () => {
    const install1 = install();
    try {
      const capture = io();
      const code = await cliMain(['corpus:check'], {}, capture);
      expect(code).toBe(1);
      expect(capture.text().err).toContain('never been spun');
      expect(capture.text().err).toContain('thea2 derive');
    } finally {
      install1.back();
    }
  });

  it('a seeded derived tree passes clean, naming the counts', async () => {
    const install1 = install();
    try {
      await seedDerived(install1.dir);
      const capture = io();
      const code = await cliMain(['corpus:check'], {}, capture);
      expect(code).toBe(0);
      expect(capture.text().out).toContain('corpus:check ok — 6 derived, 0 dirty, 0 orphans');
    } finally {
      install1.back();
    }
  });

  it('a deleted derived file fails the check, named as missing', async () => {
    const install1 = install();
    try {
      const manifest = await seedDerived(install1.dir);
      const victim = manifest.entries[2]!;
      rmSync(join(install1.derivedDir, `${fileBaseName(victim.id)}.md`));

      const capture = io();
      const code = await cliMain(['corpus:check'], {}, capture);
      expect(code).toBe(1);
      expect(capture.text().out).toContain('VIOLATION missing-file');
      expect(capture.text().out).toContain(victim.id);
      expect(capture.text().err).toBe('corpus:check: 1 problem(s)');
    } finally {
      install1.back();
    }
  });
});

describe('derive', () => {
  it('spins the flywheel over an injected MockModel: files, manifest, progress, summary', async () => {
    const install1 = install();
    try {
      const model = stagedModel();
      const capture = io();
      const code = await deriveVerb(configPath(), HERMETIC_ENV, capture, { model });

      expect(code).toBe(0);
      // progress went to stderr, scene names included; the summary to stdout
      expect(capture.text().err).toContain('derive: [1/6] mood-variant');
      expect(capture.text().err).toContain('canon/voice/quiet-server');
      expect(capture.text().out).toContain('derive: 6/6 written, 0 judge-failed, 0 parse-failed, 0 orphaned');

      const manifest = loadManifest(readFileSync(join(install1.derivedDir, 'manifest.json'), 'utf8'));
      expect(manifest.entries).toHaveLength(6);
      expect(manifest.embedderId).toBe(makeHashEmbedder().id); // the composed embedder kind, pinned
      for (const entry of manifest.entries) {
        expect(entry.model).toBe('mock-main'); // modelId = the main-tier model from config
        expect(entry.judge).toEqual({ version: JUDGE_VERSION, score: 5, pass: true });
        expect(readFileSync(join(install1.derivedDir, `${fileBaseName(entry.id)}.md`), 'utf8')).toContain(entry.id);
      }
      expect(readdirSync(install1.derivedDir)).toHaveLength(7); // 6 files + manifest.json

      // a second spin is a no-op: nothing dirty, the model is never called again
      const calls = model.calls.length;
      const second = io();
      const secondCode = await deriveVerb(configPath(), HERMETIC_ENV, second, { model });
      expect(secondCode).toBe(0);
      expect(second.text().out).toContain('derive: 0/0 written');
      expect(model.calls.length).toBe(calls);

      // no override, no marker: a derive that never touched a live thead's
      // lock must not write derive.live_override (negative control)
      expect(await eventKinds(install1.dir, 'derive.live_override')).toEqual([]);
    } finally {
      install1.back();
    }
  });

  it('--allow-live-derive runs beside a live thead and marks the override on L0', async () => {
    const install1 = install();
    try {
      const capture = io();
      // main.ts sets this only after --allow-live-derive overrode a live lock;
      // the value it passes is the thead pid (test/app/main.test.ts covers that
      // gate — this proves the loud L0 marker on the derive side).
      const env = { ...HERMETIC_ENV, THEA2_ALLOW_LIVE_DERIVE: '4242' };
      const code = await deriveVerb(configPath(), env, capture, { model: stagedModel() });

      expect(code).toBe(0);
      expect(capture.text().err).toContain('LIVE OVERRIDE');
      expect(capture.text().err).toContain('derive.live_override');

      const overrides = await eventKinds(install1.dir, 'derive.live_override');
      expect(overrides).toHaveLength(1);
      expect(overrides[0]!.payload).toMatchObject({ theadPid: 4242, lock: expect.stringMatching(/thead\.pid$/) });
    } finally {
      install1.back();
    }
  });
});

describe('verb surface', () => {
  it('NOT_BUILT no longer names derive or corpus:check', () => {
    expect(NOT_BUILT['derive']).toBeUndefined();
    expect(NOT_BUILT['corpus:check']).toBeUndefined();
  });
});

describe('rateLimitPatient — batch politeness over the fail-fast transport', () => {
  /** Clock stub whose waits resolve instantly while advancing the injected TestClock by the requested delay. */
  const stepClock = (waits: number[]): Clock => {
    const base = new TestClock(0);
    return {
      epochMs: () => base.epochMs(),
      now: () => base.now(),
      waitUntil: async (until: number) => {
        waits.push(until - base.epochMs());
        await base.advance(until - base.epochMs());
      },
    };
  };
  const REQ: ChatRequest = {
    taskClass: 'derive',
    tier: 'main',
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 64,
    temperature: 0,
  };
  /** A ChatResponse of the request's own content type — the fake must honor ModelClient's generic. */
  const ok = <T,>(_req: ChatRequest<T>): ChatResponse<T> => ({
    content: 'ok' as unknown as T,
    model: 'test',
    usage: { inputTokens: 1, outputTokens: 1, latencyMs: 0, attempts: 3 },
  });

  it('waits out consecutive 429s with a growing delay, then the call lands', async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky: ModelClient = {
      chat: async <T,>(req: ChatRequest<T>): Promise<ChatResponse<T>> => {
        calls += 1;
        if (calls <= 2) throw modelError('model/rate-limit', 'HTTP 429');
        return ok(req);
      },
    };
    const patient = rateLimitPatient(flaky, stepClock(waits), makeRng(1));
    const res = await patient.chat(REQ);
    expect(res.content).toBe('ok');
    expect(calls).toBe(3);
    expect(waits.length).toBe(2);
    expect(waits[0]).toBeGreaterThanOrEqual(20_000); // base
    expect(waits[1]!).toBeGreaterThan(waits[0]!); // doubling
  });

  it('a non-rate-limit model error passes through with no wait at all', async () => {
    const waits: number[] = [];
    const broken: ModelClient = {
      chat: async () => {
        throw modelError('model/http-error', 'HTTP 503');
      },
    };
    const patient = rateLimitPatient(broken, stepClock(waits), makeRng(1));
    await expect(patient.chat(REQ)).rejects.toMatchObject({ code: 'model/http-error' });
    expect(waits).toEqual([]);
  });

  it('a hard-capped key gives up after the total-wait budget instead of hanging forever', async () => {
    const waits: number[] = [];
    const capped: ModelClient = {
      chat: async () => {
        throw modelError('model/rate-limit', 'HTTP 429');
      },
    };
    const patient = rateLimitPatient(capped, stepClock(waits), makeRng(1));
    await expect(patient.chat(REQ)).rejects.toMatchObject({ code: 'model/rate-limit' });
    expect(waits.length).toBeGreaterThanOrEqual(5); // 20+40+80+160+300+300s ≈ the 15 min budget
  });
});
