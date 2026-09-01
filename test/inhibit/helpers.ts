// test/inhibit helpers — the fixture yaml, the compose-time config, and the two
// gates the truth tables run over. Kept out of the .test.ts files so both suites
// compile the SAME artifact (a fixture edit must move every table at once).

import { readFileSync } from 'node:fs';

import { compileGate, type GateConfig, type InhibitionGate } from '../../src/inhibit/index.js';

/** Every rule class in one gate — see the file header for the per-rule intent. */
export const FIXTURE_YAML = readFileSync(
  new URL('./fixtures/inhibitions.fixture.yaml', import.meta.url),
  'utf8',
);

/**
 * The DRAFT canon, compiled as-is: the gate proof "every rule in inhibitions.yaml
 * compiles to a matcher" runs against Diego's real file, not a copy.
 */
export const CANON_YAML = readFileSync(
  new URL('../../corpus/canon/inhibitions.yaml', import.meta.url),
  'utf8',
);

/** Compose-time config for the fixture gate. No knownTools: the yaml's own declared names are the known set. */
export const fixtureCfg: GateConfig = {
  ownerChatId: 'chat-diego',
  secrets: ['sk-fixture-0123456789'],
};

export const fixtureGate = (): InhibitionGate => compileGate(FIXTURE_YAML, fixtureCfg);

/** Compose-time config for the canon gate: the M13 v1 registry names (docs/modules/M13-loop.md). */
export const canonCfg: GateConfig = {
  ownerChatId: 'chat-diego',
  secrets: ['sk-canon-0123456789'],
  knownTools: [
    'web_fetch',
    'web_search',
    'memory_search',
    'remember_thread',
    'set_reminder',
    'send_message',
    'fork',
    'task',
    'committee',
  ],
};

export const canonGate = (): InhibitionGate => compileGate(CANON_YAML, canonCfg);

/** The hint format the loop re-injects on rejection — one place, asserted verbatim in the tables. */
export const hintFor = (ruleId: string, why: string): string => `[INHIBITION:${ruleId}] ${why}`;
