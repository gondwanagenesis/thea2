// M18 siblings — persona seeds.
//
// Ten-line markdown files, voice for reports ONLY: no inbound messages, no
// state, no identity beyond tone. They ride the same M03 door as everything
// else (cheap tier) and are deliberately NOT deploy-marker inputs — editing one
// changes how a report SOUNDS, never how Thea BEHAVES, so Nightingale sleeps.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PersonaKind = 'ledger' | 'nightingale';

/** The spec's shape: a seed is a 10-line markdown file. Pinned by test. */
export const PERSONA_SEED_LINES = 10;

const modulePersonaDir = (): string => path.dirname(fileURLToPath(new URL('./personas/seed.md', import.meta.url)));

/**
 * Reads the seed file. Injected dir first (tests, an install that ships personas
 * elsewhere), then the packaged default next to this module.
 */
export const loadPersonaSeed = (kind: PersonaKind, dir?: string | undefined): string => {
  const base = dir ?? modulePersonaDir();
  return fs.readFileSync(path.join(base, `${kind}.md`), 'utf8').trim();
};
