// M01 kernel — time-sortable ids and content hashing.

import { createHash } from 'node:crypto';
import type { Clock } from './clock.js';
import type { Rng } from './rng.js';

/** Crockford base32 — no I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Monotonic-within-a-process state: inside one millisecond the 80-bit random
// field is drawn once and then incremented, so ids stay strictly increasing
// even under a frozen TestClock (100k-id burst test depends on this).
let lastMs = -1;
let base = 0n;
let drawnForMs = false;

/**
 * ULID-style id: 48-bit ms timestamp (10 chars) + 80 random/increment bits
 * (16 chars), Crockford base32, 26 chars total. Lexically time-sortable;
 * strictly increasing within one process.
 */
export const newId = (clock: Clock, rng: Rng): string => {
  const ms = BigInt(clock.epochMs()) & 0xffffffffffffn;
  if (!drawnForMs || ms !== BigInt(lastMs)) {
    // Fresh millisecond: draw a fresh 80-bit base from the injected rng.
    let r = 0n;
    for (let i = 0; i < 16; i++) r = (r << 5n) | BigInt(rng.int(0, 31));
    base = r;
    lastMs = Number(ms);
    drawnForMs = true;
  } else {
    base += 1n;
  }
  let value = (ms << 80n) | (base & 0xffffffffffffffffn);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(value & 31n)]! + out;
    value >>= 5n;
  }
  return out;
};

/** "sha256:<64 hex>" over raw bytes or a UTF-8 string. */
export const contentHash = (data: Uint8Array | string): string =>
  'sha256:' + createHash('sha256').update(data).digest('hex');
