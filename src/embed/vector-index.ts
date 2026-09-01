// M04 embed — VectorIndex: brute-force cosine over packed Float32Arrays.
//
// Deliberately no LanceDB, no SQLite, no ANN (ADR-002's instinct applied to
// infrastructure): 10k x 384-d is ~15 MB and scans in <5 ms, and one in-process
// index is one less service to keep alive. What the index does own is
// *determinism* (score desc, id asc — replay depends on it) and *loud refusal*
// on embedder/dim mismatch — never silent mixing of two embedding spaces.
//
// On-disk shape: `<path>.bin` holds a little-endian packed payload (header,
// then per entry: id, meta JSON, vector); `<path>.meta.json` is written LAST and
// is the commit marker — a save interrupted before the sidecar lands leaves a
// bin that load() will refuse rather than half-trust.

import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteJson, canonicalJson, fail } from '../kernel/index.js';
import type { SavedIndexMeta, Scored, VectorIndex, VectorIndexOptions } from './types.js';
import type { SaveOptions } from './types.js';

const MAGIC = 'THA2VIDX';
const VERSION = 1;
const HEADER_BYTES = 20; // magic(8) + version(4) + count(4) + dim(4)

interface Entry {
  vec: Float32Array;
  norm: number;
  meta?: unknown;
}

const magnitude = (v: Float32Array): number => {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    sumSq += x * x;
  }
  return Math.sqrt(sumSq);
};

export const openVectorIndex = (opts?: VectorIndexOptions): VectorIndex => {
  const boundEmbedderId = opts?.embedderId ?? '';
  const boundModel = opts?.model;
  const boundDim = opts?.dim ?? 0;
  if (boundDim !== 0 && (!Number.isInteger(boundDim) || boundDim <= 0)) {
    fail('embed/config', `openVectorIndex dim must be a positive integer, got ${boundDim}`);
  }

  let entries = new Map<string, Entry>();
  let runtimeDim = 0;
  const effectiveDim = (): number => (boundDim > 0 ? boundDim : runtimeDim);

  const encode = (): Buffer => {
    const dim = effectiveDim();
    const ids: Buffer[] = [];
    const metas: Buffer[] = [];
    const vecs: Float32Array[] = [];
    let payloadBytes = HEADER_BYTES;
    for (const [id, e] of entries) {
      const idBuf = Buffer.from(id, 'utf8');
      const metaBuf = e.meta === undefined ? Buffer.alloc(0) : Buffer.from(canonicalJson(e.meta), 'utf8');
      ids.push(idBuf);
      metas.push(metaBuf);
      vecs.push(e.vec);
      payloadBytes += 4 + idBuf.length + 4 + metaBuf.length + dim * 4;
    }
    const buf = Buffer.alloc(payloadBytes);
    // Explicit DataView rather than Buffer helpers: it states the endianness at
    // every call site, and Node 24 dropped Buffer's legacy float accessors.
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = buf.write(MAGIC, 0, 'ascii');
    dv.setUint32(o, VERSION, true);
    o += 4;
    dv.setUint32(o, entries.size, true);
    o += 4;
    dv.setUint32(o, dim, true);
    o += 4;
    for (let i = 0; i < ids.length; i++) {
      const idBuf = ids[i]!;
      const metaBuf = metas[i]!;
      dv.setUint32(o, idBuf.length, true);
      o += 4;
      o += idBuf.copy(buf, o);
      dv.setUint32(o, metaBuf.length, true);
      o += 4;
      if (metaBuf.length > 0) o += metaBuf.copy(buf, o);
      const vec = vecs[i]!;
      for (let d = 0; d < dim; d++) {
        dv.setFloat32(o, vec[d]!, true);
        o += 4;
      }
    }
    return buf;
  };

  const decode = (buf: Buffer, label: string): { entries: Map<string, Entry>; dim: number; count: number } => {
    const corrupt = (m: string): never => fail('embed/index-corrupt', `${label}.bin: ${m}`);
    if (buf.length < HEADER_BYTES) corrupt('truncated header');
    if (buf.toString('ascii', 0, 8) !== MAGIC) corrupt('unrecognized magic');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const version = dv.getUint32(8, true);
    if (version !== VERSION) corrupt(`unsupported version ${version}`);
    const count = dv.getUint32(12, true);
    const dim = dv.getUint32(16, true);
    let o = HEADER_BYTES;
    const out = new Map<string, Entry>();
    for (let i = 0; i < count; i++) {
      if (o + 4 > buf.length) corrupt(`truncated before id length (entry ${i})`);
      const idLen = dv.getUint32(o, true);
      o += 4;
      if (o + idLen > buf.length) corrupt(`truncated id (entry ${i})`);
      const id = buf.toString('utf8', o, o + idLen);
      o += idLen;
      if (o + 4 > buf.length) corrupt(`truncated before meta length (entry '${id}')`);
      const metaLen = dv.getUint32(o, true);
      o += 4;
      let meta: unknown;
      if (metaLen > 0) {
        if (o + metaLen > buf.length) corrupt(`truncated meta (entry '${id}')`);
        try {
          meta = JSON.parse(buf.toString('utf8', o, o + metaLen)) as unknown;
        } catch (e) {
          return fail('embed/index-corrupt', `${label}.bin: unparseable meta for '${id}'`, e);
        }
        o += metaLen;
      }
      if (o + dim * 4 > buf.length) corrupt(`truncated vector (entry '${id}')`);
      const vec = new Float32Array(dim);
      for (let d = 0; d < dim; d++) {
        vec[d] = dv.getFloat32(o, true);
        o += 4;
      }
      out.set(id, { vec, norm: magnitude(vec), ...(meta !== undefined ? { meta } : {}) });
    }
    return { entries: out, dim, count };
  };

  return {
    get embedderId(): string {
      return boundEmbedderId;
    },
    get dim(): number {
      return effectiveDim();
    },

    size: () => entries.size,

    ids: () => [...entries.keys()],

    upsert: (id, vec, meta) => {
      if (vec.length === 0) fail('embed/config', `upsert('${id}'): zero-length vector`);
      const want = effectiveDim();
      if (want > 0 && vec.length !== want) {
        fail('embed/dim-mismatch', `upsert('${id}'): ${vec.length}-d vector into a ${want}-d index`);
      }
      runtimeDim = vec.length;
      // Copy: a caller mutating its vector afterwards must not corrupt the index.
      const copy = Float32Array.from(vec);
      entries.set(id, { vec: copy, norm: magnitude(copy), ...(meta !== undefined ? { meta } : {}) });
    },

    search: (vec, k, filter) => {
      if (k <= 0) return [];
      const want = effectiveDim();
      if (want > 0 && vec.length !== want) {
        fail('embed/dim-mismatch', `search: ${vec.length}-d query against a ${want}-d index`);
      }
      const qn = magnitude(vec);
      const scored: Scored[] = [];
      for (const [id, e] of entries) {
        if (filter && !filter(e.meta)) continue;
        let score = 0;
        if (qn > 0 && e.norm > 0) {
          let dot = 0;
          for (let i = 0; i < vec.length; i++) dot += vec[i]! * e.vec[i]!;
          // Embedders normalize, so this is usually a plain dot; dividing here
          // keeps true cosine even when a caller upserts raw magnitudes.
          score = dot / (qn * e.norm);
        }
        scored.push({ id, score, ...(e.meta !== undefined ? { meta: e.meta } : {}) });
      }
      // Deterministic ordering: score descending, ties by id ascending. Identical
      // vectors produce bit-identical scores, so the tie rule actually fires.
      scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return scored.slice(0, k);
    },

    save: async (filePath: string, saveOpts?: SaveOptions): Promise<void> => {
      const meta: SavedIndexMeta = {
        embedderId: boundEmbedderId,
        ...(boundModel !== undefined ? { model: boundModel } : {}),
        dim: effectiveDim(),
        count: entries.size,
        savedAtTs: saveOpts?.savedAtTs ?? 0,
      };
      await fsp.mkdir(dirname(filePath), { recursive: true });
      await fsp.writeFile(`${filePath}.bin`, encode());
      // Sidecar last: its presence is the commit marker for the payload.
      await atomicWriteJson(`${filePath}.meta.json`, meta);
    },

    load: async (filePath: string): Promise<void> => {
      let metaText: string;
      try {
        metaText = await fsp.readFile(`${filePath}.meta.json`, 'utf8');
      } catch (e) {
        return fail('embed/index-missing', `no index sidecar at ${filePath}.meta.json`, e);
      }
      let meta: SavedIndexMeta;
      try {
        meta = JSON.parse(metaText) as SavedIndexMeta;
      } catch (e) {
        return fail('embed/index-corrupt', `unparseable index sidecar ${filePath}.meta.json`, e);
      }
      // Loud refusal, naming both sides, BEFORE anything is read into the index.
      if (boundEmbedderId !== '' && meta.embedderId !== boundEmbedderId) {
        fail(
          'embed/embedder-mismatch',
          `index at ${filePath} was saved under embedder '${meta.embedderId}' but this index is bound to '${boundEmbedderId}' — re-embed, do not mix spaces`,
        );
      }
      if (boundDim > 0 && meta.dim !== boundDim) {
        fail(
          'embed/dim-mismatch',
          `index at ${filePath} is ${meta.dim}-d but this index is bound to ${boundDim}-d`,
        );
      }
      let buf: Buffer;
      try {
        buf = await fsp.readFile(`${filePath}.bin`);
      } catch (e) {
        return fail('embed/index-missing', `no index payload at ${filePath}.bin`, e);
      }
      const decoded = decode(buf, filePath);
      if (decoded.dim !== meta.dim || decoded.count !== meta.count) {
        fail(
          'embed/index-corrupt',
          `payload/sidecar disagreement at ${filePath}: payload is ${decoded.count}x${decoded.dim}-d, sidecar says ${meta.count}x${meta.dim}-d`,
        );
      }
      // Everything validated — only now swap state in. Nothing is partially loaded.
      entries = decoded.entries;
      runtimeDim = meta.dim;
    },
  };
};
