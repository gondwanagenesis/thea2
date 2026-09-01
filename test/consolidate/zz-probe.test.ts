// TEMPORARY probe — delete after diagnosis.
import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harness, outcomeEnvelope, type EpisodeRow, type Harness, T0, HOUR, stamp12 } from './helpers.js';
import { consolidateNightly } from '../../src/consolidate/index.js';

const PATTERN: EpisodeRow[] = [
  { id: 'e1', turnId: 'turn_e1', vec: [1, 0], ts: T0 - 4 * HOUR, threads: ['jazz'] },
  { id: 'e2', turnId: 'turn_e2', vec: [0.98, 0.02], ts: T0 - 3 * HOUR, threads: ['jazz'] },
  { id: 'e3', turnId: 'turn_e3', vec: [0.97, 0.03], ts: T0 - 2 * HOUR, threads: ['boxes'] },
  { id: 'e4', turnId: 'turn_e4', vec: [0.96, 0.04], ts: T0 - 1 * HOUR, threads: ['jazz'] },
];
const OUTCOMES = [
  outcomeEnvelope({ ts: T0 - 3.5 * HOUR, turnId: 'turn_e1', sign: 1, evidence: 'he came back to it' }),
  outcomeEnvelope({ ts: T0 - 2.5 * HOUR, turnId: 'turn_e2', sign: 1, evidence: 'he said gracias' }),
  outcomeEnvelope({ ts: T0 - 1.5 * HOUR, turnId: 'turn_e3', sign: 1, evidence: 'he laughed' }),
  outcomeEnvelope({ ts: T0 - 0.5 * HOUR, turnId: 'turn_e4', sign: -1, evidence: 'he went quiet' }),
];

const livedFiles = (h: Harness): string[] =>
  fs.existsSync(h.dirs.livedDir) ? fs.readdirSync(h.dirs.livedDir).filter((n) => n.endsWith('.md')).sort() : [];

const bodyOf = (h: Harness): string => {
  const name = livedFiles(h)[0] ?? '';
  return fs.readFileSync(path.join(h.dirs.livedDir, name), 'utf8');
};

describe('probe', () => {
  it('replicates the seed test exactly', async () => {
    const a = harness('probe-a', { episodes: PATTERN, l0: [...OUTCOMES], seed: 5 });
    const b = harness('probe-b', { episodes: PATTERN, l0: [...OUTCOMES], seed: 6 });
    await consolidateNightly(a.deps);
    await consolidateNightly(b.deps);
    const ta = bodyOf(a);
    const tb = bodyOf(b);
    console.log('A files', livedFiles(a), 'calls', a.model.calls.length);
    console.log('B files', livedFiles(b), 'calls', b.model.calls.length);
    console.log('A hint', a.model.calls[0]?.seedHint, 'B hint', b.model.calls[0]?.seedHint);
    console.log('A call bodies:', a.model.calls.map((c) => c.taskClass).join(','));
    console.log('IDENTICAL', ta === tb);
    console.log('A body', JSON.stringify(ta.slice(0, 300)));
    console.log('B body', JSON.stringify(tb.slice(0, 300)));
    for (const [tag, h] of [['A', a], ['B', b]] as const) {
      h.model.calls.forEach((c, i) => {
        console.log(`${tag} call${i} task=${c.taskClass} hint=${c.seedHint} content=${JSON.stringify(c.messages.at(-1)?.content.slice(0, 60))}`);
      });
    }
    console.log('A full file:', JSON.stringify(ta));
    console.log('B full file:', JSON.stringify(tb));
    void stamp12;
  });
});
