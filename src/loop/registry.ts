// M13 loop — the tool registry. One uniform calling machinery: web tools,
// memory tools, reminders and the spawn primitives (fork/task/committee) all
// live here as plain entries, so a subprocess and the main deliberation reach
// them through exactly the same native-function-calling path (ADR-009).
//
// Unbuilt capability is absent registration (AGENTS rule 5): the v1 I/O tools
// (web_fetch, web_search, ...) appear here only when their handlers exist.

import { failLoop } from './errors.js';
import type { ToolDef } from '../model/index.js';
import type { ToolRegistry, ToolRegistryEntry } from './types.js';

export const createToolRegistry = (): ToolRegistry => {
  const entries = new Map<string, ToolRegistryEntry>();

  return {
    register: (e) => {
      if (entries.has(e.def.name)) {
        return failLoop('loop/duplicate-tool', `tool '${e.def.name}' is already registered`);
      }
      entries.set(e.def.name, e);
    },

    defs: (entry) =>
      [...entries.values()]
        .filter((e) => e.inhibitionMeta.entries === undefined || e.inhibitionMeta.entries.includes(entry))
        .map((e) => e.def),

    get: (name) => entries.get(name),

    names: () => [...entries.keys()],
  };
};

/** Defs are data, not behavior — the one place a plain ToolDef is built from parts. */
export const defOf = (name: string, description: string, parameters: unknown): ToolDef => ({
  name,
  description,
  parameters,
});

/**
 * One entry's registry: the injected registry with the spawn primitives overlaid
 * (an overlay name shadows a base name). Overlay entries come first in `defs`,
 * so delegation is the most prominent capability on the wire.
 */
export const overlayRegistry = (base: ToolRegistry, entries: readonly ToolRegistryEntry[]): ToolRegistry => {
  const over = new Map<string, ToolRegistryEntry>(entries.map((e) => [e.def.name, e]));
  const shadowed = new Set(over.keys());
  return {
    register: (e) => {
      if (over.has(e.def.name)) {
        return failLoop('loop/duplicate-tool', `tool '${e.def.name}' is already registered`);
      }
      over.set(e.def.name, e);
      shadowed.add(e.def.name);
    },
    defs: (entry) => [
      ...entries
        .filter((e) => e.inhibitionMeta.entries === undefined || e.inhibitionMeta.entries.includes(entry))
        .map((e) => e.def),
      ...base.defs(entry).filter((d) => !shadowed.has(d.name)),
    ],
    get: (name) => over.get(name) ?? base.get(name),
    names: () => [...new Set([...over.keys(), ...base.names()])],
  };
};
