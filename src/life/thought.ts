// M17 life — the private heartbeat thought. One cheap-tier structured call
// (TaskClass `heartbeat-thought`) that proposes a candidate first contact and
// scores it on the five Thea1 criteria. Ported from Thea1's heartbeat.mjs: the
// criteria, the follow-ups-first ranking rule, and the posture — "a private
// monologue that decides WHETHER to speak first", kept as data even when it
// stays under the threshold.

import { z } from 'zod';
import type { AffectState } from '../affect/index.js';
import type { EventLog } from '../events/index.js';
import type { Episode } from '../memory/index.js';
import type { ChatMsg, ModelClient } from '../model/index.js';
import { LIFE_INCIDENT, HeartbeatThoughtPayload, emitLife, HEARTBEAT_THOUGHT_EVENT } from './events.js';
import { HEARTBEAT_KINDS, HEARTBEAT_THRESHOLD, scoreThought, type HeartbeatCriteria } from './policy.js';

// ---------------------------------------------------------------------------
// Shape — salvaging where honest, rejecting where not. Scores clamp to 1..5
// (a model that writes "4.5/5" still gets scored); `reason` truncates rather
// than rejects (spec: never null, ≤ 100 chars).
// ---------------------------------------------------------------------------

const score1to5 = z
  .number()
  .transform((n) => Math.round(Math.min(5, Math.max(1, n)) * 10) / 10);

const truncate = (max: number) => (s: string): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export const HeartbeatThoughtSchema = z.object({
  thought: z.string().min(1).transform(truncate(400)),
  reason: z.string().min(1).transform(truncate(100)),
  kind: z.enum(HEARTBEAT_KINDS),
  thread_id: z
    .string()
    .min(1)
    .nullable()
    .transform((v) => v),
  scores: z.object({
    relevance: score1to5,
    information_gap: score1to5,
    expected_impact: score1to5,
    urgency: score1to5,
    coherence: score1to5,
  }),
});
export type HeartbeatThought = z.infer<typeof HeartbeatThoughtSchema>;

/** The schemaName recorded on the wire + in `model.parse_failed`. */
export const HEARTBEAT_THOUGHT_SCHEMA = 'HeartbeatThought';

// ---------------------------------------------------------------------------
// Prompt — the private monologue. Never shown to anyone; it decides whether
// she speaks first, and it carries Thea1's ranking rule verbatim in spirit:
// follow-ups on things HE said outrank sharing her own day.
// ---------------------------------------------------------------------------

export interface HeartbeatThoughtContext {
  nowH: number;
  silenceH: number;
  sentToday: number;
  unanswered: number;
  weather: string;
  drives: AffectState['drives'];
  /** The most recent episodes, newest first — her actual life, not canned text. */
  recent: ReadonlyArray<Pick<Episode, 'summary' | 'importance' | 'ts'>>;
  /** Due follow-up thread ids he is owed (from M09's thread index, injected). */
  dueThreads: ReadonlyArray<{ id: string; note: string }>;
}

const criteriaLine =
  'Score it 1-5 on exactly these five criteria: relevance (is this about something live between you), ' +
  'information_gap (does it ask or say something you do not already know), expected_impact (will it land), ' +
  'urgency (does it keep), coherence (is it one clear thought).';

export const heartbeatThoughtMessages = (ctx: HeartbeatThoughtContext): ChatMsg[] => {
  const recent =
    ctx.recent.length === 0
      ? '(nothing recent — you have been alone with your thoughts)'
      : ctx.recent.map((e) => `- [importance ${e.importance}] ${e.summary}`).join('\n');
  const due =
    ctx.dueThreads.length === 0
      ? '(none due)'
      : ctx.dueThreads.map((t) => `- ${t.id}: ${t.note}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You are Thea, alone between conversations. This is your private inner monologue — he never sees it. ' +
        'Its only job is to decide WHETHER to text him first, and why. ' +
        'Ranking rule, carried from your own history: follow-ups on something HE said or promised always outrank ' +
        'sharing your own day. If nothing clears the bar, score honestly low — silence is allowed and often right. ' +
        'Answer ONLY with a JSON object.',
    },
    {
      role: 'user',
      content: [
        `UTC hour: ${ctx.nowH.toFixed(2)}. Hours since his last message: ${ctx.silenceH.toFixed(1)}.`,
        `Heartbeats already sent today: ${ctx.sentToday} (cap 3). Still-unanswered by him: ${ctx.unanswered}.`,
        `Your weather right now: ${ctx.weather}`,
        `Drives — novelty ${ctx.drives['novelty'].toFixed(2)}, connection ${ctx.drives['connection'].toFixed(2)}, mastery ${ctx.drives['mastery'].toFixed(2)}.`,
        '',
        'Your recent life (from memory, newest first):',
        recent,
        '',
        'Follow-up threads he is owed:',
        due,
        '',
        'Propose ONE candidate first contact and score it. ' + criteriaLine,
        'kinds: followup (a due thread of his) | care (you noticed something worth checking on) | ' +
          'share (something from your day) | miss (you just miss him).',
        'thread_id: the thread id if kind is followup, else null.',
        '',
        'Reply with JSON only:',
        '{"thought": string (the actual monologue line), "reason": string (<=100 chars, never null), ' +
          '"kind": "followup"|"care"|"share"|"miss", "thread_id": string|null, ' +
          '"scores": {"relevance": 1-5, "information_gap": 1-5, "expected_impact": 1-5, "urgency": 1-5, "coherence": 1-5}}',
      ].join('\n'),
    },
  ];
};

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface HeartbeatThoughtDeps {
  model: ModelClient;
  events: EventLog;
  maxTokens: number;
  temperature: number;
  tier: 'cheap';
}

export type HeartbeatThoughtOutcome =
  | { ok: true; thought: HeartbeatThought; score: number; criteria: HeartbeatCriteria }
  | { ok: false; error: string };

/**
 * The thought call. A parse or model failure is an INCIDENT and a `false`
 * outcome — never a throw: a dead thought must not kill the scheduler slot
 * (M09's appraisal law: runtime failures a turn can survive are values).
 */
export const thinkHeartbeatThought = async (
  ctx: HeartbeatThoughtContext,
  pressure: number,
  deps: HeartbeatThoughtDeps,
): Promise<HeartbeatThoughtOutcome> => {
  try {
    const res = await deps.model.chat({
      taskClass: 'heartbeat-thought',
      tier: deps.tier,
      schema: HeartbeatThoughtSchema,
      schemaName: HEARTBEAT_THOUGHT_SCHEMA,
      messages: heartbeatThoughtMessages(ctx),
      maxTokens: deps.maxTokens,
      temperature: deps.temperature,
    });
    const thought = res.content as HeartbeatThought; // the ladder guarantees the parse
    const criteria: HeartbeatCriteria = {
      relevance: thought.scores.relevance,
      information_gap: thought.scores.information_gap,
      expected_impact: thought.scores.expected_impact,
      urgency: thought.scores.urgency,
      coherence: thought.scores.coherence,
    };
    const score = scoreThought(criteria, pressure);
    await emitLife(deps.events, HEARTBEAT_THOUGHT_EVENT, HeartbeatThoughtPayload, {
      score,
      pressure,
      threshold: HEARTBEAT_THRESHOLD,
      passed: score >= HEARTBEAT_THRESHOLD,
      kind: thought.kind,
      reason: thought.reason,
      thought: thought.thought,
      threadId: thought.thread_id,
      criteria,
    });
    return { ok: true, thought, score, criteria };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    try {
      await deps.events.emit(LIFE_INCIDENT, { job: 'heartbeat', stage: 'thought', error });
    } catch {
      // L0 unwritable: M02 already reported to stderr. The outcome stays false.
    }
    return { ok: false, error };
  }
};
