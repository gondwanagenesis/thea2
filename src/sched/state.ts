// M16 sched — persistence of "what actually ran". kernel atomic writes make the
// file crash-safe; this layer only adds typed refusal of a corrupt file, because
// silently starting fresh would re-fire `once` obligations (double nightly runs).

import { atomicWriteJson, fail } from '../kernel/index.js';
import * as fsp from 'node:fs/promises';
import type { JobState, SchedState } from './types.js';

export const emptySchedState = (): SchedState => ({ version: 1, jobs: {} });

/** Missing file = fresh install (normal); unparseable/wrong-version = loud failure. */
export const readSchedState = async (statePath: string): Promise<SchedState> => {
  let text: string;
  try {
    text = await fsRead(statePath);
  } catch {
    return emptySchedState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    return fail('sched/state-corrupt', `${statePath} is not valid JSON`, e);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return fail('sched/state-corrupt', `${statePath} is not a state object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== 1 || typeof obj['jobs'] !== 'object' || obj['jobs'] === null) {
    return fail('sched/state-corrupt', `${statePath} is not a version-1 sched state`);
  }
  const jobs: Record<string, JobState> = {};
  for (const [name, raw] of Object.entries(obj['jobs'] as Record<string, unknown>)) {
    jobs[name] = parseJobState(raw, name);
  }
  return { version: 1, jobs };
};

const parseJobState = (raw: unknown, name: string): JobState => {
  if (typeof raw !== 'object' || raw === null) {
    return fail('sched/state-corrupt', `state entry for job '${name}' is not an object`);
  }
  const obj = raw as Record<string, unknown>;
  const finite = (field: string): number | undefined => {
    const v = obj[field];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return fail('sched/state-corrupt', `state entry for job '${name}' has non-numeric '${field}'`);
    }
    return v;
  };
  const failures = obj['consecutiveFailures'] ?? 0;
  if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) {
    return fail('sched/state-corrupt', `state entry for job '${name}' has invalid 'consecutiveFailures'`);
  }
  return {
    lastCompleted: finite('lastCompleted'),
    lastAttempt: finite('lastAttempt'),
    consecutiveFailures: failures,
  };
};

export const writeSchedState = (statePath: string, state: SchedState): Promise<void> =>
  atomicWriteJson(statePath, state);

const fsRead = (statePath: string): Promise<string> => fsp.readFile(statePath, 'utf8');
