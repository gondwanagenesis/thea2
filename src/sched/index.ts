// M16 sched — barrel. Consumers (M17 life, M18 siblings, M20 app) import Job
// and startScheduler from here; the pure slot math is exported too so the
// catch-up/backoff/jitter laws are testable without a scheduler instance.
export * from './types.js';
export * from './slots.js';
export * from './state.js';
export * from './scheduler.js';
