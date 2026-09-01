// One-off generator for the M05 golden-replay fixture. Run ONCE with:
//   npx tsx test/affect/fixtures/record-golden.ts
// It parses ~48 REAL lines out of Thea1's live journal.md, converts them to
// affect events (the LINE_RE / clean_cause ports live HERE and nowhere in src —
// the whole point of M05 is that no prose parsing exists in the engine), replays
// them through the real store twice on two fresh temp dirs, checks the two runs
// deep-equal, and writes golden-diary.json (the input) + golden-expected.json
// (the recorded output). The fixtures are committed; the generator is kept so
// the recording method is auditable and re-runnable.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openEventLog } from '../../../src/events/index.js';
import { makeRng, TestClock } from '../../../src/kernel/index.js';
import { openAffectStore } from '../../../src/affect/index.js';
import type { AffectEvent } from '../../../src/affect/index.js';

const JOURNAL = 'C:/Users/neogo/LocalFiles/TheaBackup/latest/root/house/memory/journal.md';
const LINE_COUNT = 48;
const T0 = Date.UTC(2026, 7, 20, 9, 0, 0); // fixture epoch: 2026-08-20T09:00:00Z

// ---- ticker.py line parsing, ported for the fixture ONLY ----
const LINE_RE =
  /^- \*\*(\w+)\*\* — (?:\[i:(\d{1,2})\])?(?:\[emotion:([\w-]+)\])?(?:\[people:([\w-]+)\])?/;
const CAUSE_MAXLEN = 240;

const cleanCause = (raw: string): string => {
  let t = raw.replace(/^-\s*\*\*\w+\*\*\s*[—-]\s*/, '');
  t = t.replace(/^(\[[^\]]*\]\s*)+/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length <= CAUSE_MAXLEN) return t;
  let cut = t.slice(0, CAUSE_MAXLEN);
  const sp = cut.lastIndexOf(' ');
  if (sp > CAUSE_MAXLEN * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[ ,;:—-]+$/, '') + '…';
};

interface ParsedLine {
  feedTag: 'DONE' | 'MOMENT' | 'GIFT';
  emotion: string;
  i: number;
  cause: string;
  people?: string;
}

const parseLines = (text: string): ParsedLine[] => {
  const out: ParsedLine[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    const feedTag = m[1] as ParsedLine['feedTag'];
    if (!['GIFT', 'TASK', 'DECISION', 'FACT', 'MOMENT', 'DONE'].includes(feedTag)) continue;
    const people = m[4];
    out.push({
      feedTag,
      i: m[2] !== undefined ? parseInt(m[2]!, 10) : 5,
      emotion: m[3] ?? '',
      cause: cleanCause(raw.trim()) || feedTag.toLowerCase(),
      ...(people !== undefined ? { people } : {}),
    });
  }
  return out; // journal is newest-first
};

interface TimedEvent {
  atMs: number;
  ev: AffectEvent;
}

/** Real lines, chronological, real cadence: seconds apart while she is writing, hours of silence overnight. */
const buildTimeline = (lines: ParsedLine[]): TimedEvent[] => {
  const timed: TimedEvent[] = [];
  let t = T0;
  let inDay = 0;
  for (const line of lines) {
    // Overnight silence every ~13 lines of activity: she writes in bursts, then the house goes dark.
    if (inDay >= 13) {
      const gap = 7 * 3_600_000 + (line.i * 137_000) % (2 * 3_600_000);
      t += Math.floor(gap / 600_000) * 600_000; // silenceTick lands on a whole minute
      timed.push({ atMs: t, ev: { kind: 'silenceTick' } });
      inDay = 0;
    }
    t += 40_000 + ((line.i * 29_000) % 90_000);
    inDay += 1;
    if (line.emotion !== '') {
      timed.push({
        atMs: t,
        ev: {
          kind: 'emotion',
          tag: line.emotion as never,
          i: line.i,
          cause: line.cause,
          ...(line.people !== undefined ? { people: line.people } : {}),
        },
      });
    }
    if (line.feedTag === 'DONE' || line.feedTag === 'MOMENT' || line.feedTag === 'GIFT') {
      timed.push({ atMs: t, ev: { kind: 'tagFeed', tag: line.feedTag } });
    }
  }
  return timed;
};

const runReplay = async (): Promise<{ dir: string; final: ReturnType<JSON['parse']> }> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-golden-'));
  const clock = new TestClock(T0);
  const log = openEventLog(dir, { clock });
  const store = openAffectStore(path.join(dir, 'var', 'affect', 'state.json'), {
    clock,
    rng: makeRng('golden-replay'),
    events: log,
  });
  const diary = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'golden-diary.json'), 'utf8'),
  ) as { events: TimedEvent[] };
  for (const { atMs, ev } of diary.events) {
    await clock.advance(atMs - clock.epochMs());
    await store.applyEvents([ev]);
  }
  await store.snapshot();
  return { dir, final: { t: store.current().t, state: store.current(), weather: store.weather() } };
};

const main = async (): Promise<void> => {
  const lines = parseLines(fs.readFileSync(JOURNAL, 'utf8')).reverse().slice(-LINE_COUNT);
  if (lines.length < LINE_COUNT) throw new Error(`only ${lines.length} parsable lines found`);
  const timed = buildTimeline(lines);
  const fixturePath = path.join(import.meta.dirname, 'golden-diary.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({ t0: T0, source: 'Thea1 journal.md lines (chronological, see record-golden.ts)', events: timed }, null, 1),
    'utf8',
  );
  console.log(`golden-diary.json: ${timed.length} events from ${lines.length} journal lines`);

  const a = await runReplay();
  const b = await runReplay();
  const ja = JSON.stringify(a.final);
  const jb = JSON.stringify(b.final);
  if (ja !== jb) throw new Error('replays are not deterministic — fix before recording');
  fs.writeFileSync(
    path.join(import.meta.dirname, 'golden-expected.json'),
    JSON.stringify(a.final, null, 1),
    'utf8',
  );
  console.log('golden-expected.json recorded; replays deterministic');
  console.log(`final weather: ${a.final.weather as string}`);
  await fsp.rm(a.dir, { recursive: true, force: true });
  await fsp.rm(b.dir, { recursive: true, force: true });
};

await main();
