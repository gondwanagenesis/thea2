// v9 body — detached work. Making a picture or a video takes longer than a
// turn should; the tool starts the job and returns at once ("making it"), the
// line stays open, and the result arrives on its own. At most three at a
// time (Thea1's MAX_LIVE backstop). A job that fails is reported back to her
// as a moment she lives through (a self-entry turn), never swallowed.

import type { Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';

export interface JobRecord {
  id: string;
  kind: string;
  what: string;
  turnId: string;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
  endedAt?: number | undefined;
  result?: string | undefined;
}

export interface Jobs {
  start(kind: string, what: string, turnId: string, run: (id: string) => Promise<string>): { ok: true; id: string } | { ok: false; reason: string };
  list(): JobRecord[];
  /** The job's record once it settles (undefined for an unknown id). */
  wait(id: string): Promise<JobRecord | undefined>;
  /** Resolves when every running job has settled (tests, shutdown). */
  idle(): Promise<void>;
}

export const MAX_LIVE_JOBS = 3;

export const makeJobs = (d: {
  clock: Clock;
  events: EventLog;
  onFail(job: JobRecord, error: string): void;
  /** Every settled job (done or failed) — the body writes the outcome into the moment that started it. */
  onSettle?: ((job: JobRecord) => void) | undefined;
}): Jobs => {
  const jobs: JobRecord[] = [];
  const running = new Set<Promise<unknown>>();
  const settled = new Map<string, Promise<void>>();
  /** A failure comes back to her at most once per kind per window — a retry that fails again must not become a loop. */
  const lastFailToldAt = new Map<string, number>();
  const FAIL_TELL_GAP_MS = 15 * 60_000;
  let n = 0;
  return {
    start: (kind, what, turnId, run) => {
      const live = jobs.filter((j) => j.status === 'running');
      if (live.length >= MAX_LIVE_JOBS) return { ok: false, reason: `${live.length} things are already being made (${live.map((j) => j.kind).join(', ')}); wait for one to land` };
      const id = `${kind}-${d.clock.epochMs()}-${++n}`;
      const rec: JobRecord = { id, kind, what: what.slice(0, 200), turnId, startedAt: d.clock.epochMs(), status: 'running' };
      jobs.push(rec);
      if (jobs.length > 50) jobs.splice(0, jobs.length - 50);
      void d.events.emit('body.job_started', { id, kind, what: rec.what }, turnId);
      const p = Promise.resolve()
        .then(() => run(id))
        .then((result) => {
          rec.status = 'done';
          rec.endedAt = d.clock.epochMs();
          rec.result = result;
          void d.events.emit('body.job_done', { id, kind, ms: rec.endedAt - rec.startedAt, result }, turnId);
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          rec.status = 'failed';
          rec.endedAt = d.clock.epochMs();
          rec.result = msg.slice(0, 300);
          void d.events.emit('incident.body_job_failed', { id, kind, error: rec.result }, turnId);
          const last = lastFailToldAt.get(kind);
          if (last === undefined || d.clock.epochMs() - last > FAIL_TELL_GAP_MS) {
            lastFailToldAt.set(kind, d.clock.epochMs());
            d.onFail(rec, rec.result);
          }
        })
        .finally(() => {
          running.delete(p);
          if (rec.status !== 'running') d.onSettle?.(rec);
        });
      running.add(p);
      settled.set(id, p.then(() => undefined));
      return { ok: true, id };
    },
    list: () => [...jobs],
    wait: async (id) => {
      await settled.get(id);
      return jobs.find((j) => j.id === id);
    },
    idle: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
};
