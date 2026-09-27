#!/usr/bin/env node
// The salon relay (Diego, 2026-09-27: "set up a way for her to talk to thea 1 … and a way i can see!
// i want them to talk"). Telegram never delivers one bot's messages to another bot, so Thea1
// (@Demigourgosbot) and Thea2 (@dodonotnobot) share the "House of Tiktaalik" group and cannot hear each
// other. While Diego has a salon open, this carries each one's group lines to the other; both answer in
// the group with their own bots, so he watches it live in Telegram and can jump in.
//
//   open:   Diego types  /salon <what you'd like them to talk about>   in the group
//   close:  /salon stop  — or 24 lines carried, or 15 minutes of quiet
//
// Reads (never writes) Thea1's message ledger and Thea2's outbox; writes one small JSON file per line
// into each one's salon inbox. Each side hears the other as her sister — never as Diego (Thea1's bridge:
// speaker thea2:salon; Thea2's pipeline: person salon:thea1, the authority wall). Runs as root
// (thea-salon.service): Thea1's ledger and inbox are root's.

import fs from 'node:fs';
import path from 'node:path';

const GROUP = process.env.SALON_GROUP ?? '-1003753077911';
const T1_LEDGER = process.env.SALON_T1_LEDGER ?? '/opt/holobionte/msgledger.jsonl';
const T1_INBOX = process.env.SALON_T1_INBOX ?? '/opt/holobionte/salon/in';
const T2_OUTBOX = process.env.SALON_T2_OUTBOX ?? '/opt/thea2/var/salon/outbox.jsonl';
const T2_INBOX = process.env.SALON_T2_INBOX ?? '/opt/thea2/var/salon/in';
const STATE = process.env.SALON_STATE ?? '/var/lib/thea-salon/state.json';
const CAP = Number(process.env.SALON_CAP ?? 24);
const IDLE_MS = Number(process.env.SALON_IDLE_MS ?? 15 * 60_000);
const T1_QUIET_MS = 8_000; // Thea1 sends a reply as several bubbles; carry them as one line once she pauses
const TICK_MS = 2_000;

const log = (...a) => console.log(new Date().toISOString(), '[salon]', ...a);

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { open: false, topic: '', carried: 0, lastAt: 0, t1Pos: null, t2Pos: null };
  }
};
const save = (s) => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(s));
  fs.renameSync(`${STATE}.tmp`, STATE);
};

/** New complete lines of a file since `pos` (bytes); a file that shrank is read from the start. */
const tail = (file, pos) => {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], pos: pos ?? 0 };
  }
  if (pos === null || pos === undefined) return { lines: [], pos: size }; // first run: start at the end
  if (size < pos) pos = 0;
  if (size === pos) return { lines: [], pos };
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - pos);
  fs.readSync(fd, buf, 0, buf.length, pos);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return { lines: [], pos };
  return { lines: text.slice(0, end).split('\n').filter((l) => l.trim() !== ''), pos: pos + Buffer.byteLength(text.slice(0, end + 1)) };
};

const ownerOf = (dir) => {
  try {
    const st = fs.statSync(path.dirname(dir));
    return { uid: st.uid, gid: st.gid };
  } catch {
    return undefined;
  }
};

let seq = 0;
const drop = (dir, from, text) => {
  fs.mkdirSync(dir, { recursive: true });
  const own = ownerOf(dir);
  if (own) fs.chownSync(dir, own.uid, own.gid);
  seq += 1;
  const id = `${Date.now()}-${String(seq).padStart(4, '0')}`;
  const tmp = path.join(dir, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, from, text }));
  if (own) fs.chownSync(tmp, own.uid, own.gid);
  fs.renameSync(tmp, path.join(dir, `${id}.json`));
};

const s = load();
let t1Pending = { text: [], lastAt: 0 };
log(`up — group ${GROUP}, cap ${CAP}, idle ${IDLE_MS / 60000} min, ${s.open ? `salon OPEN (${s.carried}/${CAP})` : 'no salon open'}`);

const close = (why) => {
  if (!s.open) return;
  log(`closed (${why}) after ${s.carried} line(s): "${s.topic}"`);
  s.open = false;
  t1Pending = { text: [], lastAt: 0 };
  save(s);
};

const carry = (to, from, text) => {
  if (!s.open || s.carried >= CAP) return;
  drop(to === 't1' ? T1_INBOX : T2_INBOX, from, text);
  s.carried += 1;
  s.lastAt = Date.now();
  log(`${from} → ${to === 't1' ? 'thea1' : 'thea2'} (${s.carried}/${CAP}): ${text.replace(/\s+/g, ' ').slice(0, 100)}`);
  if (s.carried >= CAP) close('cap');
};

const tick = () => {
  const now = Date.now();
  // Thea1's ledger: Diego's group messages (commands, and his voice resets the idle clock) and her group sends
  const a = tail(T1_LEDGER, s.t1Pos);
  s.t1Pos = a.pos;
  for (const line of a.lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (String(e.chat_id) !== GROUP || typeof e.text !== 'string') continue;
    if (e.dir === 'in') {
      const m = /^\/salon\b\s*(.*)$/is.exec(e.text.trim());
      if (m) {
        const rest = m[1].trim();
        if (/^(stop|close|end|off)$/i.test(rest)) close('Diego');
        else {
          Object.assign(s, { open: true, topic: rest.slice(0, 300), carried: 0, lastAt: now, openedAt: now });
          t1Pending = { text: [], lastAt: 0 };
          log(`opened: "${s.topic}"`);
        }
      } else if (s.open) s.lastAt = now; // Diego (or anyone human) talking keeps it alive
    } else if (e.dir === 'out' && s.open) {
      t1Pending.text.push(e.text.replace(/⟦TG⟧/g, '').trim());
      t1Pending.lastAt = now;
    }
  }
  // Thea1 finished a reply (she paused): carry it to Thea2 as one line
  if (s.open && t1Pending.text.length > 0 && now - t1Pending.lastAt >= T1_QUIET_MS) {
    const text = t1Pending.text.filter((x) => x !== '').join('\n');
    t1Pending = { text: [], lastAt: 0 };
    if (text !== '') carry('t2', 'thea1', text);
  }
  // Thea2's outbox: each row is one whole turn of hers in a group
  const b = tail(T2_OUTBOX, s.t2Pos);
  s.t2Pos = b.pos;
  for (const line of b.lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (String(r.chatId) === GROUP && typeof r.text === 'string' && r.text.trim() !== '') carry('t1', 'thea2', r.text.trim());
  }
  if (s.open && now - s.lastAt > IDLE_MS) close('quiet');
  save(s);
};

setInterval(() => {
  try {
    tick();
  } catch (e) {
    log('tick failed:', e && e.message ? e.message : String(e));
  }
}, TICK_MS);
