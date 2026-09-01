---
module: M16
name: sched
syncedTo: spec-v1 (implemented; see "Deviations as built" at the end)
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
export const startScheduler: (jobs: Job[], deps: SchedulerDeps) => {
  ready(): Promise<void>;        // boot done: state read + startup plan armed (resolves even on startup failure; stop() rethrows it)
  stop(): Promise<void>;         // drains runs + persists; rethrows a typed startup failure (e.g. sched/state-corrupt)
  runningJobs(): string[];
};
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
- **Jitter is deterministic**: `hash(jobName, slotSeed)` seeds the jitter draw. `every` cadences take `jitterPct` — a percentage in [0, 100] of the period (10 = ±10%) — so "roughly every 30 minutes" stays inside ±3 min. Daily/weekly slots sit exactly on their UTC grid minute (no jitter). Replays reproduce the exact schedule — never "roughly with Math.random".
- **Catch-up semantics** (the named test): on startup, compute missed occurrences per job. `skip` = skip them all — heartbeat and ponder are **moods, not obligations; 16 missed heartbeats must not become 16 texts** (this rule exists because that exact bug class is real). `once` = one catch-up pass regardless of N missed (reflect, consolidate, derive-check, ledger-report — obligations).
- **Isolation**: each run's body is raced against a `clock.waitUntil` deadline — job bodies share no await chain with the scheduler loop. Failure increments backoff (interval ×2 up to ×4); **3 consecutive failures ⇒ `sched.alarm`** (then on every further failure while still failing). Timeout fires `ctx.signal` (cooperative) and allows one further `timeoutMs` grace window to settle; a body that ignores the signal through the grace window is abandoned, flagged `wedged` (`sched.wedged`), and its **singleton lock refuses re-entry until process restart** (a wedged nightly job must not stack a second instance on the next tick). The lock is in-memory only — state.json records the attempt, so a restart re-enters.
- **Lanes**: `interactive` (heartbeat, ponder) and `maintenance` (everything else). Serial within a lane; **global concurrency 2**. The interactive lane additionally respects the conversation-active mutex — `deps.interactiveMutex()` true ⇒ skip this firing (a mood, not an obligation; see catch-up) — keeping her from texting mid-conversation. The mutex STATE lives in the composition (M20: recent inbound via M15's ledger, in-flight turn via the pipeline); the scheduler only consults the injected predicate, so the semantics stay testable here and true in prod.
- Job completion writes `lastCompleted` — the **scheduled occurrence that completed** (its slot time, not the settle instant: the slot is the chain address a restart needs to reproduce the jittered sequence exactly); attempts write `lastAttempt` (the actual fire time, persisted at fire time for crash-mid-run recovery) — `reconcile`-style recovery and the Ledger's reporting (M18) read this file to say what actually ran.
- `sched.*` events to L0: `sched.fire` (`{job, lane, due, lateMs, catchUp?}`), `sched.complete` (duration), `sched.fail` (`{job, consecutiveFailures, wedged?, error:{code?, message}}` — timeouts carry `code: 'sched/timeout'`), `sched.alarm`, `sched.wedged`, plus `sched.catchup` (`{job, missed, policy, action}` — the startup missed-count census, visible rather than silent) and `sched.skipped` (`{job, due, reason}` — mutex skips are loud). No job body is this module's business; a throwing job never perturbs siblings' schedules (asserted).

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

## Deviations as built
- **`sched.job_failing` never existed — the alarm event is `sched.alarm`.** The Behavior spec named `sched.job_failing` while the acceptance criteria (and M18, and the design report) already said `sched.alarm`; built as `sched.alarm`, raised at the 3rd consecutive failure and on every further failure while still failing. The spec text above is corrected.
- **Jitter applies to `every` cadences only.** The spec floated "the ±window around daily/weekly minutes"; built as exact UTC-grid slots for daily/weekly (DST-agnostic, assertable) and ±`jitterPct`% of the period for `every`. `jitterPct` is a percentage in [0, 100] — the spec never said which scale.
- **`lastCompleted` stores the occurrence's scheduled slot, not the settle wall time.** The slot chain is jittered and anchored on the previous slot, so anchoring a restart on settle-time (slot + ε) would draw different jitter seeds; storing the slot makes "restart continues the identical sequence" hold byte-for-byte. `lastAttempt` remains the actual fire time.
- **Additive observability**: `sched.catchup` (startup missed-count census per job) and `sched.skipped` (each mutex-skip with its due) — both rules existed in spec but were silent; recovery and the Ledger (M18) need them visible.
- **Additive `ready()` on the scheduler handle** — M17/M20 want an awaitable "boot plan armed" signal; also `stop()` rethrows the typed startup failure (`sched/state-corrupt`) so a corrupt state file fails loud at the composition site.
- **Grace window before `wedged`**: after the cooperative cancel, the body gets one further `timeoutMs` to settle; settling (or throwing) inside the window is a plain timeout failure (`sched/timeout`) and the job may run again — only ignoring the signal through the whole window is a wedge.
- **Pathological downtime bail-out**: the missed-slot scan saturates at `MAX_SLOT_SCAN` (1e6) and jumps to "first slot after now" rather than walking a year of 1-minute slots.
- **A body that already finished keeps its outcome at shutdown**: stop()/timeout races yield a few microtask rounds so a finished body records success/failure instead of being counted as `stopped`; only a still-pending body is abandoned.
