// M18 siblings — barrel. M20 registers both jobs through `siblingJobs` (or the
// two job factories) and calls the run fns directly for the CLI verbs
// (`thea2 status --ledger`, `thea2 probe run`).
export * from './types.js';
export * from './aggregate.js';
export * from './routing.js';
export * from './marker.js';
export * from './persona.js';
export * from './ledger.js';
export * from './nightingale.js';
export * from './util.js';

import type { Job } from '../sched/index.js';
import type { SiblingDeps } from './types.js';
import { ledgerJob } from './ledger.js';
import { nightingaleJob } from './nightingale.js';

/** The module's whole registration surface: both surviving siblings as M16 jobs. */
export const siblingJobs = (deps: SiblingDeps): Job[] => [ledgerJob(deps), nightingaleJob(deps)];
