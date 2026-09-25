// v9 body — her house on disk: /opt/thea2/var/house. Everything the body keeps
// (what he sent, what she made, where he is) lives under one root she can
// name in tools; a path that escapes it is refused, never followed.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface House {
  readonly root: string;
  /** Absolute path for a house-relative one; undefined if it escapes the house. */
  resolve(rel: string): string | undefined;
  /** House-relative form of an absolute path inside the house. */
  rel(abs: string): string;
  /** Save bytes under a subdir with a safe, collision-free name; returns the absolute path. */
  save(sub: 'incoming' | 'out' | 'tmp' | 'reading', name: string, bytes: Uint8Array, stamp: number): string;
  tmp(name: string, stamp: number): string;
  readJson<T>(rel: string, fallback: T): T;
  writeJson(rel: string, value: unknown): void;
}

export const safeName = (name: string): string => {
  const base = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-80);
  return base === '' ? 'file' : base;
};

export const openHouse = (root: string): House => {
  const abs = path.resolve(root);
  for (const d of ['incoming', 'out', 'tmp', 'reading']) fs.mkdirSync(path.join(abs, d), { recursive: true });
  const resolve = (rel: string): string | undefined => {
    const p = path.resolve(abs, rel.replace(/^house\//, ''));
    return p === abs || p.startsWith(abs + path.sep) ? p : undefined;
  };
  return {
    root: abs,
    resolve,
    rel: (p) => path.relative(abs, p).split(path.sep).join('/'),
    save: (sub, name, bytes, stamp) => {
      const file = path.join(abs, sub, `${stamp}-${safeName(name)}`);
      fs.writeFileSync(file, bytes);
      return file;
    },
    tmp: (name, stamp) => path.join(abs, 'tmp', `${stamp}-${safeName(name)}`),
    readJson: (rel, fallback) => {
      const p = resolve(rel);
      if (p === undefined) return fallback;
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as typeof fallback;
      } catch {
        return fallback;
      }
    },
    writeJson: (rel, value) => {
      const p = resolve(rel);
      if (p === undefined) return;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 1));
      fs.renameSync(`${p}.tmp`, p);
    },
  };
};
