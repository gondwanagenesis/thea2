// M02 events — the L0 append-only event log. Every subsystem writes here;
// it never enters prompts (M19 scans outbound for leakage of this content).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { type Clock, openJsonl, canonicalJson, fail } from '../kernel/index.js';

export interface EventEnvelope<K extends string = string, P = unknown> {
  seq: number; // monotonic across rotations and restarts, starts at 1
  ts: number; // epochMs from the injected clock at emit
  kind: K; // namespaced string, e.g. "model.call"
  turnId?: string;
  payload: P;
}

export interface ReplayFilter {
  kinds?: string[];
  sinceTs?: number; // inclusive
}

export interface EventLog {
  emit<K extends string, P>(kind: K, payload: P, turnId?: string): Promise<void>;
  replay(filter?: ReplayFilter): AsyncIterable<EventEnvelope>;
}

const KIND_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export const openEventLog = (
  dir: string,
  deps: { clock: Clock; maxPayloadBytes?: number },
): EventLog => {
  const maxPayload = deps.maxPayloadBytes ?? 32 * 1024;
  const store = openJsonl<EventEnvelope>(dir, 'events', { rotateDailyUtc: true, clock: deps.clock });

  // Recover the next seq from the tail of the newest file. The kernel's
  // crash-tail tolerance means a torn final line is skipped and its seq is
  // reused for the next durable emit.
  const newestFile = (): string | undefined => store.files().at(-1);

  const recoverSeq = async (): Promise<number> => {
    const file = newestFile();
    if (!file) return 0;
    let last = 0;
    for await (const row of openJsonl<EventEnvelope>(path.dirname(file), path.basename(file, '.jsonl')).read()) {
      last = row.seq;
    }
    return last;
  };

  /**
   * A torn final line (crash mid-write) must be truncated away before the next
   * append — otherwise appendFile merges the new event onto the fragment and
   * silently destroys it. The torn event was never committed; losing it is the
   * contract, merging it into the next event is not.
   */
  const repairTornTail = async (): Promise<void> => {
    const file = newestFile();
    if (!file) return;
    const text = await fsp.readFile(file, 'utf8');
    if (text.endsWith('\n')) return;
    await fsp.truncate(file, text.lastIndexOf('\n') + 1);
  };

  let nextSeq: number | undefined; // lazy — opened on first emit
  let chain: Promise<void> = Promise.resolve(); // serializes concurrent emits

  const emitInner = async (kind: string, payload: unknown, turnId?: string): Promise<void> => {
    if (!KIND_RE.test(kind)) fail('events/bad-kind', `kind '${kind}' lacks a dot-namespace`);
    const serializePayload = (p: unknown): string => {
      try {
        return canonicalJson(p);
      } catch (e) {
        return fail('events/bad-payload', `payload for '${kind}' is not canonically serializable`, e);
      }
    };
    const serializedPayload = serializePayload(payload);
    if (Buffer.byteLength(serializedPayload, 'utf8') > maxPayload) {
      fail('events/payload-too-large', `payload for '${kind}' exceeds ${maxPayload} bytes — store ids/paths, not blobs`);
    }
    if (nextSeq === undefined) {
      nextSeq = (await recoverSeq()) + 1;
      await repairTornTail();
    }

    const envelope: EventEnvelope = {
      seq: nextSeq++,
      ts: deps.clock.epochMs(),
      kind,
      ...(turnId !== undefined ? { turnId } : {}),
      payload,
    };
    // Durable-on-resolve: kernel appendFile completes before we return.
    await store.append(envelope);
  };

  return {
    emit: (kind, payload, turnId) => {
      const run = chain.then(() => emitInner(kind, payload, turnId));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      // Failure policy: one retry, then typed rejection + stderr.
      return run.catch(async (e) => {
        console.error(`[events] emit '${String(kind)}' failed once — retrying`, e);
        const retry = chain.then(() => emitInner(kind, payload, turnId));
        chain = retry.then(
          () => undefined,
          () => undefined,
        );
        return retry;
      });
    },

    replay: async function* (filter?: ReplayFilter): AsyncGenerator<EventEnvelope> {
      const kinds = filter?.kinds ? new Set(filter.kinds) : undefined;
      const since = filter?.sinceTs;
      // Envelopes are yielded in (file date, seq) order by construction;
      // a torn final line inside the newest file is skipped by the kernel.
      for await (const row of store.read()) {
        if (kinds && !kinds.has(row.kind)) continue;
        if (since !== undefined && row.ts < since) continue;
        yield row;
      }
    },
  };
};

/**
 * Deterministic fold over the log; `step` must not touch clock/rng.
 * Same log + same step = deep-equal projection, every time.
 */
export const project = async <S>(
  log: EventLog,
  init: S,
  step: (s: S, ev: EventEnvelope) => S,
  filter?: ReplayFilter,
): Promise<S> => {
  let state = init;
  for await (const ev of log.replay(filter)) state = step(state, ev);
  return state;
};

// Used by tests to fabricate torn-tail fixtures without reaching into internals.
export const readRawEventsFiles = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)) : [];

export const writeEventsFileRaw = async (dir: string, name: string, text: string): Promise<void> => {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), text, 'utf8');
};
