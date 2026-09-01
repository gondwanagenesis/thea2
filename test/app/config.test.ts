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

  it('bad quiet hours: reversed', () => {
    expect(reject(VALID_YAML.replace('quietHours: [1, 7]', 'quietHours: [7, 1]')).code).toBe(
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
