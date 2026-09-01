---
module: M16
name: sched
syncedTo: spec-v1 (no code yet)
stage: S2
depends: [M01-kernel, M02-events]
---
# M16 — sched

## Responsibility
The one in-process scheduler behind every periodic behavior — replacing Thea1's 97 systemd units with one multiplexer whose timing, catch-up, isolation, and jitter are all TestClock-provable. Jobs declare cadence, lane, catch-up policy, and a body; the scheduler owns next-due computation, deterministic jitter, per-job failure isolation with backoff, wedged-job abandonment, and lane concurrency. It knows nothing about what the jobs do.

## Interfaces (contract)
```ts
export interface Job {
  name: string;
  cadence: { kind: 'every'; ms: number; jitterPct?: number }
         | { kind: 'daily'; utcMinute: number }
         | { kind: 'weekly'; dow: number; utcMinute: number };
  lane: 'interactive' | 'maintenance';
  catchUp: 'skip' | 'once';
  timeoutMs: number;
  run(ctx: JobCtx): Promise<void>;
}
export interface JobCtx { clock: Clock; rng: Rng; signal: AbortSignal; events: EventLog; }

export interface SchedulerDeps {
  clock: Clock; rng: Rng; events: EventLog;
  statePath: string;                        // var/sched/state.json
  interactiveMutex?: () => boolean;         // true = SKIP (inbound < 10 min ago or turn in flight); injected by M20
}
export const startScheduler: (jobs: Job[], deps: SchedulerDeps) => { stop(): Promise<void>; runningJobs(): string[] };
```

## Behavior spec
- **Job table v1** (from the architecture; M17/M18/M08/M10/M20 own the bodies, this module owns the when):

  | Job | Cadence | Lane | Catch-up |
  |---|---|---|---|
  | heartbeat | 30 min ± jitter | interactive | skip |
  | ponder | 20 min ± jitter | interactive | skip |
  | reconcile | 5 min | maintenance | skip |
  | affect-snapshot | 15 min | maintenance | skip |
  | reflect | nightly | maintenance | once |
  | consolidate | nightly | maintenance | once |
  | ledger-report | daily | maintenance | once |
  | derive-check | weekly | maintenance | once |
  | probe-on-deploy watcher | 1 min | maintenance | skip |

- **Timing loop**: `nextDue` computed per job from persisted `var/sched/state.json` (`{job: {lastCompleted, lastAttempt, consecutiveFailures}}`, kernel atomic writes); sleep via `clock.waitUntil(min(nextDue across jobs))`. TestClock turns a simulated week into milliseconds — the exact-fire-sequence test is this module's crown jewel.
- **Jitter is deterministic**: `hash(jobName, scheduledSlot)` seeds the jitter draw (an `every`-cadence `jitterPct` or the ±window around daily/weekly minutes). Replays reproduce the exact schedule — "roughly every 30 minutes", never "roughly with Math.random".
- **Catch-up semantics** (the named test): on startup, compute missed occurrences per job. `skip` = skip them all — heartbeat and ponder are **moods, not obligations; 16 missed heartbeats must not become 16 texts** (this rule exists because that exact bug class is real). `once` = one catch-up pass regardless of N missed (reflect, consolidate, derive-check, ledger-report — obligations).
- **Isolation**: each run is `void withTimeout(job.run(ctx), timeoutMs).catch(capture)` tracked in a promise map — job bodies share no await chain with the scheduler loop. Failure increments backoff (interval ×2 up to ×4); **3 consecutive failures ⇒ alarm event** (`sched.job_failing`). Timeout fires `ctx.signal` (cooperative); a truly wedged promise is abandoned, flagged `wedged`, and its **singleton lock refuses re-entry until process restart** (a wedged nightly job must not stack a second instance on the next tick).
- **Lanes**: `interactive` (heartbeat, ponder) and `maintenance` (everything else). Serial within a lane; **global concurrency 2**. The interactive lane additionally respects the conversation-active mutex — `deps.interactiveMutex()` true ⇒ skip this firing (a mood, not an obligation; see catch-up) — keeping her from texting mid-conversation. The mutex STATE lives in the composition (M20: recent inbound via M15's ledger, in-flight turn via the pipeline); the scheduler only consults the injected predicate, so the semantics stay testable here and true in prod.
- Job completion writes `lastCompleted`; attempts write `lastAttempt` — `reconcile`-style recovery and the Ledger's reporting (M18) read this file to say what actually ran.
- `sched.*` events to L0: `sched.fire`, `sched.complete` (duration), `sched.fail` (error summary), `sched.alarm`, `sched.wedged`. No job body is this module's business; a throwing job never perturbs siblings' schedules (asserted).

## Not this module's job
- Heartbeat/ponder/reflect job BODIES and their policy — M17-life.
- Probe triggers and report rendering — M18-siblings; derive-check's report content — M08.
- The conversation-active mutex's state — M20 composition (this module takes the predicate).
- Wall-clock deamonization, systemd units — `deploy/` (S8); in-process is the whole point (ADR-002).
- One-off CLI verbs — M20-app.

## Acceptance criteria
- [ ] TestClock week simulation: mixed cadences fire in the exact committed expected sequence (incl. daily-at-utcMinute and weekly-dow boundaries, DST-agnostic by UTC).
- [ ] **`sixteen-missed-heartbeats` regression**: 16 missed heartbeat occurrences + `catchUp: 'skip'` ⇒ ≤1 fire on startup; `catchUp: 'once'` job with 16 missed ⇒ exactly 1 catch-up fire.
- [ ] Jitter determinism: same state.json + same jobs ⇒ identical fire timestamps across two fresh scheduler instances (seeded rng).
- [ ] Throwing job: siblings' schedules unperturbed; failure recorded; ×2 backoff up to ×4 applied; 3rd consecutive failure emits `sched.alarm`.
- [ ] Timeout: cooperative cancel via `ctx.signal` observed by a well-behaved job; a wedged job (ignores the signal) is abandoned, flagged, and refuses re-entry until restart.
- [ ] Lanes: two maintenance jobs never overlap; interactive fires even while maintenance runs; global concurrency 2 never exceeded (instrumented).
- [ ] Mutex: `interactiveMutex: () => true` skips the firing WITHOUT recording a missed-catch-up obligation (it's a mood).
- [ ] State file survives restart: `lastCompleted` honored — next due computed from persistence, not process birth.

## Test checklist
- unit: nextDue math table (every/daily/weekly × catch-up × backoff states); jitter hash determinism; backoff progression; concurrency accounting.
- component: TestClock week simulation (the golden sequence fixture); restart-recovery cycles; throwing/wedged job injection; mutex-skip path.
- fixtures needed: a job set spanning all three cadence kinds + both lanes + both catch-up policies; committed golden fire-sequence for the simulated week; state.json variants (fresh, mid-week, backoff-laden).
