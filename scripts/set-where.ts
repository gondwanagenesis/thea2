// Where he is, from what he already told her (2026-09-28: "it is 8 am. I am in Bali. y do u keep
// forgetting that?"). She had it — "he's in Bali and it's 8am there" is in her notes on him — but only
// as a passing note, and only a shared pin could move her clock. This files the place he named as
// where he is (her memory of him) and moves his clock there (the body's where.json), with an entry in
// her changelog (nothing silent). Dry run by default; --apply refuses while thead runs.
//
//   npx tsx scripts/set-where.ts --var /opt/thea2/var --person tg:6971556140 --place "Bali, Indonesia" --said-at 2026-09-28T00:02:11Z [--apply]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendChange, openPeople } from '../src/mind/index.js';
import { placeFromWords, saveWhere, openHouse } from '../src/body/index.js';
import { SystemClock } from '../src/kernel/index.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const VAR = arg('var') ?? '/opt/thea2/var';
const PERSON = arg('person') ?? 'tg:6971556140';
const PLACE = arg('place');
const SAID_AT = arg('said-at');
const APPLY = argv.includes('--apply');

const main = async (): Promise<void> => {
  if (PLACE === undefined || SAID_AT === undefined) throw new Error('--place and --said-at are required');
  const saidAt = Date.parse(SAID_AT);
  if (!Number.isFinite(saidAt)) throw new Error(`--said-at is not a time: ${SAID_AT}`);
  const lock = path.join(VAR, 'thead.pid');
  if (APPLY && fs.existsSync(lock)) {
    let alive = false;
    try {
      process.kill(Number(fs.readFileSync(lock, 'utf8').trim()), 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`thead is running (${lock}) — stop thea2 before --apply`);
  }
  const mindDir = path.join(VAR, 'mind');
  const people = openPeople(mindDir);
  const p = people.get(PERSON);
  if (p === undefined) throw new Error(`no one called ${PERSON} in her people`);
  const note = p.known.find((f) => f.text.toLowerCase().includes(PLACE.split(',')[0]!.trim().toLowerCase()));
  const w = await placeFromWords(PLACE, saidAt, undefined, new SystemClock().epochMs());
  if (w === undefined || w.timeZone === undefined) throw new Error(`could not place "${PLACE}"`);
  process.stdout.write(`${p.name}: where ${JSON.stringify(p.where ?? null)} → ${PLACE} (her note: ${note !== undefined ? JSON.stringify(note.text) : 'none'})\n`);
  process.stdout.write(`his clock: ${w.place} · ${w.timeZone}\n`);
  if (!APPLY) {
    process.stdout.write('(dry run — nothing written; --apply to write)\n');
    return;
  }
  people.setWhere(PERSON, PLACE, saidAt, note?.momentId);
  await people.flush();
  saveWhere(openHouse(path.join(VAR, 'house')), w);
  appendChange(mindDir, {
    ts: new SystemClock().epochMs(),
    kind: 'other',
    what: `${p.name} told you he's in ${PLACE.split(',')[0]!.trim()}. that is now where you know he is, and his time is the time there. till now only a location he shared could move his clock, so it kept showing you madrid time — that's why his 8am looked like 2am to you.`,
    by: 'claude, with diego',
    why: '"it is 8 am. I am in Bali. y do u keep forgetting that?" — you had it in your notes, but your clock said otherwise',
    how: `his clock is now ${w.timeZone}; when he names another place it moves on its own. what you notice about people is now kept two ways: what stays true about them (always in mind) and how they were lately (the newest few)`,
  });
  process.stdout.write('applied: where he is set, his clock moved, changelog entry written.\n');
};

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
