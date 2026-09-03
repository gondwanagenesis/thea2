// M17 gate — the life L0 vocabulary. The spec's law: "why didn't she text
// today" must always have an answer in the log, so every fire and every no-fire
// lands an event whose payload carries the numbers behind the decision. Pins
// the kind strings, the payload schemas (accept AND reject tables), and
// emitLife's validate-then-land order: a broken payload is an incident FIRST,
// and the original event still lands — a broken payload beats a missing one.

import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  AFFECT_DAILY_EVENT,
  AffectDailyPayload,
  HEARTBEAT_PRE_EVENT,
  HEARTBEAT_SENT_EVENT,
  HEARTBEAT_THOUGHT_EVENT,
  HeartbeatPrePayload,
  HeartbeatSentPayload,
  HeartbeatThoughtPayload,
  LIFE_INCIDENT,
  LifeIncidentPayload,
  PONDER_ARTIFACT_EVENT,
  PONDER_GATE_EVENT,
  PONDER_SEED_EVENT,
  PONDER_SKIPPED_EVENT,
  PonderArtifactPayload,
  PonderGatePayload,
  PonderSeedPayload,
  PonderSkippedPayload,
  REFLECTED_EVENT,
  ReflectedPayload,
  emitLife,
  type HeartbeatThoughtPayload as HeartbeatThoughtPayloadShape,
} from '../../src/life/events.js';
import { recordingLog, type RecordingLog } from './helpers.js';

// ---------------------------------------------------------------------------
// The kind strings — the Ledger's daily report renders these
// ---------------------------------------------------------------------------

describe('the event kind vocabulary', () => {
  it('names every decision the life layer can make', () => {
    expect(HEARTBEAT_PRE_EVENT).toBe('life.heartbeat.pre'); // EVERY firing, pass or fail
    expect(HEARTBEAT_THOUGHT_EVENT).toBe('life.heartbeat.thought'); // kept even under threshold
    expect(HEARTBEAT_SENT_EVENT).toBe('life.heartbeat.sent'); // actually reached the channel
    expect(PONDER_GATE_EVENT).toBe('life.ponder.gate');
    expect(PONDER_SKIPPED_EVENT).toBe('life.ponder.skipped');
    expect(PONDER_ARTIFACT_EVENT).toBe('life.ponder.artifact');
    expect(PONDER_SEED_EVENT).toBe('life.ponder.seed');
    expect(AFFECT_DAILY_EVENT).toBe('life.affect_daily');
    expect(REFLECTED_EVENT).toBe('life.reflected');
    expect(LIFE_INCIDENT).toBe('incident.life_failed');
  });

  it('every kind satisfies the M02 dot-namespace law, incidents included', () => {
    for (const kind of [
      HEARTBEAT_PRE_EVENT,
      HEARTBEAT_THOUGHT_EVENT,
      HEARTBEAT_SENT_EVENT,
      PONDER_GATE_EVENT,
      PONDER_SKIPPED_EVENT,
      PONDER_ARTIFACT_EVENT,
      PONDER_SEED_EVENT,
      AFFECT_DAILY_EVENT,
      REFLECTED_EVENT,
      LIFE_INCIDENT,
    ]) {
      expect(kind).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Payload schemas — accept and reject tables
// ---------------------------------------------------------------------------

const affectDaily = { sinceTs: 1, untilTs: 2, emotionEvents: 3, tags: { fond: 2, longing: 1 }, topTags: ['fond'] };

const goodPayloads: ReadonlyArray<readonly [string, ZodType, unknown]> = [
  ['heartbeat.pre', HeartbeatPrePayload, {
    nowH: 14,
    canText: true,
    reason: 'ok',
    owedInbound: 0,
    sentToday: 0,
    unanswered: 0,
    lastUnansweredAgeH: 0,
    mutexActive: false,
  }],
  ['heartbeat.thought', HeartbeatThoughtPayload, {
    score: 4.3,
    pressure: 0.3,
    threshold: 3.2,
    passed: true,
    kind: 'followup',
    reason: 'a due thread of his',
    thought: 'the crates shipped; ask how they landed',
    threadId: 'thread_crates',
    criteria: { relevance: 4, information_gap: 4, expected_impact: 4, urgency: 4, coherence: 4 },
  }],
  ['heartbeat.sent', HeartbeatSentPayload, { turnId: 'turn_hb1', kind: 'care', bubbles: 2 }],
  ['ponder.gate', PonderGatePayload, { score: 0.46, pass: true, novelty: 0.5, arousal: 0.4, hoursSinceArtifact: 2 }],
  ['ponder.skipped', PonderSkippedPayload, { reason: 'gate', detail: '0.41 < 0.45' }],
  ['ponder.artifact', PonderArtifactPayload, {
    turnId: 'turn_p1',
    episodeId: 'ep_1',
    about: 'world',
    topic: 'slot math',
    artifact: 'insight',
    conclusion: 'the horizon is the bug',
    saliency: 0.7,
    revised: false,
  }],
  ['ponder.seed', PonderSeedPayload, { about: 'self', topic: 'my drift', saliency: 0.5, avoided: 'diego' }],
  ['affect_daily', AffectDailyPayload, affectDaily],
  ['reflected', ReflectedPayload, { nightly: 'ok', statusProjection: 'ok', affectDaily }],
  ['incident.life_failed', LifeIncidentPayload, { job: 'heartbeat', stage: 'thought', error: 'model/transport: down' }],
];

describe('payload schemas accept the canonical payloads', () => {
  for (const [name, schema, payload] of goodPayloads) {
    it(`${name}: a well-formed payload validates`, () => {
      expect(schema.safeParse(payload).success).toBe(true);
    });
  }
});

describe('payload schemas reject the payloads that would lie in the ledger', () => {
  it('heartbeat.pre: a non-integer sentToday or a boolean-as-string canText', () => {
    expect(HeartbeatPrePayload.safeParse({ nowH: 14, canText: true, reason: 'ok', sentToday: 1.5, unanswered: 0, lastUnansweredAgeH: 0, mutexActive: false }).success).toBe(false);
    expect(HeartbeatPrePayload.safeParse({ nowH: 14, canText: 'yes', reason: 'ok', sentToday: 0, unanswered: 0, lastUnansweredAgeH: 0, mutexActive: false }).success).toBe(false);
  });

  it('heartbeat.thought: a kind outside the four, or criteria missing a criterion', () => {
    const base = goodPayloads[1]?.[2] as HeartbeatThoughtPayloadShape;
    expect(HeartbeatThoughtPayload.safeParse({ ...base, kind: 'gossip' }).success).toBe(false);
    const { coherence: _dropped, ...partial } = base.criteria;
    expect(HeartbeatThoughtPayload.safeParse({ ...base, criteria: partial }).success).toBe(false);
  });

  it('ponder.artifact: "nothing" never lands here — that is ponder.skipped', () => {
    expect(PonderArtifactPayload.safeParse({
      turnId: 'turn_p1',
      episodeId: 'ep_1',
      about: 'world',
      topic: 'slot math',
      artifact: 'nothing',
      conclusion: 'dropped',
      saliency: 0.7,
      revised: false,
    }).success).toBe(false);
  });

  it('ponder.seed: the about class is closed, while avoided is a free-string class name', () => {
    expect(PonderSeedPayload.safeParse({ about: 'himself', topic: 't', saliency: 0.5, avoided: null }).success).toBe(false);
    expect(PonderSeedPayload.safeParse({ about: 'self', topic: 't', saliency: 0.5, avoided: 'diego' }).success).toBe(true);
  });

  it('affect_daily: counts are integers; reflected: nightly is a closed enum', () => {
    expect(AffectDailyPayload.safeParse({ ...affectDaily, emotionEvents: 2.5 }).success).toBe(false);
    expect(AffectDailyPayload.safeParse({ ...affectDaily, tags: { fond: 1.5 } }).success).toBe(false);
    expect(ReflectedPayload.safeParse({ nightly: 'skipped', statusProjection: 'ok', affectDaily }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emitLife — validate-then-land
// ---------------------------------------------------------------------------

describe('emitLife', () => {
  const pre = {
    nowH: 14,
    canText: false,
    reason: 'backoff',
    owedInbound: 0,
    sentToday: 1,
    unanswered: 1,
    lastUnansweredAgeH: 2,
    mutexActive: false,
  };

  it('lands a valid payload verbatim under its kind, carrying the turnId', async () => {
    const log: RecordingLog = recordingLog();
    await emitLife(log, HEARTBEAT_PRE_EVENT, HeartbeatPrePayload, pre, 'turn_hb9');
    expect(log.kinds()).toEqual([HEARTBEAT_PRE_EVENT]);
    expect(log.rows[0]?.payload).toEqual(pre);
    expect(log.rows[0]?.turnId).toBe('turn_hb9');
  });

  it('omits the turnId when the caller gave none', async () => {
    const log = recordingLog();
    await emitLife(log, HEARTBEAT_PRE_EVENT, HeartbeatPrePayload, pre);
    expect('turnId' in (log.rows[0] ?? {})).toBe(false);
  });

  it('a broken payload incidents FIRST and still lands the original event — the why is never lost', async () => {
    const log = recordingLog();
    const broken = { ...pre, sentToday: 1.5 } as unknown as typeof pre;
    await emitLife(log, HEARTBEAT_PRE_EVENT, HeartbeatPrePayload, broken);

    expect(log.kinds()).toEqual([LIFE_INCIDENT, HEARTBEAT_PRE_EVENT]); // the order is the law
    const incident = log.rows[0]?.payload as { job: string; stage: string; error: string };
    expect(incident.job).toBe('life');
    expect(incident.stage).toBe('emit life.heartbeat.pre');
    expect(incident.error).toContain('sentToday');
    expect(log.rows[1]?.payload).toEqual(broken); // the raw payload, not a dropped event
  });

  it('names the emitting kind in the incident stage, for any schema', async () => {
    const log = recordingLog();
    await emitLife(log, PONDER_GATE_EVENT, PonderGatePayload, { score: 'high' } as never);
    expect(log.kinds()).toEqual([LIFE_INCIDENT, PONDER_GATE_EVENT]);
    expect((log.rows[0]?.payload as { stage: string }).stage).toBe('emit life.ponder.gate');
  });
});
