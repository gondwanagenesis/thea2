// M09 memory — the EpisodeStore: her durable experience record. One episode per
// appraised turn; `episodes.jsonl` is the record of truth, `embeddings.bin` the
// derived vector index (M04, keyed by episode id). The stamp is the point of
// the whole design (mood-congruent memory): an episode carries the FULL affect
// vector of the room it was formed in, frozen at encoding, which M10 later
// writes verbatim into lived exemplars.

import { z } from 'zod';
import { newId, type Clock, type Rng } from '../kernel/index.js';
import type { Embedder } from '../embed/index.js';
import { AFFECT_DIMS } from '../../schemas/exemplar.js';
import { AppraisedEmotionSchema, type Appraisal } from './appraisal.js';
import { failMemory } from './errors.js';
import { openRecordStore, type RecordStore } from './record-store.js';

// ---------------------------------------------------------------------------
// Shape — validated at the store boundary, the same wall M05 puts in front of
// its engine: a malformed episode is refused, never half-remembered.
// ---------------------------------------------------------------------------

export const EpisodeSchema = z.object({
  id: z.string().min(1),
  ts: z.number(),
  turnId: z.string().min(1),
  /** Her experience, first person, one line — what recall embeds and ranks. */
  summary: z.string().min(1),
  /** The appraisal's diary line; journal.md renders this verbatim. */
  diaryLine: z.string().min(1),
  /** 1-10, straight off the appraisal. */
  importance: z.number().int().min(1).max(10),
  emotions: z.array(AppraisedEmotionSchema),
  /** Thread ids this episode touched (drives byThread and the threads.json rebuild). */
  threads: z.array(z.string().min(1)),
  /**
   * FULL Vec12 stamp at encoding: AFFECT_DIMS order (schemas/exemplar.ts),
   * deviation coords in [-1, 1] — i.e. M06's `signature()` output. M09 stores
   * and hands it back verbatim; interpreting it is coupling's job.
   */
  affectAtEncoding: z.array(z.number()).length(AFFECT_DIMS.length),
});
export type EpisodeRecord = z.infer<typeof EpisodeSchema>;

/** A record plus its embedding, once one has been produced for it. */
export interface Episode extends EpisodeRecord {
  vec?: Float32Array;
}

const episodeIssue = (e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EpisodeStore {
  /** Validates, embeds the summary, and persists (row then index). */
  append(e: EpisodeRecord): Promise<void>;
  /** Cosine top-k (M04 semantics: score desc, id asc). Composite ranking lives in the nominator. */
  search(vec: Float32Array, k: number): Array<{ e: Episode; score: number }>;
  /** The n most recent episodes, newest first. */
  recent(n: number): Episode[];
  /** Episodes touching a thread, newest first. */
  byThread(id: string): Episode[];
  /** Every episode, oldest first — the projections' feedstock. */
  all(): Episode[];
  size(): number;
  /** Batch-produce the vectors for these ids (recall calls it before rendering candidates). */
  vecsFor(ids: readonly string[]): Promise<void>;
  /** The cached embedding for an episode, when one has been produced. */
  vecOf(id: string): Float32Array | undefined;
}

const withVec = (row: EpisodeRecord, vec: Float32Array | undefined): Episode =>
  vec === undefined ? { ...row } : { ...row, vec };

export const openEpisodeStore = async (dir: string, deps: { embedder: Embedder }): Promise<EpisodeStore> => {
  const records: RecordStore<EpisodeRecord> = await openRecordStore<EpisodeRecord>(dir, {
    base: 'episodes',
    indexBase: 'embeddings',
    embedder: deps.embedder,
    textOf: (e) => e.summary,
  });

  return {
    append: async (e) => {
      const parsed = EpisodeSchema.safeParse(e);
      if (!parsed.success) {
        return failMemory('memory/bad-episode', `episode '${e.id}' failed its boundary schema: ${episodeIssue(parsed.error)}`);
      }
      await records.append(parsed.data, parsed.data.summary);
    },

    search: (vec, k) => records.search(vec, k).map((hit) => ({ e: withVec(hit.row, hit.vec), score: hit.score })),

    recent: (n) => {
      if (n <= 0) return [];
      const all = records.all();
      return all.slice(Math.max(0, all.length - n)).reverse().map((e) => withVec(e, records.vecOf(e.id)));
    },

    byThread: (id) =>
      records
        .all()
        .filter((e) => e.threads.includes(id))
        .reverse()
        .map((e) => withVec(e, records.vecOf(e.id))),

    all: () => records.all().map((e) => withVec(e, records.vecOf(e.id))),
    size: () => records.size(),
    vecsFor: records.vecsFor,
    vecOf: records.vecOf,
  };
};

// ---------------------------------------------------------------------------
// Draft building — the pipeline's one-stop appraisal → episode mapping
// ---------------------------------------------------------------------------

export interface EpisodeDraftDeps {
  clock: Clock;
  rng: Rng;
  /**
   * The live affect Vec12, read at encoding time (mood congruence). Supplied as
   * a thunk rather than a value so the stamp is whatever the state is in the
   * moment the episode is drafted — never a stale copy a caller took earlier.
   */
  affectAt: () => readonly number[];
}

export interface EpisodeDraftParts {
  turnId: string;
  ts: number;
  appraisal: Appraisal;
}

/**
 * summary and diaryLine are the same line in v1 because the Appraisal schema
 * emits exactly one — they stay separate fields so a future appraisal revision
 * can split the projection line from the recall text without a store migration.
 */
export const draftEpisode = (deps: EpisodeDraftDeps, parts: EpisodeDraftParts): EpisodeRecord => {
  const stamp = deps.affectAt();
  if (stamp.length !== AFFECT_DIMS.length) {
    return failMemory(
      'memory/affect-stamp',
      `affectAtEncoding must be a full ${AFFECT_DIMS.length}-dim Vec12 in AFFECT_DIMS order, got ${stamp.length}`,
    );
  }
  return {
    id: newId(deps.clock, deps.rng),
    ts: parts.ts,
    turnId: parts.turnId,
    summary: parts.appraisal.diaryLine,
    diaryLine: parts.appraisal.diaryLine,
    importance: parts.appraisal.importance,
    emotions: parts.appraisal.emotions.map((e) => ({ ...e })),
    threads: parts.appraisal.threads.map((t) => t.id),
    affectAtEncoding: [...stamp],
  };
};
