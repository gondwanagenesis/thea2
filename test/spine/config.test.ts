// M21 spine — the config block (thea2.config.yaml `spine:`): schema, the
// pinned version, resolved auth from env, and loud failures for the missing
// block / missing token (M.6: version + port + authTokenEnv are load-bearing).

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPINE_DEFAULT_PORT, SPINE_SESSION_BREAK_MS, loadSpineConfig, resolveSpineConfig } from '../../src/spine/index.js';

const writeYaml = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'thea2-spine-cfg-'));
  const path = join(dir, 'thea2.config.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
};

describe('spine config (M.6 block)', () => {
  it('parses the prod-shaped block and resolves the auth token from env', () => {
    const path = writeYaml(['models: {tiers: {main: m, cheap: c}}', 'spine:', '  version: "1.18.3"', '  port: 4096', '  authTokenEnv: THEA2_SPINE_TOKEN', ''].join('\n'));
    const cfg = loadSpineConfig(path, { THEA2_SPINE_TOKEN: 'tok-abc' }, { providerID: 'voice', modelID: 'glm-5.3', door: 'voice' });
    expect(cfg.version).toBe('1.18.3');
    expect(cfg.port).toBe(4096);
    expect(cfg.authTokenEnv).toBe('THEA2_SPINE_TOKEN');
    expect(cfg.authToken).toBe('tok-abc');
    expect(cfg.host).toBe('127.0.0.1'); // loopback only, always
    expect(cfg.agent).toBe('thea');
    expect(cfg.model).toEqual({ providerID: 'voice', modelID: 'glm-5.3', door: 'voice' });
    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('defaults: 4h session break, trailing inhibition, backoff family', () => {
    const cfg = resolveSpineConfig(
      { version: '1.18.3', model: { providerID: 'voice', modelID: 'glm-5.3', door: 'voice' } },
      { THEA2_SPINE_TOKEN: 't' },
    );
    expect(cfg.sessionBreakMs).toBe(SPINE_SESSION_BREAK_MS);
    expect(SPINE_SESSION_BREAK_MS).toBe(4 * 60 * 60 * 1000);
    expect(cfg.port).toBe(SPINE_DEFAULT_PORT);
    expect(cfg.inhibitionPlacement).toBe('trailing');
    expect(cfg.decideRetryCount).toBe(1); // S1.3: one re-ask, pinned by the spec
  });

  it('a missing spine block or a missing auth token fails loud', () => {
    const noBlock = writeYaml('models: {tiers: {main: m, cheap: c}}\n');
    expect(() => loadSpineConfig(noBlock, {})).toThrow(/spine/);
    rmSync(join(noBlock, '..'), { recursive: true, force: true });

    const withBlock = writeYaml(['spine:', '  version: "1.18.3"', '  authTokenEnv: THEA2_SPINE_TOKEN', ''].join('\n'));
    const model = { providerID: 'voice', modelID: 'glm-5.3' };
    expect(() => loadSpineConfig(withBlock, {}, model)).toThrow(/THEA2_SPINE_TOKEN/);
    expect(() => loadSpineConfig(withBlock, { THEA2_SPINE_TOKEN: 't' })).toThrow(/spine\.model/i);
    rmSync(join(withBlock, '..'), { recursive: true, force: true });
  });

  it('the per-call model is required — a spine without her door never boots', () => {
    expect(() => resolveSpineConfig({ version: '1.18.3' }, { THEA2_SPINE_TOKEN: 't' })).toThrow(/spine\.model/i);
  });
});
