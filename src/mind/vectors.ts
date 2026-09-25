// v8 mind — vector storage and similarity.
//
// Append-only binary files: `<name>.f32` holds the vectors back to back,
// `<name>.ids` one id per line. The vector is written BEFORE its id, so a crash
// between the two leaves an orphan vector that load() drops (count = the
// smaller of the two). Rewrite (forget) goes through an atomic rename.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
};

export interface VecFile {
  readonly dim: number;
  has(id: string): boolean;
  get(id: string): Float32Array | undefined;
  size(): number;
  append(id: string, vec: Float32Array): void;
  /** Drop ids (forget) — rewrites both files atomically. */
  remove(ids: ReadonlySet<string>): void;
}

export const openVecFile = (dir: string, name: string, dim: number): VecFile => {
  fs.mkdirSync(dir, { recursive: true });
  const f32Path = path.join(dir, `${name}.f32`);
  const idsPath = path.join(dir, `${name}.ids`);
  const map = new Map<string, Float32Array>();
  const order: string[] = [];

  const load = (): void => {
    if (!fs.existsSync(f32Path) || !fs.existsSync(idsPath)) return;
    const ids = fs.readFileSync(idsPath, 'utf8').split('\n').filter((l) => l.length > 0);
    const buf = fs.readFileSync(f32Path);
    const perVec = dim * 4;
    const count = Math.min(ids.length, Math.floor(buf.length / perVec));
    for (let i = 0; i < count; i++) {
      // Copy out of the file buffer so the Float32Array is aligned and owned.
      const slice = new Float32Array(dim);
      for (let j = 0; j < dim; j++) slice[j] = buf.readFloatLE(i * perVec + j * 4);
      const id = ids[i]!;
      if (!map.has(id)) order.push(id);
      map.set(id, slice); // a re-appended id wins (last write)
    }
  };
  load();

  const toBuffer = (v: Float32Array): Buffer => {
    const b = Buffer.alloc(dim * 4);
    for (let j = 0; j < dim; j++) b.writeFloatLE(v[j] ?? 0, j * 4);
    return b;
  };

  return {
    dim,
    has: (id) => map.has(id),
    get: (id) => map.get(id),
    size: () => map.size,
    append: (id, vec) => {
      if (vec.length !== dim) throw new Error(`mind/vectors: ${name} expects ${dim}-d vectors, got ${vec.length}`);
      fs.appendFileSync(f32Path, toBuffer(vec));
      fs.appendFileSync(idsPath, `${id}\n`);
      if (!map.has(id)) order.push(id);
      map.set(id, vec);
    },
    remove: (ids) => {
      const keep = order.filter((id) => !ids.has(id));
      const tmpF = `${f32Path}.tmp`;
      const tmpI = `${idsPath}.tmp`;
      fs.writeFileSync(tmpF, Buffer.concat(keep.map((id) => toBuffer(map.get(id)!))));
      fs.writeFileSync(tmpI, keep.map((id) => `${id}\n`).join(''));
      fs.renameSync(tmpF, f32Path);
      fs.renameSync(tmpI, idsPath);
      for (const id of ids) map.delete(id);
      order.splice(0, order.length, ...keep);
    },
  };
};
