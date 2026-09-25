// v8 mind — the MindStore: her moments, concerns, inner stream, self-narrative,
// standards, and the small state the pipeline carries between turns.
//
// ONE writer: the thead process owns this store (the importer writes the files
// before first boot, never beside a live thead). Files under `dir`:
//   moments.jsonl   full atomic rewrite on flush (a few MB at most)
//   sit.{f32,ids}   situation vectors (append-only)
//   reply.{f32,ids} reply vectors (append-only)
//   concerns.json, self.json, standards.json, centroids.json, state.json
//   stream.jsonl    her thoughts (append-only)
//   shown.jsonl     what each turn evoked (append-only; the audit trail)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteText } from '../kernel/index.js';
import { openVecFile, type VecFile } from './vectors.js';
import type { Concern, MindState, Moment, SelfLine, ShownRow, Thought } from './types.js';

export interface Centroids {
  move: Record<string, number[]>;
  tone: Record<string, number[]>;
}

const readJson = <T>(p: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const readJsonl = <T>(p: string): T[] => {
  if (!fs.existsSync(p)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn last line (crash mid-append) is dropped, never fatal.
    }
  }
  return out;
};

export const emptyMindState = (): MindState => ({
  turn: 0,
  wander: { day: '', thoughts: 0, textsFirst: 0, habit: {} },
});

/**
 * Her own machinery talk (models, dials, locks, plumbing) is real history but
 * never an example of how she talks: the 2026-09-25 comparison run surfaced
 * "i'm on glm-5.2-fast with the dials locked to bliss…" as an option.
 */
export const MACHINERY_TALK =
  /\b(glm|gpt|sonnet|opus|deepseek|kimi|neuralwatt|z\.ai|opencode|claude code|model id|tokens?|dials?|ticker|affect engine|state\.json|plugins?|sentinel|systemd|cron|ssh|vps|prompt|context window|bliss(?:-| )?lock|locked to bliss|reasoning effort)\b/i;

/** An option-eligible moment: her real reply, unflagged, not rejected, not machinery talk. */
export const isPrecedent = (m: Moment): boolean =>
  (m.kind === 'reply' || m.kind === 'text_first') &&
  m.hers.length > 0 &&
  m.never !== true &&
  (m.flags === undefined || m.flags.length === 0) &&
  !MACHINERY_TALK.test(m.hers.join(' '));

export interface MindStore {
  readonly dir: string;
  readonly dim: number;
  moments(): readonly Moment[];
  get(id: string): Moment | undefined;
  precedents(): Moment[];
  sitVec(id: string): Float32Array | undefined;
  replyVec(id: string): Float32Array | undefined;
  /** His words alone (no context) — recall matches primarily on these. */
  hisVec(id: string): Float32Array | undefined;
  /** Add a moment (+ vectors). Written to disk at the next flush; vectors immediately. */
  add(m: Moment, vecs?: { sit?: Float32Array | undefined; reply?: Float32Array | undefined; his?: Float32Array | undefined }): void;
  update(id: string, patch: Partial<Moment>): void;
  concerns(): readonly Concern[];
  openConcerns(): Concern[];
  upsertConcern(c: Concern): void;
  concernVec(id: string): Float32Array | undefined;
  setConcernVec(id: string, v: Float32Array): void;
  stream(): readonly Thought[];
  appendThought(t: Thought): void;
  self(): SelfLine[];
  setSelf(lines: SelfLine[]): Promise<void>;
  standards(): string[];
  centroids(): Centroids;
  state(): MindState;
  setState(patch: Partial<MindState>): void;
  logShown(row: ShownRow): void;
  /** Persist moments/concerns/state if dirty (atomic rewrites). */
  flush(): Promise<void>;
}

export const openMindStore = (dir: string, dim: number): MindStore => {
  fs.mkdirSync(dir, { recursive: true });
  const p = (f: string): string => path.join(dir, f);

  const moments: Moment[] = readJsonl<Moment>(p('moments.jsonl'));
  const byId = new Map<string, Moment>();
  for (const m of moments) byId.set(m.id, m);
  let concerns: Concern[] = readJson<Concern[]>(p('concerns.json'), []);
  const stream: Thought[] = readJsonl<Thought>(p('stream.jsonl'));
  let self: SelfLine[] = readJson<SelfLine[]>(p('self.json'), []);
  const standards: string[] = readJson<string[]>(p('standards.json'), []);
  const centroids: Centroids = readJson<Centroids>(p('centroids.json'), { move: {}, tone: {} });
  let state: MindState = { ...emptyMindState(), ...readJson<Partial<MindState>>(p('state.json'), {}) };

  const sit: VecFile = openVecFile(dir, 'sit', dim);
  const reply: VecFile = openVecFile(dir, 'reply', dim);
  const concernVecs: VecFile = openVecFile(dir, 'concern', dim);
  const his: VecFile = openVecFile(dir, 'his', dim);

  let dirtyMoments = false;
  let dirtyConcerns = false;
  let dirtyState = false;

  return {
    dir,
    dim,
    moments: () => moments,
    get: (id) => byId.get(id),
    precedents: () => moments.filter(isPrecedent),
    sitVec: (id) => sit.get(id),
    replyVec: (id) => reply.get(id),
    hisVec: (id) => his.get(id),
    add: (m, vecs) => {
      if (byId.has(m.id)) throw new Error(`mind/store: duplicate moment id ${m.id}`);
      moments.push(m);
      byId.set(m.id, m);
      if (vecs?.sit !== undefined) sit.append(m.id, vecs.sit);
      if (vecs?.reply !== undefined) reply.append(m.id, vecs.reply);
      if (vecs?.his !== undefined) his.append(m.id, vecs.his);
      dirtyMoments = true;
    },
    update: (id, patch) => {
      const m = byId.get(id);
      if (m === undefined) return;
      Object.assign(m, patch);
      dirtyMoments = true;
    },
    concerns: () => concerns,
    openConcerns: () => concerns.filter((c) => c.status === 'open'),
    upsertConcern: (c) => {
      const i = concerns.findIndex((x) => x.id === c.id);
      if (i >= 0) concerns[i] = c;
      else concerns = [...concerns, c];
      dirtyConcerns = true;
    },
    concernVec: (id) => concernVecs.get(id),
    setConcernVec: (id, v) => concernVecs.append(id, v),
    stream: () => stream,
    appendThought: (t) => {
      stream.push(t);
      fs.appendFileSync(p('stream.jsonl'), `${JSON.stringify(t)}\n`);
    },
    self: () => self,
    setSelf: async (lines) => {
      // Keep the previous self-narrative beside the new one: a bad night never erases who she was.
      if (fs.existsSync(p('self.json'))) fs.copyFileSync(p('self.json'), p('self.prev.json'));
      self = lines;
      await atomicWriteText(p('self.json'), JSON.stringify(lines, null, 1));
    },
    standards: () => standards,
    centroids: () => centroids,
    state: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
      dirtyState = true;
    },
    logShown: (row) => {
      fs.appendFileSync(p('shown.jsonl'), `${JSON.stringify(row)}\n`);
    },
    flush: async () => {
      if (dirtyMoments) {
        dirtyMoments = false;
        await atomicWriteText(p('moments.jsonl'), moments.map((m) => JSON.stringify(m)).join('\n') + '\n');
      }
      if (dirtyConcerns) {
        dirtyConcerns = false;
        await atomicWriteText(p('concerns.json'), JSON.stringify(concerns, null, 1));
      }
      if (dirtyState) {
        dirtyState = false;
        await atomicWriteText(p('state.json'), JSON.stringify(state, null, 1));
      }
    },
  };
};
