// M05 affect — the single writer. The engine is pure; this is the only thing in
// the process allowed to hold a mutable current state, and every mutation goes
// through one serialized promise chain, so the turn path and the scheduler jobs
// can never interleave inside a batch (ADR-002). Order inside a batch is
// tick-to-now FIRST, then the events land at now — a batch that just happened is
// contact, not two-hours-ago silence, and the gap before it genuinely decays.

import * as fsp from 'node:fs/promises';
import { type Clock, atomicWriteJson, fail, type Rng } from '../kernel/index.js';
import { type EventEnvelope, type EventLog, project } from '../events/index.js';
import type { AffectSnapshotPayload, UnknownTagPayload } from '../../schemas/events.js';
import { applyInto, tick } from './engine.js';
import { AffectEventSchema, type AffectEvent } from './events.js';
import { initialAffectState, rehydrateState, cloneState, type AffectState } from './state.js';
import { weatherLine } from './landmarks.js';

/** Where a rejected tag is said to have come from — carried on the incident. */
export type UnknownTagSource = UnknownTagPayload['source'];

export interface AffectStore {
  /**
   * Validate the whole batch, bring the engine to now, land the events, persist,
   * then report to L0. An unknown tag rejects the ENTIRE batch (never a partial
   * application), emits `incident.unknown_tag`, and throws 'affect/unknown-tag'.
   */
  applyEvents(evs: AffectEvent[], opts?: { source?: UnknownTagSource }): Promise<void>;
  /** Persist + emit the full state (the 15-minute job is M16's; this is the verb). */
  snapshot(): Promise<void>;
  /** A defensive copy — callers read, the store alone writes. */
  current(): AffectState;
  /** The [AFFECT] projection of the current state. */
  weather(): string;
}

const APPLIED_KIND = 'affect.applied';
const SNAPSHOT_KIND = 'affect.snapshot';
const UNKNOWN_TAG_INCIDENT = 'incident.unknown_tag';
const CORRUPT_INCIDENT = 'incident.affect_state_corrupt';

export const openAffectStore = (
  path: string,
  deps: { clock: Clock; rng: Rng; events: EventLog },
): AffectStore => {
  const { clock, rng, events } = deps;

  // The engine's origin is WHEN THE STORE WAS OPENED — captured once, here,
  // before any await. Boot's file read is async, so reading the clock inside
  // boot() would make a fresh baseline's start time depend on when the IO
  // happened to land (a first boot advanced past would silently skip its decay).
  const openedAt = clock.epochMs();

  // ---- startup: state.json is the fast path; the newest L0 snapshot is the
  // recovery path; a fresh baseline is the last resort. Only an actual
  // corruption (or a vanished file that snapshots exist for) is an incident —
  // a first boot with no file anywhere is just a first boot.
  let state: AffectState | undefined; // set by boot()
  // Boot starts the moment the store is opened — file read + L0 replay + any
  // recovery incident all happen without anyone asking. The async operations
  // await it; the sync readers (current/weather) fail loudly if someone calls
  // them before boot has landed (an ordering bug at the call site, not silence).
  const readStateFile = async (): Promise<{ raw: string } | { corrupt: string } | undefined> => {
    let text: string;
    try {
      text = await fsp.readFile(path, 'utf8');
    } catch {
      return undefined; // absent — distinct from corrupt
    }
    try {
      const parsed: unknown = JSON.parse(text);
      // A parseable file that is not an affect state is corruption, not silence.
      const s = parsed as { t?: unknown; dials?: unknown } | null;
      if (typeof s !== 'object' || s === null || typeof s.t !== 'number' || typeof s.dials !== 'object') {
        return { corrupt: 'not an affect state' };
      }
      return { raw: text };
    } catch (e) {
      return { corrupt: e instanceof Error ? e.message : String(e) };
    }
  };

  const newestSnapshot = async (): Promise<AffectState | undefined> => {
    const last = await project<EventEnvelope | undefined>(
      events,
      undefined,
      (_acc, ev) => ev,
      { kinds: [SNAPSHOT_KIND] },
    );
    if (last === undefined) return undefined;
    const payload = last.payload as AffectSnapshotPayload | undefined;
    if (payload === undefined || payload.state === undefined) return undefined;
    return rehydrateState(payload.state, openedAt);
  };

  const boot = async (): Promise<void> => {
    const file = await readStateFile();
    if (file !== undefined && !('corrupt' in file)) {
      state = rehydrateState(JSON.parse(file.raw) as unknown, openedAt);
      return;
    }
    const recovered = await newestSnapshot();
    if (recovered !== undefined) {
      state = recovered;
      await events.emit(CORRUPT_INCIDENT, {
        path,
        reason: file === undefined ? 'state file missing' : `corrupt: ${file.corrupt}`,
        recovery: 'l0-snapshot-replay',
      });
      return;
    }
    state = initialAffectState(openedAt);
    if (file !== undefined) {
      await events.emit(CORRUPT_INCIDENT, {
        path,
        reason: `corrupt: ${file.corrupt}`,
        recovery: 'fresh-start',
      });
    }
  };

  // Boot starts the moment the store is opened — file read + L0 replay + any
  // recovery incident all happen without anyone asking. The async operations
  // await it; the sync readers (current/weather) fail loudly if someone calls
  // them before boot has landed (an ordering bug at the call site, not silence).
  const booted: Promise<void> = boot();
  const ensureBoot = (): Promise<void> => booted;

  // ---- the serialization queue: every public operation enqueues behind the
  // previous one; a failure in one batch must not poison the queue.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** Advance the engine to wall-clock now (never backwards). */
  const tickToNow = (): void => {
    const now = clock.epochMs();
    const cur = state;
    if (cur === undefined) return fail('affect/not-booted', 'tickToNow before boot');
    const dt = now - cur.t;
    if (dt > 0) state = tick(cur, dt, rng);
  };

  const store: AffectStore = {
    applyEvents: (evs, opts) =>
      enqueue(async () => {
        await ensureBoot();
        // Validate the ENTIRE batch before any mutation — a rejected tag leaves
        // the state byte-identical, never half-applied.
        for (const ev of evs) {
          const parsed = AffectEventSchema.safeParse(ev);
          if (parsed.success) continue;
          const tag = offendingTag(parsed.error.issues, ev);
          const payload: UnknownTagPayload = { tag, source: opts?.source ?? 'other' };
          await events.emit(UNKNOWN_TAG_INCIDENT, payload);
          return fail(
            'affect/unknown-tag',
            `tag '${tag}' is not in EMOTION_TAGS — batch of ${evs.length} rejected wholesale`,
          );
        }
        tickToNow();
        const applied = applyInto(state!, evs);
        state = applied.state;
        await atomicWriteJson(path, state);
        await events.emit(APPLIED_KIND, {
          tags: evs.filter((e) => e.kind === 'emotion').map((e) => e.tag),
          moved: applied.moved,
        });
      }),

    snapshot: () =>
      enqueue(async () => {
        await ensureBoot();
        tickToNow();
        await atomicWriteJson(path, state);
        const payload: AffectSnapshotPayload = { state };
        await events.emit(SNAPSHOT_KIND, payload);
      }),

    current: () => {
      const cur = state;
      if (cur === undefined) return fail('affect/not-booted', 'current() before the store finished booting');
      return cloneState(cur);
    },

    weather: () => {
      const cur = state;
      if (cur === undefined) return fail('affect/not-booted', 'weather() before the store finished booting');
      return weatherLine(cur);
    },
  };
  return store;
};

/**
 * Pull the offending tag out of a zod reject: prefer an issue at path ['tag'],
 * fall back to the event's own tag field, else 'unknown'.
 */
const offendingTag = (issues: readonly { path: PropertyKey[] }[], ev: AffectEvent): string => {
  const tagIssue = issues.find((i) => i.path.length === 1 && i.path[0] === 'tag');
  if (tagIssue !== undefined) {
    const raw = (ev as { tag?: unknown }).tag;
    return typeof raw === 'string' ? raw : 'unknown';
  }
  return (ev as { tag?: unknown }).tag !== undefined ? String((ev as { tag?: unknown }).tag) : 'unknown';
};
