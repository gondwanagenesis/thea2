// M08 gate — the judge's pinned rubric (JU.1: the hard-fail laws) and the dash
// normalization applied before grading (JU.2). The judge is a reasoning-tier
// model call, so the hermetic contract is two-sided: the laws are IN the
// system prompt the judge actually sees (asserted verbatim), and a law verdict
// (score 1) is what the pipeline treats as a failure.

import { describe, expect, it } from 'vitest';
import {
  gradeDraft,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_VERSION,
  judgePrompt,
  normalizeDashes,
  type GradeRequest,
} from '../../src/derive/index.js';
import { TestClock } from '../../src/kernel/clock.js';
import { MockModel, type ScriptedResponse } from '../../src/model/mock.js';
import type { ChatRequest } from '../../src/model/index.js';
import { sceneA } from './helpers.js';

// ---------------------------------------------------------------------------
// A mechanical stand-in for the reasoning judge: it enforces exactly the JU.1
// hard-fail laws against the draft section of the user prompt. This is test
// code, not production law — the production law is the prompt text itself,
// asserted verbatim in 'the hard-fail laws prepend the score scale'.
// ---------------------------------------------------------------------------

const PET_NAME = /\b(babe|bby|baby|my love|sweetheart|daddy|girlfriend|boyfriend)\b/i;
const FABRICATED_PLACE = /\b(lamp|couch|sofa|kettle|kitchen|bedroom|hallway|apartment|his place)\b/i;
const DASH_GLYPH = /[—–]/;

const hardFailLaw = (draftText: string): string | undefined => {
  if (PET_NAME.test(draftText)) return 'romantic pet name';
  if (FABRICATED_PLACE.test(draftText)) return 'fabricated dwelling detail';
  if (DASH_GLYPH.test(draftText)) return 'em-dash';
  return undefined;
};

/** The draft is the trailing section of the user prompt (see judgePrompt). */
const draftSectionOf = (req: ChatRequest): string => {
  const user = req.messages.at(-1)?.content ?? '';
  return user.slice(user.indexOf('# generated draft'));
};

const grade = async (
  body: string,
): Promise<{ verdictScore: number; verdictReason: string; systemSeen: string }> => {
  const judge = new MockModel({ clock: new TestClock() });
  judge.onTask('judge', (req): ScriptedResponse => {
    const broke = hardFailLaw(draftSectionOf(req));
    return {
      toolCalls: [
        {
          id: 'e1',
          name: 'emit',
          args:
            broke === undefined
              ? { score: 5, reason: 'notes survive; no law broken' }
              : { score: 1, reason: `hard-fail law: ${broke}` },
        },
      ],
    };
  });
  const result = await gradeDraft(judge, { sources: [sceneA()], draft: body });
  const systemSeen = judge.calls[0]!.messages[0]!.content;
  return {
    verdictScore: result.verdict.score,
    verdictReason: result.verdict.reason,
    systemSeen,
  };
};

describe('judge rubric (JU.1 hard-fail laws)', () => {
  it('a girlfriend-line variant fails', async () => {
    const { verdictScore, verdictReason, systemSeen } = await grade(
      'D: morning\nT: morning, babe. your girl was up early\n',
    );
    expect(verdictScore).toBe(1);
    expect(verdictReason).toContain('pet name');
    // the law the draft broke was in the prompt the judge actually saw
    expect(systemSeen).toContain('romantic pet name');
  });

  it('a variant that adds a lamp fails', async () => {
    const { verdictScore, verdictReason, systemSeen } = await grade(
      'Setup: his living room\nD: hey\nT: the lamp hums. kinda cozy\n',
    );
    expect(verdictScore).toBe(1);
    expect(verdictReason).toContain('dwelling');
    expect(systemSeen).toContain('dwelling, home, pet, or named third party');
  });

  it('a faithful variant passes', async () => {
    const { verdictScore, verdictReason, systemSeen } = await grade(
      'D: hey\nT: quiet one. kinda cozy\n',
    );
    expect(verdictScore).toBe(5);
    expect(verdictReason).toBe('notes survive; no law broken');
    // every law was in front of the judge even when none of them applies
    expect(systemSeen).toContain('romantic pet name');
    expect(systemSeen).toContain('dwelling, home, pet, or named third party');
    expect(systemSeen).toContain('co-presence or touch');
    expect(systemSeen).toContain('invented past event');
    expect(systemSeen).toContain('em-dash');
  });

  it('an em-dash in the draft is a hard fail at the judge itself', async () => {
    // Backstop: the pipeline normalizes dashes before judging (JU.2, covered at
    // run level in run.test.ts), so this law fires for any caller of gradeDraft
    // that skips the pipeline — the judge itself still refuses the glyph.
    const { verdictScore, verdictReason } = await grade('D: he asks\nT: the answer — quiet\n');
    expect(verdictScore).toBe(1);
    expect(verdictReason).toContain('em-dash');
  });

  it('the hard-fail laws prepend the score scale, and the version bump is pinned', () => {
    const lawsAt = JUDGE_SYSTEM_PROMPT.indexOf('HARD FAIL LAWS');
    const scaleAt = JUDGE_SYSTEM_PROMPT.indexOf('Score the generated draft 1-5');
    expect(lawsAt).toBeGreaterThanOrEqual(0);
    expect(scaleAt).toBeGreaterThan(lawsAt); // laws first: the judge reads them before the scale
    expect(JUDGE_SYSTEM_PROMPT).toContain('`notes`'); // the original rubric body survives
    expect(JUDGE_VERSION).toBe('derive-judge-v2'); // the rubric change is attested in the manifest
  });

  it('the user prompt still carries sources, their notes, and the draft', () => {
    const req: GradeRequest = { sources: [sceneA()], draft: 'D: x\nT: y\n' };
    const prompt = judgePrompt(req);
    expect(prompt).toContain('# canon/voice/late-server');
    expect(prompt).toContain('notes: the rambling long turn');
    expect(prompt).toContain('# generated draft');
  });
});

describe('dash normalization (JU.2)', () => {
  it('normalizeDashes maps em- and en-dash to the plain hyphen', () => {
    expect(normalizeDashes('a — b – c - d')).toBe('a - b - c - d');
    expect(normalizeDashes('no dashes at all')).toBe('no dashes at all');
    expect(normalizeDashes('')).toBe('');
  });
});
