---
module: M01
name: kernel
syncedTo: spec-v1 (no code yet)
stage: S0
depends: []
---
# M01 — kernel

## Responsibility
Provide the runtime primitives everything else builds on, and nothing else: an injected clock, a seeded forkable RNG, time-sortable ids, sha256 content hashing, canonical JSON, typed Result/error helpers, atomic file writes (tmp+rename), and JSONL append/read/rotate. M01 has zero internal dependencies; every other module may depend on it and it may depend only on Node builtins. Determinism and crash-safety are bought here once, so no other module ever touches `Date.now()`, `Math.random()`, or raw write paths directly.

## Interfaces (contract)
```ts
export interface Clock { epochMs(): number; now(): Date; waitUntil(t: number, signal?: AbortSignal): Promise<void>; }
export class SystemClock implements Clock {}
export class TestClock implements Clock {
  constructor(startMs?: number);
  advance(ms: number): Promise<void>; // resolves pending waitUntil in due order
}

export interface Rng {
  float(): number;                     // [0, 1)
  int(lo: number, hi: number): number; // inclusive bounds
  pick<T>(xs: readonly T[]): T;
  shuffle<T>(xs: T[]): T[];            // returns a new array; input untouched
  fork(label: string): Rng;            // independent child stream
}
export const makeRng: (seed: number | string) => Rng;

export const newId: (clock: Clock, rng: Rng) => string;          // ULID-style, 26 chars, lexically time-sortable
export const contentHash: (data: Uint8Array | string) => string; // "sha256:<64 hex>"
export const canonicalJson: (value: unknown) => string;          // stable key order, deterministic bytes

export type KernelError = { code: string; message: string; cause?: unknown };
export type Result<T, E = KernelError> = { ok: true; value: T } | { ok: false; error: E };

export const atomicWriteJson: (path: string, value: unknown) => Promise<void>; // tmp + fsync + rename
export const atomicWriteText: (path: string, text: string) => Promise<void>;

export interface JsonlStore<T> {
  append(row: T): Promise<void>;
  read(opts?: { since?: number }): AsyncIterable<T>;
}
export const openJsonl: <T>(dir: string, base: string,
  opts?: { rotateDailyUtc?: boolean; clock?: Clock; onCorrupt?: (line: string) => void }) => JsonlStore<T>;
```

## Behavior spec
- All entropy flows through `Rng`, all time through `Clock`. Ship a lint/CI check forbidding `Date.now`, `new Date()`, and `Math.random` outside `src/kernel/`.
- `TestClock.advance(ms)` fires pending `waitUntil` promises in due-time order; equal due times resolve in registration order; each resolution's microtasks drain before the next fires (scheduled work runs as it would in real time).
- `waitUntil` with a past timestamp resolves on the next tick; abort via `signal` rejects with code `aborted`.
- `makeRng(seed)` is fully deterministic per seed and platform-stable (small PRNG such as sfc32/splitmix, no `crypto` entropy). `fork(label)` seeds an independent child from hash(parentSeed, label); draws on the child never perturb the parent sequence, and vice versa — one consumer's draws cannot shift another's.
- `newId`: 48-bit ms timestamp + 80 random bits, Crockford base32; strictly increasing within one process (monotonic increment inside a single ms).
- `canonicalJson`: recursively sorted object keys, no whitespace; throws typed errors on NaN, Infinity, undefined, BigInt, or circular refs. `contentHash` of a JS value is defined as `contentHash(canonicalJson(v))` — the identity M08 deriveKeys depend on.
- Atomic write: write `<path>.tmp-<rand>` in the same directory, fsync file, rename over target, best-effort fsync of the directory. A crash or injected fault before rename leaves the previous target byte-identical; successful writes leave no tmp litter.
- JSONL: one JSON document per line, `\n` terminated, appended in a single write call. `read` skips a truncated final line (crash tail) without throwing; malformed interior lines go to `onCorrupt` if provided, else are skipped and counted — never fatal.
- Daily rotation (`rotateDailyUtc`): file `<base>-YYYY-MM-DD.jsonl`, date chosen by the injected clock at append time; `read` iterates all matching files in date order.
- No domain knowledge here: no event kinds, no affect vocabulary, no config parsing, no network.

## Not this module's job
- Event envelope, seq numbering, replay filters — M02-events.
- Model calls, retries, token accounting — M03-model.
- Vector math and embeddings — M04-embed.
- Job scheduling, catch-up, jitter policy — M16-sched.
- Config loading and composition — M20-app.

## Acceptance criteria
- [ ] TestClock runs a simulated week of mixed waits in milliseconds and fires them in exact due order (property test over random wait sets, incl. ties and aborts).
- [ ] Same seed yields identical float/int/pick/shuffle sequences across runs; forked streams are pairwise independent (interleaving draws on one stream does not change the other's sequence).
- [ ] `newId` output is lexically time-sortable and unique across 100k ids generated in a single frozen-ms TestClock burst.
- [ ] `atomicWriteJson` under an injected fault before rename leaves the old file intact; no `.tmp-*` files remain after successful writes.
- [ ] JSONL store appends and replays 10k rows across a UTC rotation boundary; a hand-truncated final line is skipped, not fatal.
- [ ] `canonicalJson` is byte-stable across key-permuted equal objects and rejects NaN/Infinity/undefined/circular with typed errors.
- [ ] The module imports nothing from `src/*` (depcruise rule committed at S0).

## Test checklist
- unit: TestClock ordering + abort semantics; Rng determinism and fork independence; ULID monotonicity and sortability; canonicalJson stability + rejection table; contentHash golden vectors.
- component: JSONL append/read across rotation with TestClock date rollover; crash-tail fixture replay; atomic-write fault injection (mocked rename failure).
- fixtures needed: `truncated-tail.jsonl` (valid rows + cut final line); sha256 golden-vector file; key-permuted JSON object pairs.
