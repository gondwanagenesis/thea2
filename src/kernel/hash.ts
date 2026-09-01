// M01 kernel — canonical JSON and typed rejection. Byte-stability here is what
// content hashes, derive keys, and projections all stand on.

import { fail } from './result.js';

/**
 * Stable, deterministic JSON: object keys recursively sorted, no whitespace.
 * Rejects NaN, Infinity, undefined, BigInt, functions, and circular refs with
 * typed errors — silence here would corrupt every downstream hash.
 */
export const canonicalJson = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, path: string): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'boolean':
        return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) fail('canonical/invalid-number', `${path}: ${v} has no canonical form`);
        return JSON.stringify(v);
      case 'string':
        return JSON.stringify(v);
      case 'bigint':
        return fail('canonical/unsupported-type', `${path}: bigint has no canonical form`);
      case 'undefined':
        return fail('canonical/unsupported-type', `${path}: undefined has no canonical form`);
      case 'function':
        return fail('canonical/unsupported-type', `${path}: functions are not serializable`);
      case 'object':
        break;
      default:
        return fail('canonical/unsupported-type', `${path}: unserializable ${typeof v}`);
    }
    const obj = v as object;
    // Plain objects and arrays only — Map/Set/Date/RegExp/class instances have
    // no canonical form and would silently serialize as {} or worse.
    if (!Array.isArray(v) && v.constructor !== Object && Object.getPrototypeOf(v) !== null) {
      fail('canonical/unsupported-type', `${path}: ${v.constructor?.name ?? 'non-plain object'} has no canonical form`);
    }
    if (seen.has(obj)) fail('canonical/circular', `${path}: circular reference`);
    seen.add(obj);
    try {
      if (Array.isArray(v)) {
        const items = v.map((x, i) => walk(x, `${path}[${i}]`));
        return `[${items.join(',')}]`;
      }
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const body = entries.map(([k, x]) => `${JSON.stringify(k)}:${walk(x, `${path}.${k}`)}`);
      return `{${body.join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  };
  return walk(value, '$');
};
