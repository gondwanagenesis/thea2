// M10 gate (c)+(f) — the lived-file emitter and the write-time gate: every
// rendered draft must pass M07's analyzeFile with ZERO error issues before a
// byte is written, the id must follow the derived-id convention, and the
// anti-fabrication law must be pinned in both prompts.

import { describe, expect, it } from 'vitest';
import { AFFECT_DIMS } from '../../schemas/exemplar.js';
import { analyzeFile } from '../../src/corpus/parse.js';
import { derivedFileId, withFileId } from '../../src/corpus/derived-id.js';
import {
  ConsolidatedDraft,
  fileBaseName,
  generateSystemPrompt,
  generateUserPrompt,
  judgeSystemPrompt,
  notesFor,
  renderLivedDraft,
  validateLived,
  type GenerateRequest,
  type LivedDraftMeta,
} from '../../src/consolidate/index.js';
import { errorCodeOf } from './helpers.js';

/** LivedDraftMeta.encodedAffect is the FULL 12-dim rollup, not the sparse signature. */
const full12 = (over: Partial<Record<(typeof AFFECT_DIMS)[number], number>> = {}): Record<(typeof AFFECT_DIMS)[number], number> =>
  Object.fromEntries(AFFECT_DIMS.map((d) => [d, over[d] ?? 0])) as Record<(typeof AFFECT_DIMS)[number], number>;

const META: LivedDraftMeta = {
  dimensions: ['voice'],
  register: ['play'],
  affect: { valence: 0.3, sadness: -0.2 },
  context: 'late night, one lamp',
  weight: 1,
  episodeIds: ['ep_001', 'ep_002'],
  encodedAffect: full12({ valence: 0.3, sadness: -0.2, joy: 0 }),
  outcome: 'mixed',
  notes: notesFor({ name: 'pattern-crystallizer', version: '1' }, 'sha256:' + 'a'.repeat(64)),
};

const BODY = 'Setup: a quiet terminal\nD: you there?\nT: always. say it and I keep it\n';

const renderAccepted = (meta: LivedDraftMeta = META, body = BODY): string =>
  withFileId(renderLivedDraft(meta, body), derivedFileId(renderLivedDraft(meta, body)));

describe('the emitter', () => {
  it('emits all 12 encodedAffect dims in AFFECT_DIMS order', () => {
    const text = renderLivedDraft(META, BODY);
    const line = /^encodedAffect: \{(.*)\}$/m.exec(text)?.[1] ?? '';
    const keys = line.split(',').map((p) => p.trim().split(':')[0] ?? '');
    expect(keys).toEqual([...AFFECT_DIMS]);
  });

  it('the sparse affect line keeps only the dims that moved', () => {
    const text = renderLivedDraft(META, BODY);
    expect(text).toContain('affect: {sadness: -0.2, valence: 0.3}'); // sorted keys
    const flat = renderLivedDraft({ ...META, affect: {} }, BODY);
    expect(flat).toContain('affect: {}');
  });

  it('carries the lived stamps and the consolidation key in notes', () => {
    const text = renderLivedDraft(META, BODY);
    expect(text).toContain('kind: scene');
    expect(text).toContain('episodeIds: [ep_001, ep_002]');
    expect(text).toContain('outcome: mixed');
    expect(text).toContain('(key sha256:aaaaaaaa');
  });

  it('a dimension outside the 8-dim vocabulary throws before any write', () => {
    expect(
      errorCodeOf(() => renderLivedDraft({ ...META, dimensions: ['charm' as never] }, BODY)),
    ).toBe('consolidate/draft-shape');
  });
});

describe('the write-time gate (gate f)', () => {
  it('a rendered draft validates through analyzeFile with zero error issues', () => {
    const text = renderAccepted();
    const analysis = analyzeFile({ path: `corpus/lived/${fileBaseName(derivedFileId(text))}.md`, raw: text }, 'lived');
    expect(analysis.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(validateLived(renderLivedDraft(META, BODY))).toBeUndefined();
  });

  it('the id is the masked hash of the final bytes — round trip', () => {
    const raw = renderLivedDraft(META, BODY);
    const id = derivedFileId(raw);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(derivedFileId(withFileId(raw, id))).toBe(id);
    expect(fileBaseName(id)).not.toContain(':');
  });

  it('a tampered id line fails the gate (id discipline is enforced)', () => {
    const tampered = renderAccepted().replace(/^id: sha256:[0-9a-f]{64}$/m, `id: sha256:${'f'.repeat(64)}`);
    expect(errorCodeOf(() => validateLived(tampered))).toBe('consolidate/draft-shape');
  });

  it('a draft whose stamps are incomplete fails the gate, and canon rejects it', () => {
    const incomplete = renderLivedDraft(META, BODY).replace(/^encodedAffect:.*$/m, 'encodedAffect: {}');
    expect(() => validateLived(incomplete)).toThrow();
  });
});

describe('proposals are marked drafts (gate c)', () => {
  it('proposal notes carry the human-merge marker and still validate as lived', () => {
    const meta: LivedDraftMeta = {
      ...META,
      notes: notesFor({ name: 'pattern-crystallizer', version: '1' }, `sha256:${'b'.repeat(64)}`, 'incomplete provenance'),
    };
    const text = renderAccepted(meta);
    expect(text).toContain('PROPOSAL draft - human merge required (incomplete provenance)');
    expect(validateLived(renderLivedDraft(meta, BODY))).toBeUndefined();
  });

  it('the canon schema would reject the stamps — no silent promotion', () => {
    const text = renderAccepted();
    expect(analyzeFile({ path: 'corpus/canon/voice/x.md', raw: text }, 'canon').issues.some(
      (i) => i.code === 'corpus/lived-stamps-forbidden',
    )).toBe(true);
  });
});

describe('the draft schema', () => {
  it('requires context, dimensions, register and body', () => {
    const good = { context: 'c', dimensions: ['voice'], register: ['play'], body: 'D: a\nT: b\n' };
    expect(ConsolidatedDraft.safeParse(good).success).toBe(true);
    expect(ConsolidatedDraft.safeParse({ ...good, body: '' }).success).toBe(false);
    expect(ConsolidatedDraft.safeParse({ ...good, dimensions: [] }).success).toBe(false);
    expect(ConsolidatedDraft.safeParse({ ...good, dimensions: ['charm'] }).success).toBe(false);
  });
});

describe('the prompts carry the anti-fabrication law', () => {
  const req: GenerateRequest = {
    episodes: [{ summary: 'he asked twice about the box', importance: 5, affect: 'valence 0.3', outcome: '"ok" (sign 1)' }],
    dimensionVocab: ['voice', 'reasoning'],
    registerVocab: ['play', 'work'],
    affectWeather: 'fond 4 · longing 2',
  };

  it('generation: talking style only, no invented history, em-dash ban', () => {
    const system = generateSystemPrompt();
    expect(system).toMatch(/TALKING STYLE/);
    expect(system).toMatch(/no invented events/);
    expect(system).toMatch(/named third parties/);
    expect(system).toMatch(/Never use em-dashes/);
  });

  it('the user prompt carries episodes, vocabularies and the affect weather', () => {
    const user = generateUserPrompt(req);
    expect(user).toContain('1. (importance 5) he asked twice about the box');
    expect(user).toContain('dimension vocabulary: voice, reasoning');
    expect(user).toContain('affect weather: fond 4 · longing 2');
    const dry = generateUserPrompt({ ...req, affectWeather: undefined });
    expect(dry).not.toContain('affect weather');
  });

  it('judging: drafts that import facts not in the episodes must fail', () => {
    const system = judgeSystemPrompt();
    expect(system).toContain('faithfulness');
    expect(system).toMatch(/invented event/);
    expect(system).toMatch(/fabricating/);
    expect(system).toContain('1-5');
  });
});
