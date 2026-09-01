// M13 loop — registry units: registration, entry filtering, the overlay that
// binds the spawn primitives per turn, and the duplicate-name failure mode.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolRegistry, overlayRegistry } from '../../src/loop/registry.js';
import { LoopError } from '../../src/loop/errors.js';
import type { ToolRegistryEntry } from '../../src/loop/index.js';

const testInput = z.object({ v: z.string().optional() });
type TestArgs = z.infer<typeof testInput>;

const entry = (name: string, meta: ToolRegistryEntry['inhibitionMeta'] = {}): ToolRegistryEntry<TestArgs> => ({
  def: { name, description: `${name} tool`, parameters: { type: 'object' } },
  input: testInput,
  inhibitionMeta: meta,
  handler: async () => name,
});

describe('createToolRegistry', () => {
  it('lists defs in registration order and resolves get/names', () => {
    const r = createToolRegistry();
    r.register(entry('web_fetch'));
    r.register(entry('echo'));
    expect(r.names()).toEqual(['web_fetch', 'echo']);
    expect(r.defs('user-turn').map((d) => d.name)).toEqual(['web_fetch', 'echo']);
    expect(r.get('echo')?.def.description).toBe('echo tool');
    expect(r.get('nope')).toBeUndefined();
  });

  it('filters defs by inhibitionMeta.entries; absent = every entry', () => {
    const r = createToolRegistry();
    r.register(entry('web_fetch'));
    r.register(entry('web_search', { entries: ['ponder', 'user-turn'] }));
    r.register(entry('memory_search', { entries: ['heartbeat'] }));
    expect(r.defs('user-turn').map((d) => d.name)).toEqual(['web_fetch', 'web_search']);
    expect(r.defs('ponder').map((d) => d.name)).toEqual(['web_fetch', 'web_search']);
    expect(r.defs('heartbeat').map((d) => d.name)).toEqual(['web_fetch', 'memory_search']);
  });

  it('refuses a duplicate name with the typed failure', () => {
    const r = createToolRegistry();
    r.register(entry('echo'));
    expect(() => r.register(entry('echo'))).toThrow(LoopError);
    expect(() => r.register(entry('echo'))).toThrow(expect.objectContaining({ code: 'loop/duplicate-tool' }));
  });
});

describe('overlayRegistry', () => {
  it('shadows a base name and keeps unshadowed base defs', () => {
    const base = createToolRegistry();
    base.register(entry('echo'));
    base.register(entry('web_fetch'));
    const fork = entry('fork', { class: 'spawn' });
    const shadow = entry('echo', { class: 'spawn' });
    const over = overlayRegistry(base, [fork, shadow]);
    expect(over.names()).toEqual(['fork', 'echo', 'web_fetch']);
    expect(over.defs('user-turn').map((d) => d.name)).toEqual(['fork', 'echo', 'web_fetch']);
    expect(over.get('echo')).toBe(shadow); // the overlay wins
    expect(over.get('web_fetch')?.def.name).toBe('web_fetch');
  });

  it('refuses duplicate registration into the overlay', () => {
    const over = overlayRegistry(createToolRegistry(), [entry('fork')]);
    expect(() => over.register(entry('fork'))).toThrow(LoopError);
  });

  it('passes entry filtering through for both layers', () => {
    const base = createToolRegistry();
    base.register(entry('memory_search', { entries: ['heartbeat'] }));
    const over = overlayRegistry(base, [entry('task', { entries: ['ponder'] })]);
    expect(over.defs('heartbeat').map((d) => d.name)).toEqual(['memory_search']);
    expect(over.defs('ponder').map((d) => d.name)).toEqual(['task']);
    expect(over.defs('user-turn')).toEqual([]);
  });
});
