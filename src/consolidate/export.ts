// M10 consolidate — the proposals export: a byte-exact copy of var/proposals
// into a target directory for Diego's review (`thea2 proposals:export <dir>`).
// Since round 2 the proposals live in runtime state under var/, so the copies
// the human merges from must be carried out of the var/ tree explicitly — this
// is that one fs choreography. No model, no L0: the source directory is the
// contract. Missing source is a typed error (the verb exits nonzero), an empty
// or absent manifest is honest (`copied: []` / no manifest line).

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ConsolidateError } from './errors.js';
import { MANIFEST_NAME } from './state.js';

/** Proposal drafts are .md; the manifest rides along so the copy attests keys. */
const isExportable = (name: string): boolean => name.endsWith('.md') || name === MANIFEST_NAME;

export interface ProposalsExportResult {
  sourceDir: string;
  targetDir: string;
  /** Copied file names, sorted — drafts plus the manifest when present. */
  copied: string[];
}

/**
 * Copies every proposal draft (+ the manifest) from `proposalsDir` into
 * `targetDir`, creating the target and overwriting stale files there. Throws a
 * typed ConsolidateError when the source does not exist — a quiet empty copy of
 * a mistyped path would hide more than it saves.
 */
export const exportProposals = async (proposalsDir: string, targetDir: string): Promise<ProposalsExportResult> => {
  let names: string[];
  try {
    names = (await fsp.readdir(proposalsDir)).filter(isExportable).sort();
  } catch {
    throw new ConsolidateError(
      'consolidate/bad-config',
      `proposals dir is unreadable: ${proposalsDir} — has any consolidation run landed there?`,
    );
  }
  await fsp.mkdir(targetDir, { recursive: true });
  for (const name of names) {
    await fsp.copyFile(path.join(proposalsDir, name), path.join(targetDir, name));
  }
  return { sourceDir: proposalsDir, targetDir, copied: names };
};
