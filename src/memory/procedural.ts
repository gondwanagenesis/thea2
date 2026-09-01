// M09 memory — the ProceduralStore: the procedural channel's home. A genuinely
// separate store and index beside the episodic one, because the two channels
// never compete for slots and a tool record must never surface as a memory of
// an experience (the S3 gate tests exactly that). Records are the
// {situation → call → args → result → outcome} feedstock M08 synthesizes
// procedural exemplars from; ranking is outcome-scored here, before the
// assembler's score math.

import { z } from 'zod';
import { newId, type Clock, type Rng } from '../kernel/index.js';
import type { Embedder } from '../embed/index.js';
import type { DelegationPayload } from '../../schemas/events.js';
import { failMemory } from './errors.js';
import { openRecordStore, type RecordStore } from './record-store.js';

/**
 * Outcome multipliers applied inside `ProceduralStore.search`, before the
 * assembler's score math. The spec pins the direction (good boosts, bad
 * demotes) but not the magnitudes — ±25% is the proposed default, flagged in
 * the M09 build report.
 */
export const OUTCOME_WEIGHT: Record<ProcedureRecordBase['outcome'], number> = {
  good: 1.25,
  mixed: 1,
  bad: 0.75,
};

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export const ProcedureRecordSchema = z.object({
  id: z.string().min(1),
  /** The situation she was in — the text recall embeds and matches against. */
  situation: z.string().min(1),
  /** The tool (or spawn primitive) that was reached for. */
  call: z.string().min(1),
  /** JSON-serializable arguments (undefined is refused — a canonical-JSON row). */
  args: z.unknown(),
  /** JSON-serializable result/summary of what came back. */
  result: z.unknown(),
  outcome: z.enum(['good', 'mixed', 'bad']),
  ts: z.number(),
});

export interface ProcedureRecordBase {
  id: string;
  situation: string;
  call: string;
  args: unknown;
  result: unknown;
  outcome: 'good' | 'mixed' | 'bad';
  ts: number;
}

/** A record plus its embedding, once one has been produced for it. */
export interface ProcedureRecord extends ProcedureRecordBase {
  vec?: Float32Array;
}

const procedureIssue = (e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');

/** Score descending, id ascending — the same tie rule the index and the nominator use. */
const byScoreThenId = (
  a: { p: ProcedureRecord; score: number },
  b: { p: ProcedureRecord; score: number },
): number => {
  const diff = b.score - a.score;
  if (diff !== 0) return diff;
  return a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ProceduralStore {
  /** Validates, embeds the situation, and persists (row then index). */
  append(p: ProcedureRecordBase): Promise<void>;
  /**
   * Outcome-scored cosine top-k: `good` boosts, `bad` demotes, applied HERE so
   * every consumer (the nominator, the assembler's baseScore math) sees an
   * already outcome-aware score. Ordering stays deterministic (score desc, id asc).
   */
  search(vec: Float32Array, k: number): Array<{ p: ProcedureRecord; score: number }>;
  /** Every record, oldest first. */
  all(): ProcedureRecord[];
  size(): number;
  /** Batch-produce the vectors for these ids (recall calls it before rendering candidates). */
  vecsFor(ids: readonly string[]): Promise<void>;
  /** The cached embedding for a record, when one has been produced. */
  vecOf(id: string): Float32Array | undefined;
}

const withVec = (row: ProcedureRecordBase, vec: Float32Array | undefined): ProcedureRecord =>
  vec === undefined ? { ...row } : { ...row, vec };

export const openProceduralStore = async (dir: string, deps: { embedder: Embedder }): Promise<ProceduralStore> => {
  const records: RecordStore<ProcedureRecordBase> = await openRecordStore<ProcedureRecordBase>(dir, {
    base: 'procedural',
    indexBase: 'procedural-embeddings',
    embedder: deps.embedder,
    textOf: (p) => p.situation,
  });

  return {
    append: async (p) => {
      const parsed = ProcedureRecordSchema.safeParse(p);
      if (!parsed.success) {
        return failMemory(
          'memory/bad-procedure',
          `procedure '${p.id}' failed its boundary schema: ${procedureIssue(parsed.error)}`,
        );
      }
      // canonicalJson refuses undefined, and the record must survive the row log.
      if (p.args === undefined || p.result === undefined) {
        return failMemory('memory/bad-procedure', `procedure '${p.id}': args/result must be JSON values, not undefined`);
      }
      await records.append({ ...p }, p.situation);
    },

    search: (vec, k) =>
      records
        .search(vec, k)
        .map((hit) => ({ p: withVec(hit.row, hit.vec), score: hit.score * OUTCOME_WEIGHT[hit.row.outcome] }))
        // the weighting reorders the cosine ranking, so the contract's order is
        // re-established here: score desc, id asc (M04's tie rule).
        .sort(byScoreThenId),

    all: () => records.all().map((e) => withVec(e, records.vecOf(e.id))),
    size: () => records.size(),
    vecsFor: records.vecsFor,
    vecOf: records.vecOf,
  };
};

// ---------------------------------------------------------------------------
// Feedstock — M13's delegation episode events are what lands in here
// ---------------------------------------------------------------------------

export const procedureFromDelegation = (
  deps: { clock: Clock; rng: Rng },
  ev: DelegationPayload,
  parts: { ts: number },
): ProcedureRecordBase => ({
  id: newId(deps.clock, deps.rng),
  situation: ev.situation,
  call: ev.call,
  // The delegation payload carries summaries, not raw payloads — they are
  // stored as the string evidence they are, never re-parsed into structure.
  args: ev.argsSummary,
  result: ev.resultSummary,
  outcome: ev.outcome,
  ts: parts.ts,
});
