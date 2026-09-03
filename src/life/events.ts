// M17 life — the L0 vocabulary. "Why didn't she text today" must always have an
// answer in the log (spec): every fire and every no-fire lands an event here,
// and the Ledger's daily report renders these. Payloads carry the numbers
// behind each decision, never prose blobs.

import { z } from 'zod';
import type { EventLog } from '../events/index.js';
import { HEARTBEAT_KINDS, PONDER_ABOUTS, type HeartbeatCriteria } from './policy.js';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** Emitted on EVERY heartbeat firing, pass or fail — the reason is the answer. */
export const HEARTBEAT_PRE_EVENT = 'life.heartbeat.pre';
/** The private thought, kept whether or not it crossed the threshold. */
export const HEARTBEAT_THOUGHT_EVENT = 'life.heartbeat.thought';
/** Additive: a heartbeat entry actually reached the channel. */
export const HEARTBEAT_SENT_EVENT = 'life.heartbeat.sent';
/** The ponder gate's verdict, with the three features that produced it. */
export const PONDER_GATE_EVENT = 'life.ponder.gate';
/** Emitted when the ponder fire ended without an artifact (gate fail, committee fail, 'nothing'). */
export const PONDER_SKIPPED_EVENT = 'life.ponder.skipped';
/** A ponder artifact landed as an episode. */
export const PONDER_ARTIFACT_EVENT = 'life.ponder.artifact';
/** Emitted by the ponder job after a seed lands — the balance rule's history. */
export const PONDER_SEED_EVENT = 'life.ponder.seed';
/** Nightly reflection's affect digest (the day's emotional weather, folded). */
export const AFFECT_DAILY_EVENT = 'life.affect_daily';
/** The nightly reflection report — what ran, what failed. */
export const REFLECTED_EVENT = 'life.reflected';
/** A life job survived an internal failure (thought parse, committee misshape). */
export const LIFE_INCIDENT = 'incident.life_failed';

// ---------------------------------------------------------------------------
// Payload schemas — zod-checked at the emit sites, the same wall the other
// modules put in front of their own payloads.
// ---------------------------------------------------------------------------

export const HeartbeatPrePayload = z.object({
  /** Local (configured-zone) fractional hour of the fire. */
  nowH: z.number(),
  canText: z.boolean(),
  reason: z.string(),
  /** LOST_REPLY count reconcile reported at fire time — the 'owed' gate's input. */
  owedInbound: z.number().int(),
  sentToday: z.number().int(),
  unanswered: z.number().int(),
  lastUnansweredAgeH: z.number(),
  mutexActive: z.boolean(),
});
export type HeartbeatPrePayload = z.infer<typeof HeartbeatPrePayload>;

const criteriaShape = {
  relevance: z.number(),
  information_gap: z.number(),
  expected_impact: z.number(),
  urgency: z.number(),
  coherence: z.number(),
} as const;

export const HeartbeatThoughtPayload = z.object({
  score: z.number(),
  pressure: z.number(),
  threshold: z.number(),
  passed: z.boolean(),
  kind: z.enum(HEARTBEAT_KINDS),
  reason: z.string(),
  thought: z.string(),
  threadId: z.string().nullable(),
  criteria: z.object(criteriaShape) satisfies z.ZodType<HeartbeatCriteria>,
});
export type HeartbeatThoughtPayload = z.infer<typeof HeartbeatThoughtPayload>;

export const HeartbeatSentPayload = z.object({
  turnId: z.string(),
  kind: z.enum(HEARTBEAT_KINDS),
  bubbles: z.number().int(),
});
export type HeartbeatSentPayload = z.infer<typeof HeartbeatSentPayload>;

export const PonderGatePayload = z.object({
  score: z.number(),
  pass: z.boolean(),
  novelty: z.number(),
  arousal: z.number(),
  hoursSinceArtifact: z.number(),
});
export type PonderGatePayload = z.infer<typeof PonderGatePayload>;

export const PonderSkippedPayload = z.object({
  reason: z.string(),
  detail: z.string().optional(),
});
export type PonderSkippedPayload = z.infer<typeof PonderSkippedPayload>;

export const PonderArtifactPayload = z.object({
  turnId: z.string(),
  episodeId: z.string(),
  about: z.enum(PONDER_ABOUTS),
  topic: z.string(),
  /** The artifact class — 'nothing' never lands here (that is ponder.skipped). */
  artifact: z.enum(['insight', 'question', 'plan']),
  conclusion: z.string(),
  saliency: z.number(),
  revised: z.boolean(),
});
export type PonderArtifactPayload = z.infer<typeof PonderArtifactPayload>;

export const PonderSeedPayload = z.object({
  about: z.enum(PONDER_ABOUTS),
  topic: z.string(),
  saliency: z.number(),
  avoided: z.string().nullable(),
});
export type PonderSeedPayload = z.infer<typeof PonderSeedPayload>;

export const AffectDailyPayload = z.object({
  sinceTs: z.number(),
  untilTs: z.number(),
  emotionEvents: z.number().int(),
  /** tag -> count over the day's `affect.applied` events. */
  tags: z.record(z.string(), z.number().int()),
  topTags: z.array(z.string()),
});
export type AffectDailyPayload = z.infer<typeof AffectDailyPayload>;

export const ReflectedPayload = z.object({
  nightly: z.enum(['ok', 'failed', 'absent']),
  statusProjection: z.enum(['ok', 'failed']),
  affectDaily: AffectDailyPayload,
});
export type ReflectedPayload = z.infer<typeof ReflectedPayload>;

export const LifeIncidentPayload = z.object({
  job: z.string(),
  stage: z.string(),
  error: z.string(),
});
export type LifeIncidentPayload = z.infer<typeof LifeIncidentPayload>;

// ---------------------------------------------------------------------------
// Emit helper — validate-then-land, so a bad payload is a loud type error at
// the call site instead of a malformed row in the log.
// ---------------------------------------------------------------------------

export const emitLife = async <S extends z.ZodType>(
  events: EventLog,
  kind: string,
  schema: S,
  payload: z.output<S>,
  turnId?: string,
): Promise<void> => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
    // The incident names the real failure; the original event still lands so
    // the "why" is never lost — a broken payload beats a missing one.
    await events.emit(LIFE_INCIDENT, { job: 'life', stage: `emit ${kind}`, error: detail } satisfies LifeIncidentPayload);
    await events.emit(kind, payload as unknown, turnId);
    return;
  }
  await events.emit(kind, parsed.data as unknown, turnId);
};
