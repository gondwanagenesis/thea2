// P-DOCS DC.2 — the generated-numbers gate, tested hermetically.
//
// The checker's repo-facing half (computeFacts) reads stable artifacts only
// and is exercised by running `npm run docs:check` in the gates job. The tests
// here pin the part a doc-rot regression would actually hit: the block
// comparison. They run against fabricated facts and an in-memory fixture doc,
// so they can never go red because a concurrent agent landed a test file.
import { describe, expect, it } from 'vitest';
import {
  applyFix,
  checkDoc,
  renderFactBlock,
  type DocsFacts,
  type GenKey,
} from '../../scripts/docs-check.js';

const FACTS: DocsFacts = {
  testFiles: 3,
  testDeclarations: 42,
  canonScenes: 7,
  derivedFiles: 11,
  jobs: ['heartbeat', 'ledger'],
  jobCadences: { heartbeat: '30 min', ledger: 'daily 04:30 UTC' },
  modules: ['kernel', 'app'],
  dagEdges: 2,
  doors: [
    {
      name: 'voice',
      endpoint: 'https://door.example/v1',
      protocol: 'openai',
      model: 'model-x',
      effort: 'low',
      forcing: 'none',
    },
  ],
  ioToolsRegistered: 0,
  spawnTools: ['fork', 'task', 'committee'],
  probes: ['voice-cold-open.probe.yaml'],
  adrs: [{ id: 'ADR-001', status: 'accepted' }],
};

const REQUIRED: readonly GenKey[] = ['tests-count', 'doors'];

const wrap = (key: GenKey, inner: string): string =>
  `<!-- gen:${key}:start -->\n${inner}\n<!-- gen:${key}:end -->`;

const freshDoc = (): string =>
  ['# Fixture', '', wrap('tests-count', renderFactBlock('tests-count', FACTS)), '', wrap('doors', renderFactBlock('doors', FACTS))].join('\n');

describe('docs-check — the generated-numbers gate', () => {
  it('a fresh generated block passes the check', () => {
    const res = checkDoc('FIXTURE.md', freshDoc(), FACTS, REQUIRED);
    expect(res.ok).toBe(true);
    expect(res.failures).toEqual([]);
  });

  it('docs-check fails on a stale generated block', () => {
    const stale = freshDoc().replace('42 test declarations', '1,502 test declarations');
    const res = checkDoc('FIXTURE.md', stale, FACTS, REQUIRED);
    expect(res.ok).toBe(false);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]?.doc).toBe('FIXTURE.md');
    expect(res.failures[0]?.key).toBe('tests-count');
    expect(res.failures[0]?.reason).toBe('stale generated block');
    expect(res.failures[0]?.expected).toContain('42 test declarations');
    expect(res.failures[0]?.found).toContain('1,502 test declarations');
  });

  it('a missing required block is a failure, never a silent pass', () => {
    const res = checkDoc('FIXTURE.md', '# doc with no blocks at all\n', FACTS, REQUIRED);
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.key).sort()).toEqual(['doors', 'tests-count']);
    expect(res.failures.every((f) => f.reason === 'missing required generated block')).toBe(true);
  });

  it('a doc claiming no doors fails against a repo that has one', () => {
    const emptyDoors = wrap('tests-count', renderFactBlock('tests-count', FACTS)) +
      '\n\n' +
      wrap('doors', 'No doors configured.');
    const res = checkDoc('FIXTURE.md', emptyDoors, FACTS, REQUIRED);
    expect(res.ok).toBe(false);
    expect(res.failures[0]?.key).toBe('doors');
  });

  it('applyFix rewrites a stale block to the computed value in place', () => {
    const stale = freshDoc().replace('42 test declarations', '999 test declarations');
    expect(checkDoc('FIXTURE.md', stale, FACTS, REQUIRED).ok).toBe(false);
    const fixed = applyFix('FIXTURE.md', stale, FACTS, REQUIRED);
    expect(checkDoc('FIXTURE.md', fixed, FACTS, REQUIRED).ok).toBe(true);
    // in place: the fixture header survives, no duplicate blocks appear
    expect(fixed).toContain('# Fixture');
    expect([...fixed.matchAll(/gen:tests-count:start/g)]).toHaveLength(1);
  });

  it('each fact carries its own block: drift in one metric is caught by its own key', () => {
    const doc = [freshDoc(), wrap('job-table', renderFactBlock('job-table', FACTS))].join('\n\n');
    expect(checkDoc('FIXTURE.md', doc, FACTS, ['job-table']).ok).toBe(true);
    const drifted = doc.replace('| heartbeat | 30 min |', '| heartbeat | 45 min |');
    const res = checkDoc('FIXTURE.md', drifted, FACTS, ['job-table']);
    expect(res.ok).toBe(false);
    expect(res.failures[0]?.key).toBe('job-table');
    // and the untouched blocks beside it stay green
    expect(checkDoc('FIXTURE.md', drifted, FACTS, ['tests-count']).ok).toBe(true);
  });
});
