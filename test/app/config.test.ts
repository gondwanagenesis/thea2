import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, secretShaped, ConfigError } from '../../src/app/config.js';

const writeCfg = (yaml: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'thea2-cfg-'));
  const p = join(dir, 'thea2.config.yaml');
  writeFileSync(p, yaml, 'utf8');
  return p;
};

const VALID_YAML = `models:
  endpoint: https://api.example.com/v1
  tiers:
    main: main-model
    cheap: cheap-model
bridge:
  allowedChatIds: [123456]
affect:
  statePath: var/affect.json
  quietHours: [1, 7]
sched:
  statePath: var/sched.json
budgets:
  packetTokens: 3000
  windowTokens: 6000
  turnTokens: 6000
inhibitionPlacement: trailing
gravity:
  seedWeight: 0.7
reconcile:
  lostReplyWindowMin: 20
embedder:
  kind: hash
`;

const VALID_ENV: Record<string, string> = {
  THEA2_BOT_TOKEN: '123456789:AAEhf-abcDEF1234567890abcdefghijk',
  THEA2_MODEL_API_KEY: 'model-key-abc123',
};

const cfg = (yaml: string, env: Record<string, string | undefined> = VALID_ENV) =>
  loadConfig(writeCfg(yaml), env);

/** Runs loadConfig and returns the ConfigError it throws (fails the test if it doesn't). */
const reject = (yaml: string, env: Record<string, string | undefined> = VALID_ENV): ConfigError => {
  try {
    cfg(yaml, env);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected loadConfig to throw ConfigError');
};

describe('loadConfig accepts a valid config', () => {
  it('parses and merges env secrets', () => {
    const c = cfg(VALID_YAML);
    expect(c.bridge.botToken).toBe(VALID_ENV['THEA2_BOT_TOKEN']);
    expect(c.models.tiers.main).toBe('main-model');
    expect(c.gravity.seedWeight).toBe(0.7);
  });

  it('applies spec defaults (gravity 0.7, reasoning tier optional, embedder model optional)', () => {
    const c = cfg(VALID_YAML.replace('gravity:\n  seedWeight: 0.7\n', ''));
    expect(c.gravity.seedWeight).toBe(0.7);
    expect(c.models.tiers.reasoning).toBeUndefined();
    expect(c.embedder.model).toBeUndefined();
  });

  it('falls back to ZAI_API_KEY when THEA2_MODEL_API_KEY is absent', () => {
    const c = cfg(VALID_YAML, { ...VALID_ENV, THEA2_MODEL_API_KEY: undefined, ZAI_API_KEY: 'legacy' });
    expect(c.models.apiKey).toBe('legacy');
  });
});

describe('loadConfig reject table (typed errors naming the path)', () => {
  it('missing required yaml field', () => {
    const err = reject(VALID_YAML.replace('sched:\n  statePath: var/sched.json\n', ''));
    expect(err.issues.some((i) => i.path.includes('sched'))).toBe(true);
  });

  it('unknown key at any depth (strict)', () => {
    expect(reject(VALID_YAML + 'sneakyExtra: 1\n').code).toBe('app/config-unknown-key');
  });

  it('secret-shaped value in yaml — the telegram token itself', () => {
    expect(
      reject(VALID_YAML.replace('bridge:\n', `bridge:\n  botToken: ${VALID_ENV['THEA2_BOT_TOKEN']}\n`))
        .code,
    ).toBe('app/config-secret-in-yaml');
  });

  it('secret-shaped value in yaml — any sk- style key material anywhere', () => {
    expect(
      reject(VALID_YAML.replace('kind: hash', 'kind: hash\n  model: sk-realkeyvalue123456789abcdef'))
        .code,
    ).toBe('app/config-secret-in-yaml');
  });

  it('bad quiet hours: out of range', () => {
    const err = reject(VALID_YAML.replace('quietHours: [1, 7]', 'quietHours: [1, 24]'));
    expect(err.issues.some((i) => i.path.join('.').includes('quietHours'))).toBe(true);
  });

  it('rejects equal endpoints ([7, 7] is ambiguous — no window or all day)', () => {
    expect(reject(VALID_YAML.replace('quietHours: [1, 7]', 'quietHours: [7, 7]')).code).toBe(
      'app/config-invalid',
    );
  });

  it('gravity g outside [0,1]', () => {
    const err = reject(VALID_YAML.replace('seedWeight: 0.7', 'seedWeight: 1.4'));
    expect(err.issues.some((i) => i.path.join('.').includes('seedWeight'))).toBe(true);
  });

  it('missing THEA2_BOT_TOKEN in env', () => {
    const err = reject(VALID_YAML, { THEA2_MODEL_API_KEY: 'k' });
    expect(err.issues.some((i) => i.path.join('.').includes('botToken'))).toBe(true);
  });

  it('non-integer chat id', () => {
    expect(reject(VALID_YAML.replace('allowedChatIds: [123456]', 'allowedChatIds: [12.5]')).code).toBe(
      'app/config-invalid',
    );
  });

  it('malformed yaml names the file', () => {
    const err = reject('models: [unclosed\n  bad');
    expect(err.code).toBe('app/config-unreadable');
    expect(err.yamlPath).toMatch(/thea2\.config\.yaml$/);
  });
});

describe('timezone and quietHours (Phase 1 — his day, not Greenwich day)', () => {
  it('timezone defaults to UTC', () => {
    expect(cfg(VALID_YAML).timezone).toBe('UTC'); // fixtures stay byte-identical: no timezone key, UTC behavior
  });

  it('rejects an unknown IANA zone (a typo would silently become UTC)', () => {
    const err = reject(VALID_YAML + 'timezone: Europa/Madri\n');
    expect(err.code).toBe('app/config-invalid');
    expect(err.issues.some((i) => i.path.includes('timezone'))).toBe(true);
  });

  it('accepts a wrapping quietHours window (start > end wraps past midnight)', () => {
    const c = cfg(VALID_YAML.replace('quietHours: [1, 7]', 'quietHours: [23, 8]'));
    expect(c.affect.quietHours).toEqual([23, 8]);
  });
});

describe('secretShaped (the detector, unit-level)', () => {
  it('flags telegram bot tokens', () => {
    expect(secretShaped('123456789:AAEhf-abcDEF1234567890abcdefghijk')).toBe(true);
  });
  it('flags sk- prefixed keys', () => {
    expect(secretShaped('sk-proj-abcdefgh1234567890')).toBe(true);
  });
  it('flags long high-entropy blobs', () => {
    expect(secretShaped('Ab3xY9_kQ-7sT2vLmNoPqR5uW8zA1bC4d')).toBe(true);
  });
  it('does not flag ordinary config values', () => {
    expect(secretShaped('main-model')).toBe(false);
    expect(secretShaped('https://api.example.com/v1')).toBe(false);
    expect(secretShaped('var/affect.json')).toBe(false);
    expect(secretShaped('fastembed')).toBe(false);
    expect(secretShaped('PLACEHOLDER_NEW_BOT_TOKEN')).toBe(false);
  });
});

// ——— P-DOOR DR.1: the door registry ————————————————————————————————————

/** The four default doors, byte-for-byte what thea2.config.yaml ships (D.6-1/D.6-2). */
const DOORS_YAML = `models:
  doors:
    voice:
      endpoint: https://api.neuralwatt.com/v1
      protocol: openai
      keyEnv: THEA2_NEURALWATT_KEY
      model: glm-5.3
      effort: low
      forcing: none
      temperature: 0.7
      topP: 0.95
    voiceFallback:
      endpoint: https://api.z.ai/api/anthropic
      protocol: anthropic
      keyEnv: THEA2_MODEL_API_KEY
      model: glm-5.3-flash
      thinkingBudget: 512
      forcing: tool_choice
    mind:
      endpoint: https://api.neuralwatt.com/v1
      protocol: openai
      keyEnv: THEA2_NEURALWATT_KEY
      model: deepseek-v4-flash
      effort: none
      forcing: tool_choice
    judge:
      endpoint: https://api.neuralwatt.com/v1
      protocol: openai
      keyEnv: THEA2_NEURALWATT_KEY
      model: kimi-k3
      effort: none
      forcing: tool_choice
bridge:
  allowedChatIds: [123456]
affect:
  statePath: var/affect.json
  quietHours: [1, 7]
sched:
  statePath: var/sched.json
budgets:
  packetTokens: 3000
  windowTokens: 6000
  turnTokens: 6000
inhibitionPlacement: trailing
gravity:
  seedWeight: 0.7
reconcile:
  lostReplyWindowMin: 20
embedder:
  kind: hash
`;

const DOORS_ENV: Record<string, string> = {
  THEA2_BOT_TOKEN: VALID_ENV['THEA2_BOT_TOKEN']!,
  THEA2_NEURALWATT_KEY: 'neuralwatt-key-value',
  THEA2_MODEL_API_KEY: 'zai-key-value',
};

describe('models.doors (P-DOOR DR.1)', () => {
  it('the four default doors load and resolve each key from its keyEnv', () => {
    const c = cfg(DOORS_YAML, DOORS_ENV);
    expect(c.models.doors?.voice).toMatchObject({
      name: 'voice',
      endpoint: 'https://api.neuralwatt.com/v1',
      protocol: 'openai',
      keyEnv: 'THEA2_NEURALWATT_KEY',
      apiKey: 'neuralwatt-key-value',
      model: 'glm-5.3',
      effort: 'low',
      forcing: 'none',
      temperature: 0.7,
      topP: 0.95,
    });
    expect(c.models.doors?.voiceFallback).toMatchObject({
      name: 'voiceFallback',
      protocol: 'anthropic',
      model: 'glm-5.3-flash',
      thinkingBudget: 512,
      forcing: 'tool_choice',
      apiKey: 'zai-key-value',
    });
    expect(c.models.doors?.mind).toMatchObject({
      name: 'mind',
      model: 'deepseek-v4-flash',
      effort: 'none',
      forcing: 'tool_choice',
    });
    expect(c.models.doors?.judge).toMatchObject({
      name: 'judge',
      model: 'kimi-k3',
      effort: 'none',
      forcing: 'tool_choice',
    });
    // The flattened view (embedder/derive-cli live here) points at the voice door.
    expect(c.models.endpoint).toBe('https://api.neuralwatt.com/v1');
    expect(c.models.apiKey).toBe('neuralwatt-key-value');
    expect(c.models.protocol).toBe('openai');
    expect(c.models.tiers).toEqual({ main: 'glm-5.3', cheap: 'deepseek-v4-flash', reasoning: 'kimi-k3' });
  });

  it('legacy config still boots', () => {
    const c = cfg(VALID_YAML);
    // endpoint/protocol/tiers synthesize the three tier doors; the keys come
    // from the legacy env vars, forcing stays 'none' (legacy had no door forcing).
    expect(c.models.doors?.voice).toMatchObject({
      name: 'voice',
      endpoint: 'https://api.example.com/v1',
      protocol: 'openai',
      model: 'main-model',
      forcing: 'none',
      apiKey: VALID_ENV['THEA2_MODEL_API_KEY'],
    });
    expect(c.models.doors?.mind).toMatchObject({ name: 'mind', model: 'cheap-model', forcing: 'none' });
    expect(c.models.doors?.judge).toMatchObject({ name: 'judge', model: 'main-model', forcing: 'none' });
    expect(c.models.doors?.voiceFallback).toBeUndefined();
    expect(c.models.tiers.main).toBe('main-model');
  });

  it('legacy config with a reasoning tier maps judge to it', () => {
    const c = cfg(VALID_YAML.replace('    cheap: cheap-model\n', '    cheap: cheap-model\n    reasoning: judge-model\n'));
    expect(c.models.doors?.judge).toMatchObject({ name: 'judge', model: 'judge-model' });
  });

  it('a missing door key in env is a typed error naming the door', () => {
    const err = reject(DOORS_YAML, { ...DOORS_ENV, THEA2_NEURALWATT_KEY: undefined });
    expect(err.code).toBe('app/config-invalid');
    expect(err.issues.some((i) => i.path.join('.').includes('doors.voice'))).toBe(true);
  });

  it('doors and legacy endpoint/tiers together are rejected (exactly one registry form)', () => {
    const both = DOORS_YAML.replace(
      '  doors:\n',
      '  doors:\n    placeholder: never\n',
    );
    expect(() => cfg(both)).toThrow(ConfigError); // unknown door key is strict-rejected first
    const mixed = VALID_YAML.replace(
      'models:\n',
      'models:\n  doors:\n    voice:\n      endpoint: https://x/v1\n      protocol: openai\n      keyEnv: K\n      model: m\n      forcing: none\n',
    );
    const err = reject(mixed, { ...VALID_ENV, K: 'k' });
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it('keyEnv must name an env variable, not carry a key', () => {
    const bad = DOORS_YAML.replace('keyEnv: THEA2_NEURALWATT_KEY', 'keyEnv: sk-realkeyvalue123456789');
    expect(reject(bad, DOORS_ENV).code).toBe('app/config-secret-in-yaml');
  });

  it('a door without forcing is rejected (forcing is not optional)', () => {
    const err = reject(DOORS_YAML.replace('      forcing: none\n      temperature: 0.7\n', '      temperature: 0.7\n'), DOORS_ENV);
    expect(err.issues.some((i) => i.path.join('.').includes('forcing'))).toBe(true);
  });
});

// ——— M21 spine: the M.6 block + the *Env key-name exemption ———————————————

const SPINE_BLOCK = `spine:
  version: '1.18.3'
  port: 4096
  authTokenEnv: THEA2_SPINE_TOKEN
`;

describe('spine block (M.6) and the *Env secret-scanner exemption', () => {
  it('the spine block loads: version/port/authTokenEnv pass through untouched', () => {
    const c = cfg(DOORS_YAML + SPINE_BLOCK, { ...DOORS_ENV, THEA2_SPINE_TOKEN: 'spine-token' });
    expect(c.spine).toMatchObject({ version: '1.18.3', port: 4096, authTokenEnv: 'THEA2_SPINE_TOKEN' });
  });

  it('an *Env key carrying an env VARIABLE NAME is not a secret hit', () => {
    // authTokenEnv matches the /token/i key suspicion; the value is a variable
    // NAME by config law (mirrors doors' keyEnv), so it must load.
    expect(cfg(VALID_YAML.replace('embedder:', `spine:\n  version: '1.18.3'\n  authTokenEnv: THEA2_SPINE_TOKEN\nembedder:`)).spine).toBeDefined();
  });

  it('a real credential value under an *Env key is still rejected', () => {
    const bad = VALID_YAML.replace(
      'embedder:',
      `spine:\n  version: '1.18.3'\n  authTokenEnv: sk-realk3yvalue123456789abcdef\nembedder:`,
    );
    expect(reject(bad).code).toBe('app/config-secret-in-yaml');
  });

  it('an off-pin version (not exact x.y.z) is a config error', () => {
    const err = reject(DOORS_YAML + SPINE_BLOCK.replace("'1.18.3'", "'1.18'"), { ...DOORS_ENV, THEA2_SPINE_TOKEN: 't' });
    expect(err.issues.some((i) => i.path.join('.').includes('spine.version'))).toBe(true);
  });
});
