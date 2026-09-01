// test/memory — the per-turn appraisal: ladder shape, the previous-turn grade
// event, and graceful degradation (a broken appraisal must never fail the turn).

import { describe, expect, it } from 'vitest';
import { EMOTION_TAGS } from '../../src/affect/index.js';
import { MockModel } from '../../src/model/index.js';
import type { ScriptedResponse } from '../../src/model/index.js';
import {
  APPRAISAL_FAILED_INCIDENT,
  APPRAISAL_MAX_TOKENS,
  APPRAISAL_SCHEMA_NAME,
  APPRAISAL_TEMPERATURE,
  OUTCOME_PREV_KIND,
  PARSE_FAILED_INCIDENT,
  affectEvents,
  appraise,
} from '../../src/memory/index.js';
import { memoryLog } from './helpers.js';

const happyArgs = () => ({
  importance: 7,
  emotions: [{ tag: 'fond', i: 6, cause: 'he wrote first' }],
  diaryLine: 'he remembered the thing I said',
  threads: [{ id: 'jazz', title: 'Jazz night', status: 'open' }],
  outcomePrev: { sign: 1, evidence: 'he said "gracias, eso era"' },
});

const emitCall = (args: unknown): ScriptedResponse => ({
  toolCalls: [{ name: 'emit', args }],
});

/** One appraise call over a scripted model, everything wired to one L0 log. */
const run = async (
  scripts: readonly ScriptedResponse[],
  prevTurnId: string | null = 'turn_prev',
  turnId: string | undefined = 'turn_cur',
) => {
  const { log, events } = memoryLog();
  const model = new MockModel({ log });
  for (const s of scripts) model.enqueue(s);
  const out = await appraise(
    {
      userText: 'te acuerdas del concierto de jazz?',
      herReply: 'sí, y todavía me río',
      plan: 'reply',
      prevTurnId,
      ...(turnId !== undefined ? { turnId } : {}),
    },
    { model, events: log },
  );
  return { out, events, model };
};

describe('appraise — the happy path', () => {
  it('parses ONE cheap-tier structured call through the emit ladder and grades the previous turn', async () => {
    const { out, events, model } = await run([emitCall(happyArgs())]);

    if (!out.ok) throw new Error(`expected ok, got ${out.error}`);
    expect(out.appraisal).toEqual(happyArgs());

    // exactly one logical call, cheap tier, structured request
    expect(model.calls).toHaveLength(1);
    const req = model.calls[0]!;
    expect(req.taskClass).toBe('appraisal');
    expect(req.tier).toBe('cheap');
    expect(req.maxTokens).toBe(APPRAISAL_MAX_TOKENS);
    expect(req.temperature).toBe(APPRAISAL_TEMPERATURE);
    expect(req.schemaName).toBe(APPRAISAL_SCHEMA_NAME);
    expect(req.schema).toBeDefined();
    expect(req.tools).toBeUndefined();

    // the previous packet's grade left as a typed L0 event, verbatim evidence
    const grades = events.filter((e) => e.kind === OUTCOME_PREV_KIND);
    expect(grades).toHaveLength(1);
    expect(grades[0]!.payload).toEqual({
      turnId: 'turn_prev',
      sign: 1,
      evidence: 'he said "gracias, eso era"',
    });
    expect(grades[0]!.turnId).toBe('turn_cur');

    const calls = events.filter((e) => e.kind === 'model.call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toMatchObject({ taskClass: 'appraisal', tier: 'cheap', outcome: 'ok' });
  });

  it('hands M05 typed affect events — never regex over prose', async () => {
    const { out } = await run([emitCall(happyArgs())]);
    if (!out.ok) throw new Error(out.error);
    expect(affectEvents(out.appraisal)).toEqual([{ kind: 'emotion', tag: 'fond', i: 6, cause: 'he wrote first' }]);
  });

  it('does not grade a previous turn at session start, even if the model answers one', async () => {
    const { out, events } = await run([emitCall({ ...happyArgs(), outcomePrev: { sign: -1, evidence: 'invented' } })], null);
    if (!out.ok) throw new Error(out.error);
    // the appraisal stays verbatim (inspectable), but no grade is attached to nothing
    expect(out.appraisal.outcomePrev).toEqual({ sign: -1, evidence: 'invented' });
    expect(events.filter((e) => e.kind === OUTCOME_PREV_KIND)).toHaveLength(0);
  });
});

describe('appraise — graceful degradation', () => {
  it('repairs once on the cheap tier, then fails the appraisal, not the turn', async () => {
    const { out, events, model } = await run([
      { content: 'i will not emit today' }, // rung (b): no emit tool
      { content: 'still not json' }, // the one repair, rung (c)
    ]);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error).toContain('model/parse-failed');

    expect(model.calls).toHaveLength(2); // original + exactly one repair
    expect(model.calls[1]!.tier).toBe('cheap');

    const incidents = events.filter((e) => e.kind === PARSE_FAILED_INCIDENT);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.payload).toMatchObject({ schema: APPRAISAL_SCHEMA_NAME, code: 'model/parse-failed' });
    // M03 said it too: the ladder's own parse-failed row, then memory's incident
    expect(events.filter((e) => e.kind === 'model.parse_failed')).toHaveLength(1);
    expect(events.filter((e) => e.kind === OUTCOME_PREV_KIND)).toHaveLength(0);

    expect(events.filter((e) => e.kind === 'model.call')[0]!.payload).toMatchObject({ outcome: 'error' });
  });

  it('rejects an invented emotion tag — the vocabulary wall holds, nothing applies partially', async () => {
    const invented = { ...happyArgs(), emotions: [{ tag: 'euphoric', i: 8, cause: 'made up' }] };
    const { out, events } = await run([
      emitCall(invented),
      { content: JSON.stringify(invented) }, // repair returns the same invented tag
    ]);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error).toContain('model/parse-failed');
    // no grade, no affect, no partial application
    expect(events.filter((e) => e.kind === OUTCOME_PREV_KIND)).toHaveLength(0);
    expect(events.filter((e) => e.kind === PARSE_FAILED_INCIDENT)).toHaveLength(1);
  });

  it('degrades on a transport failure with its own incident kind', async () => {
    const { out, events } = await run([{ error: { code: 'model/transport', message: 'socket reset' } }]);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error).toContain('model/transport');
    const incidents = events.filter((e) => e.kind === APPRAISAL_FAILED_INCIDENT);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.payload).toMatchObject({ schema: APPRAISAL_SCHEMA_NAME, code: 'model/transport' });
  });

  it('still completes when the L0 log itself is broken (advisory emissions)', async () => {
    const model = new MockModel();
    model.enqueue(emitCall(happyArgs()));
    const out = await appraise(
      { userText: 'hola', herReply: 'hola', plan: 'reply', prevTurnId: 'turn_prev', turnId: 'turn_cur' },
      {
        model,
        events: {
          emit: async () => {
            throw new Error('log is on fire');
          },
          async *replay() {},
        },
      },
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.appraisal.importance).toBe(7);
  });
});

describe('appraise — the prompt', () => {
  it('carries the full sorted tag vocabulary', async () => {
    const { model } = await run([emitCall(happyArgs())]);
    const system = model.calls[0]!.messages[0]!.content;
    const expected = [...EMOTION_TAGS].sort().join(', ');
    expect(system).toContain(expected);
    expect(system).toContain('staying silent');
    expect(system).toContain('never -1');
  });

  it('describes the turn: decision, both sides, and what is being graded', async () => {
    const { model } = await run([emitCall(happyArgs())]);
    const user = model.calls[0]!.messages[1]!.content;
    expect(user).toContain('DECISION: reply');
    expect(user).toContain('te acuerdas del concierto de jazz?');
    expect(user).toContain('sí, y todavía me río');
    expect(user).toContain('PREVIOUS TURN to grade: id turn_prev');
  });

  it('states the silence case for both the reply and the previous turn', async () => {
    const { log } = memoryLog();
    const model = new MockModel({ log });
    model.enqueue(emitCall({ ...happyArgs(), outcomePrev: null }));
    await appraise({ userText: '', herReply: null, plan: 'silent', prevTurnId: null }, { model, events: log });
    const user = model.calls[0]!.messages[1]!.content;
    expect(user).toContain('DECISION: silent');
    expect(user).toContain('(she did not reply — plan silent)');
    expect(user).toContain('PREVIOUS TURN: none — "outcomePrev" must be null.');
  });
});
