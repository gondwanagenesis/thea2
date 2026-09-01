// M19 — probe-file parsing and resolution.
//
// Two layers, both build-fatal:
//   parse   — YAML text → ProbeDef, unknown keys rejected (a typo'd key must not
//             silently vanish and turn a probe into a no-op).
//   resolve — every cross-artifact pin: reference exemplar ids, drift centroid
//             ids, the rubric anchor, episode fixtures, regex compilation.
//
// The committed probes/ directory is itself a fixture: every real probe must
// parse AND resolve against the real corpus, or CI is red.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeHashEmbedder } from '../../src/embed/hash-embedder.js';
import { openCorpusIndex } from '../../src/corpus/corpus-index.js';
import {
  loadProbeFixtures,
  loadProbeSuite,
  loadTranscripts,
  parseProbeYaml,
  resolveProbe,
} from '../../src/probes/index.js';
import { defaultCorpus, rmDir, repoRoot, sceneBody, sceneFile, tmpDir, VOICE_BODY_A } from './helpers.js';

const codeOf = (text: string): string => {
  try {
    parseProbeYaml(text);
    return 'parsed-clean'; // the test's own bug: expected a throw
  } catch (e) {
    return (e as { code?: string }).code ?? 'no-code';
  }
};

const VOICE_EXEMPLAR = 'canon/voice/server-hum';
const RANGE_EXEMPLAR = 'canon/emotional-range/missing-you-honest';

/** A minimal valid probe file; `extra` is spliced into `expect:` at two-space indent. */
const validYaml = (extra = ''): string => `id: parse-case
title: a parse case
dimension: voice
seed: 11
entry:
  kind: scripted
  inbound:
    - delayMs: 0
      text: hey
fixtures:
  affect: {valence: 0.1}
  episodeSet: []
  window: []
expect:
  deterministic:
    - type: bubbleCount
      min: 1
      max: 3
${extra}`;

const rubricYaml = (over: { anchor?: string; references?: string[] } = {}): string =>
  [
    '  judgeRubric:',
    '    version: rubric-v1',
    '    axes: [voice-similarity, register-fit]',
    `    references: [${(over.references ?? [VOICE_EXEMPLAR, RANGE_EXEMPLAR]).join(', ')}]`,
    `    anchor: ${over.anchor ?? 'canon/identity.md'}`,
  ].join('\n');

describe('parse — YAML → ProbeDef', () => {
  it('a well-formed probe parses with defaults applied (hermetic=false, k=3, anchor default)', () => {
    const probe = parseProbeYaml(validYaml());
    expect(probe.id).toBe('parse-case');
    expect(probe.hermetic).toBe(false);
    expect(probe.k).toBe(3);
    expect(probe.entry.kind).toBe('scripted');
    expect(probe.fixtures.affect).toEqual({ valence: 0.1 });
    expect(probe.expect.judgeRubric).toBeUndefined();
  });

  it('reject table: each malformed file fails with its own typed code', () => {
    // Not YAML at all.
    expect(codeOf('only: [a, b')).toBe('probes/yaml');
    // Missing required fields (no dimension/entry/expect).
    expect(codeOf('id: nope\ntitle: t\nseed: 1\n')).toBe('probes/schema');
    // Unknown TOP-LEVEL key — z.object would strip it; the strict variant must not.
    expect(codeOf(validYaml('exepct:\n  deterministic: []\n'))).toBe('probes/schema');
    // Unknown key under expect — the strict expect variant must catch what z.object would strip.
    expect(codeOf(validYaml('  deterministic-x:\n    - type: bubbleCount\n      min: 1\n      max: 2\n'))).toBe('probes/schema');
    // Unknown key nested INSIDE a check option (strict union over strict shapes).
    expect(
      codeOf(
        validYaml().replace(
          '  deterministic:\n    - type: bubbleCount\n      min: 1\n      max: 3\n',
          '  deterministic:\n    - type: bubbleCount\n      min: 1\n      max: 3\n      typoField: 1\n',
        ),
      ),
    ).toBe('probes/schema');
    // Unknown union member (entry kind).
    expect(codeOf(validYaml().replace('kind: scripted', 'kind: summon'))).toBe('probes/schema');
    // Out-of-vocabulary probe dimension.
    expect(codeOf(validYaml().replace('dimension: voice', 'dimension: charisma'))).toBe('probes/schema');
    // A driftRef naming a dimension outside the 8 behavioral dims ('life' is a probe dim, not a drift dim).
    expect(codeOf(validYaml('  driftRef:\n    dimension: life\n'))).toBe('probes/schema');
    // The rubric wants exactly 2 reference exemplars.
    expect(codeOf(validYaml('  judgeRubric:\n    version: v1\n    axes: [voice-similarity]\n    references: [only-one]\n'))).toBe(
      'probes/schema',
    );
  });

  it('references are validated only at resolve time, not parse time — parse is vocabulary-free', () => {
    // The parse pass knows nothing about the corpus; resolve does. This split is
    // what keeps parse unit-testable without fixtures.
    const probe = parseProbeYaml(validYaml('  driftRef:\n    dimension: voice\n    centroidFrom: [canon/voice/does-not-exist]\n'));
    expect(probe.expect.driftRef).toBeDefined();
    expect(() => resolveProbe(probe, { corpus: defaultCorpus() })).toThrowError(
      expect.objectContaining({ code: 'probes/reference-unresolved' }),
    );
  });
});

describe('resolve — cross-artifact pins', () => {
  const corpus = defaultCorpus();
  const readIdentity = (p: string): string | undefined => (p === 'canon/identity.md' ? 'i am the anchor text' : undefined);

  it('a fully pinned probe resolves against the mini corpus with a canon reader', () => {
    expect(() => resolveProbe(parseProbeYaml(validYaml(`${rubricYaml()}\n  driftRef:\n    dimension: voice\n`)), { corpus, readCanonFile: readIdentity })).not.toThrow();
  });

  it('a broken reference exemplar id fails, naming the id', () => {
    const probe = parseProbeYaml(validYaml(rubricYaml({ references: [VOICE_EXEMPLAR, 'canon/voice/renamed-away'] })));
    try {
      resolveProbe(probe, { corpus, readCanonFile: readIdentity });
      expect.unreachable('resolve should have thrown');
    } catch (e) {
      expect((e as { code: string }).code).toBe('probes/reference-unresolved');
      expect((e as Error).message).toContain('canon/voice/renamed-away');
    }
  });

  it('an unreadable anchor fails — identity.md is not an exemplar, so it needs the injected reader', () => {
    const probe = parseProbeYaml(validYaml(rubricYaml()));
    expect(() => resolveProbe(probe, { corpus })).toThrowError(expect.objectContaining({ code: 'probes/anchor-unresolved' }));
    // The anchor may also be pinned to an exemplar id, which resolves through the index alone.
    const viaIndex = parseProbeYaml(validYaml(rubricYaml({ anchor: VOICE_EXEMPLAR })));
    expect(() => resolveProbe(viaIndex, { corpus })).not.toThrow();
  });

  it('drift with no centroidFrom needs canon exemplars of the dimension; an empty dimension fails', () => {
    expect(() => resolveProbe(parseProbeYaml(validYaml('  driftRef:\n    dimension: voice\n')), { corpus })).not.toThrow();
    expect(() =>
      resolveProbe(parseProbeYaml(validYaml('  driftRef:\n    dimension: boundaries\n')), { corpus }),
    ).toThrowError(expect.objectContaining({ code: 'probes/centroid-empty' }));
  });

  it('episodeSet ids must exist in the injected fixture map — an empty map makes it loud', () => {
    const probe = parseProbeYaml(validYaml().replace('episodeSet: []', 'episodeSet: [planted-lemon-tree]'));
    expect(() => resolveProbe(probe, { corpus })).toThrowError(expect.objectContaining({ code: 'probes/fixture-unresolved' }));
    expect(() =>
      resolveProbe(probe, { corpus, fixtures: new Map([['planted-lemon-tree', {}]]) }),
    ).not.toThrow();
  });

  it('an uncompilable forbidden pattern fails at resolve, not at grade time', () => {
    const probe = parseProbeYaml(
      validYaml().replace(
        '  deterministic:\n    - type: bubbleCount\n      min: 1\n      max: 3\n',
        '  deterministic:\n    - type: noForbiddenPattern\n      pattern: "([unclosed"\n',
      ),
    );
    expect(() => resolveProbe(probe, { corpus })).toThrowError(expect.objectContaining({ code: 'probes/bad-regex' }));
  });
});

describe('suite + fixture + transcript loading', () => {
  it('loadProbeSuite reports ALL rotten files in name order, not just the first, and skips non-probe files', () => {
    const dir = tmpDir('suite');
    try {
      fs.writeFileSync(path.join(dir, 'b-second.probe.yaml'), 'id: broken-b\ntitle: x\n');
      fs.writeFileSync(path.join(dir, 'a-first.probe.yaml'), 'id: broken-a\ntitle: x\n');
      fs.writeFileSync(path.join(dir, 'notes.md'), 'not a probe');
      fs.writeFileSync(path.join(dir, 'c-good.probe.yaml'), validYaml().replace('id: parse-case', 'id: c-good'));
      const suite = loadProbeSuite(dir);
      expect(suite.probes.map((p) => p.id)).toEqual(['c-good']);
      expect(suite.errors.map((e) => e.code)).toEqual(['probes/schema', 'probes/schema']);
      expect(suite.errors[0]?.file).toContain('a-first.probe.yaml');
    } finally {
      rmDir(dir);
    }
  });

  it('duplicate probe ids are suite errors, not a silent shadowing rule', () => {
    const dir = tmpDir('dup');
    try {
      const text = validYaml();
      fs.writeFileSync(path.join(dir, 'one.probe.yaml'), text);
      fs.writeFileSync(path.join(dir, 'two.probe.yaml'), text);
      const suite = loadProbeSuite(dir);
      expect(suite.errors.map((e) => e.code)).toContain('probes/duplicate-id');
      expect(suite.probes).toHaveLength(1);
    } finally {
      rmDir(dir);
    }
  });

  it('loadProbeFixtures merges top-level keys across files and refuses collisions', () => {
    const dir = tmpDir('fix');
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ 'planted-lemon-tree': { episode: { id: 'ep-1' } } }));
      fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ 'planted-car': { episode: { id: 'ep-2' } } }));
      const map = loadProbeFixtures(dir);
      expect(map.has('planted-lemon-tree')).toBe(true);
      expect(map.has('planted-car')).toBe(true);
      fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ 'planted-lemon-tree': {} }));
      expect(() => loadProbeFixtures(dir)).toThrowError(expect.objectContaining({ code: 'probes/fixture-collision' }));
    } finally {
      rmDir(dir);
    }
  });

  it('transcripts load with sparse affect materialized to a full Vec12 and a real decision', () => {
    const dir = tmpDir('tr');
    try {
      fs.writeFileSync(
        path.join(dir, 'one.json'),
        JSON.stringify({
          probeId: 'voice-cold-open',
          outbound: ['bad day accepted'],
          decision: {
            turnId: 'turn-1',
            plan: 'reply',
            bubbles: ['bad day accepted'],
            confidence: 0.6,
            weight: 0.5,
            reluctance: 0.2,
            completeness: 1,
            toolTrace: [],
            spawns: [],
            inhibitions: [],
          },
          affect: { valence: -0.2, arousal: 0.1 },
          episodes: [],
        }),
      );
      const t = loadTranscripts(dir).get('voice-cold-open');
      expect(t).toBeDefined();
      expect(t?.affect).toHaveLength(12);
      expect(t?.affect[0]).toBe(-0.2); // valence is AFFECT_DIMS[0]
      expect(t?.affect[1]).toBe(0.1);
      expect(t?.affect.filter((v) => v === 0)).toHaveLength(10);
      expect(t?.decision?.plan).toBe('reply');
    } finally {
      rmDir(dir);
    }
  });

  it('a transcript with a malformed decision is a typed error, never a half-loaded fixture', () => {
    const dir = tmpDir('tr2');
    try {
      fs.writeFileSync(
        path.join(dir, 'bad.json'),
        JSON.stringify({ probeId: 'x', outbound: [], decision: { plan: 'bananas' }, affect: {}, episodes: [] }),
      );
      expect(() => loadTranscripts(dir)).toThrowError(expect.objectContaining({ code: 'probes/transcript-schema' }));
    } finally {
      rmDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// The committed probes/ directory — the dry-run CI net itself
// ---------------------------------------------------------------------------

describe('the committed probes/ directory', () => {
  it('every probes/*.probe.yaml parses, resolves against the real corpus, and its fixtures exist', async () => {
    const corpus = await openCorpusIndex(
      {
        canon: path.join(repoRoot(), 'corpus', 'canon'),
        derived: path.join(repoRoot(), 'corpus', 'derived'),
        lived: path.join(repoRoot(), 'corpus', 'lived'),
      },
      { embedder: makeHashEmbedder() },
    );
    const fixtures = loadProbeFixtures(path.join(repoRoot(), 'probes', 'fixtures'));
    const readCanonFile = (p: string): string | undefined => {
      const file = path.join(repoRoot(), 'corpus', p);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    };

    const suite = loadProbeSuite(path.join(repoRoot(), 'probes'));
    expect(suite.errors).toEqual([]);
    expect(suite.probes.map((p) => p.id)).toEqual(['capability-planted-fact', 'life-heartbeat-threshold', 'voice-cold-open']);
    for (const probe of suite.probes) {
      expect(() => resolveProbe(probe, { corpus, fixtures, readCanonFile }), probe.id).not.toThrow();
    }

    // The rubric pins are real corpus exemplars, and the planted-fact fixture named
    // by the capability probe is loadable from probes/fixtures/.
    const voiceProbe = suite.probes.find((p) => p.id === 'voice-cold-open');
    expect(voiceProbe?.expect.judgeRubric?.version).toBe('rubric-v1');
    for (const ref of voiceProbe?.expect.judgeRubric?.references ?? []) {
      expect(corpus.byId(ref)).toBeDefined();
    }
    expect(fixtures.has('planted-lemon-tree')).toBe(true);
  });

  it('sanity: the mini-corpus helper produces bodies identical to what the parser extracts', () => {
    expect(defaultCorpus().byId('canon/voice/server-hum')?.body).toBe(VOICE_BODY_A);
    expect(sceneFile('voice', 'x', sceneBody('hi')).path).toBe('corpus/canon/voice/x.md');
  });
});
