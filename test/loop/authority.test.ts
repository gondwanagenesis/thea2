// v11 (plan docs/plans/v11-a-person-in-the-world.md): the authority wall. A turn
// carrying a non-owner's authority (a group member or another bot) is offered ONLY
// the safe classes (chat + lookups) and any other tool call — even if it somehow
// rode the wire — is denied before it runs. An owner turn is unchanged.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compileGate } from '../../src/inhibit/index.js';
import { createToolRegistry } from '../../src/loop/registry.js';
import type { LoopEntry, ToolRegistryEntry } from '../../src/loop/index.js';
import { enqueueDecision, enqueueToolRound, makeHarness, toolNamesOnWire } from './helpers.js';

const tool = (name: string, cls: string, ran: { names: string[] }): ToolRegistryEntry<{ x: string }> => ({
  def: { name, description: `${name} does a thing`, parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
  input: z.object({ x: z.string() }),
  inhibitionMeta: { class: cls },
  handler: async () => {
    ran.names.push(name);
    return `${name}:done`;
  },
});

const gate = () => compileGate('version: 1\ntool:\n  - id: reg\n    why: x\n    applies: \'*\'\n    require_registry: true\n', { knownTools: ['lookup', 'shell', 'workshop', 'spend', 'decide'] });

const setup = (authority: LoopEntry['authority']) => {
  const ran = { names: [] as string[] };
  const tools = createToolRegistry();
  tools.register(tool('lookup', 'web', ran)); // safe
  tools.register(tool('shell', 'hands', ran)); // dangerous
  tools.register(tool('workshop', 'self', ran)); // dangerous
  tools.register(tool('spend', 'camera', ran)); // dangerous
  const h = makeHarness({ tools, gate: gate() });
  const entry: LoopEntry = { kind: 'user-turn', turnId: 't1', ...(authority !== undefined ? { authority } : {}) };
  return { h, ran, entry };
};

describe('v11 authority wall', () => {
  it('a non-owner turn is offered only the safe (web) tools — never shell, workshop or spend', async () => {
    const { h, entry } = setup('other');
    enqueueDecision(h.model, { bubbles: ['hi there'] });
    await h.run(entry);
    const offered = toolNamesOnWire(h.model.calls[0]!);
    expect(offered).toContain('lookup');
    expect(offered).toContain('decide');
    for (const n of ['shell', 'workshop', 'spend']) expect(offered).not.toContain(n);
  });

  it('a non-owner tool call for a dangerous tool is denied and never runs (even if it rides the wire)', async () => {
    const { h, ran, entry } = setup('other');
    enqueueToolRound(h.model, [{ name: 'shell', args: { x: 'rm -rf /' } }, { name: 'workshop', args: { x: 'disable the gate' } }]);
    enqueueDecision(h.model, { bubbles: ['i can only chat and look things up'] });
    const d = await h.run(entry);
    expect(ran.names).toEqual([]); // nothing dangerous ran
    expect(d.inhibitions.some((v) => !v.allow && v.ruleId === 'authority')).toBe(true);
    expect(d.toolTrace.filter((t) => t.verdict.allow === false && (t.tool === 'shell' || t.tool === 'workshop'))).toHaveLength(2);
  });

  it('a non-owner CAN use a safe lookup tool', async () => {
    const { h, ran, entry } = setup('other');
    enqueueToolRound(h.model, [{ name: 'lookup', args: { x: 'weather in bali' } }]);
    enqueueDecision(h.model, { bubbles: ['looked it up'] });
    await h.run(entry);
    expect(ran.names).toEqual(['lookup']);
  });

  it('an owner turn keeps every tool (offered and runnable)', async () => {
    const { h, ran, entry } = setup('owner');
    enqueueToolRound(h.model, [{ name: 'shell', args: { x: 'ls' } }]);
    enqueueDecision(h.model, { bubbles: ['done'] });
    await h.run(entry);
    const offered = toolNamesOnWire(h.model.calls[0]!);
    for (const n of ['lookup', 'shell', 'workshop', 'spend']) expect(offered).toContain(n);
    expect(ran.names).toEqual(['shell']);
  });

  it('absent authority (pre-v11 callers, the DM path) behaves as owner', async () => {
    const { h, ran, entry } = setup(undefined);
    enqueueToolRound(h.model, [{ name: 'shell', args: { x: 'ls' } }]);
    enqueueDecision(h.model, { bubbles: ['done'] });
    await h.run(entry);
    expect(ran.names).toEqual(['shell']);
  });
});
