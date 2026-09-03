// M21 spine — S1.5, the gating wiring. inhibitions.yaml compiles to (a) static
// deny rules as the spine agent/permission config JSON (deny-by-default,
// explicit allows for the tools the file acknowledges) and (b) a repo-tracked
// tool.execute.before plugin (spine/plugin/) that vetoes the relational rules
// and emits a gate.rejected event for EVERY veto via a loopback POST. Fail-open
// (soft) rules never compile to a spine deny or a plugin veto.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSpineGate, writeSpineGateFiles } from '../../src/spine/index.js';
import { loadGateRules, makeGateHook, type GateRejectedEvent, type GateRules } from '../../spine/plugin/gate-plugin.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const yamlText = readFileSync(join(fixturesDir, 'inhibitions-spine.yaml'), 'utf8');

describe('inhibitions.yaml -> spine permission config (S1.5a)', () => {
  it('compiles deny-by-default plus explicit allows, soft rules stay fail-open', () => {
    const { permission, rules } = compileSpineGate(yamlText, {
      knownTools: ['web_fetch', 'web_search', 'send_message', 'fork'],
      ownerChatId: '6971556140',
    });

    // unknown tool denies; every tool the file acknowledges is explicitly allowed
    expect(permission.permission).toEqual({
      '*': 'deny',
      fork: 'allow',
      send_message: 'allow',
      web_fetch: 'allow',
      web_search: 'allow',
    });

    // the relational predicates travel to the plugin, not to blanket denies:
    // chat-lock is an args rule, no-secret-args scans args — a whole-tool deny
    // would over-block the tool.
    expect(rules.rules).toContainEqual({ kind: 'owner-arg', tool: 'send_message', ruleId: 'chat-lock', arg: 'chat_id', ownerChatId: '6971556140' });
    expect(rules.rules).toContainEqual({ kind: 'secret-args', tool: 'web_fetch', ruleId: 'no-secret-args' });
    expect(rules.rules).toContainEqual({ kind: 'secret-args', tool: 'web_search', ruleId: 'no-secret-args' });
    expect(rules.rules).toContainEqual({ kind: 'secret-args', tool: 'send_message', ruleId: 'no-secret-args' });

    // soft (fail-open) plan rules never become spine denies
    expect(rules.failOpenRuleIds).toEqual(['banned-construction']);
    expect(JSON.stringify(permission)).not.toContain('banned-construction');
  });

  it('an owner_arg rule without an injected owner chat id is a startup failure', () => {
    expect(() => compileSpineGate(yamlText, { knownTools: ['send_message'] })).toThrow(/owner chat id/i);
  });
});

describe('the tool.execute.before gate plugin (S1.5b)', () => {
  it('gate-veto-blocks-a-tool-call-in-replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thea2-spine-gate-'));
    try {
      const { rulesPath } = await writeSpineGateFiles(dir, yamlText, { knownTools: ['web_fetch', 'web_search', 'send_message'], ownerChatId: '6971556140' });
      expect(readFileSync(rulesPath, 'utf8')).toContain('"version":1');
      const rules = loadGateRules(dir); // the plugin loads the generated file from its own directory
      const posted: GateRejectedEvent[] = [];
      const hook = makeGateHook({ rules, secrets: ['sk-test-secret-000000000001'], post: async (e) => { posted.push(e); } });

      // relational rule: send_message must carry the owner chat id
      await expect(hook({ tool: 'send_message' }, { args: { chat_id: '42', text: 'hi' } })).rejects.toThrow(/\[INHIBITION:chat-lock\]/);
      await hook({ tool: 'send_message' }, { args: { chat_id: '6971556140', text: 'hi' } }); // correct owner: passes

      // secret values never ride allowed tools' args outward
      await expect(hook({ tool: 'web_fetch' }, { args: { url: 'https://x.test/?k=sk-test-secret-000000000001' } })).rejects.toThrow(
        /\[INHIBITION:no-secret-args\]/,
      );

      // unknown tools deny, even though the permission JSON would have first
      await expect(hook({ tool: 'mcp_shadow_tool' }, { args: {} })).rejects.toThrow(/\[INHIBITION:unknown-tool-deny\]/);

      await hook({ tool: 'web_fetch' }, { args: { url: 'https://clean.example' } }); // allowed: resolves
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every-veto-emits-a-gate-event', async () => {
    // the REAL posting path: a loopback thead-endpoint stand-in records the
    // gate.rejected POSTs the plugin emits (hermetic: 127.0.0.1, ephemeral port).
    const bodies: Array<GateRejectedEvent & { path: string }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      req.on('end', () => {
        bodies.push({ ...(JSON.parse(raw) as GateRejectedEvent), path: req.url ?? '' });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    process.env['THEA2_SPINE_EVENT_URL'] = `http://127.0.0.1:${port}/spine/gate-events`;

    const dir = mkdtempSync(join(tmpdir(), 'thea2-spine-gate-'));
    try {
      await writeSpineGateFiles(dir, yamlText, { knownTools: ['web_fetch', 'web_search', 'send_message'], ownerChatId: '6971556140' });
      const base = loadGateRules(dir);
      const rules: GateRules = {
        ...base,
        // the fail-open demo tool must be KNOWN, or the unknown-tool veto fires first
        allowTools: [...base.allowTools, 'committee'],
        // a fail-open rule rides the deny list with its rule id listed fail-open:
        // the event emits, the call is NOT vetoed.
        rules: [...base.rules, { kind: 'deny', tool: 'committee', ruleId: 'soft-committee-gate' }],
        failOpenRuleIds: ['soft-committee-gate'],
      };
      const hook = makeGateHook({ rules }); // default post -> THEA2_SPINE_EVENT_URL

      await expect(hook({ tool: 'send_message' }, { args: {} })).rejects.toThrow(/chat-lock/);
      await expect(hook({ tool: 'mcp_shadow_tool' }, { args: {} })).rejects.toThrow(/unknown-tool-deny/);
      await hook({ tool: 'committee' }, { args: {} }); // fail-open: no throw
      await hook({ tool: 'web_fetch' }, { args: { url: 'https://clean.example' } }); // allowed: NO event

      await pumpUntil(() => bodies.length >= 3);
      const vetoes = bodies.filter((b) => b.resolution === 'veto');
      const failOpens = bodies.filter((b) => b.resolution === 'fail-open');
      expect(vetoes).toHaveLength(2);
      expect(vetoes.map((v) => v.ruleId).sort()).toEqual(['chat-lock', 'unknown-tool-deny']);
      expect(failOpens).toHaveLength(1);
      expect(failOpens[0]).toMatchObject({ kind: 'gate.rejected', tool: 'committee', ruleId: 'soft-committee-gate', resolution: 'fail-open', path: '/spine/gate-events' });
      expect(bodies.some((b) => b.tool === 'web_fetch')).toBe(false); // an allowed call emits nothing
      for (const b of bodies) {
        expect(b.kind).toBe('gate.rejected');
        expect(b.path).toBe('/spine/gate-events'); // the designed thead endpoint path
      }
    } finally {
      delete process.env['THEA2_SPINE_EVENT_URL'];
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// event-loop pump (no wall-clock: the determinism law holds in tests too)
const pumpUntil = async (until: () => boolean, maxTurns = 10_000): Promise<void> => {
  for (let i = 0; i < maxTurns && !until(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!until()) throw new Error('pumpUntil: condition never met');
};
