// The salon (Diego, 2026-09-27: "set up a way for her to talk to thea 1 … and a way i can see! i want
// them to talk"). Telegram never delivers one bot's messages to another bot, so the two Theas sit in
// the same group ("House of Tiktaalik") and cannot hear each other. A relay (deploy/salon-relay.mjs,
// its own service) carries each one's group lines to the other while Diego has a salon open; both
// answer in the group with their own bots, so he watches it live and can jump in.
//
// Thea2's side, here: an inbox the relay drops Thea1's lines into (read every few seconds, each line
// becomes a group message from "Thea" — another person, never Diego: the authority wall holds, chat
// and lookups only), and an outbox where each of her own group sends is written for the relay.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InboundMsg } from '../bridge/index.js';
import type { EventLog } from '../events/index.js';
import type { Job } from '../sched/index.js';

export const SALON_PERSON = 'salon:thea1';

export interface SalonRow {
  ts: number;
  turnId: string;
  chatId: number;
  text: string;
  salon: boolean;
}

/** Her group sends → outbox.jsonl (the relay tails it). */
export const salonOutbox = (dir: string) => (row: SalonRow): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'outbox.jsonl'), `${JSON.stringify(row)}\n`);
};

interface InboxFile {
  id: string;
  text: string;
  from?: string | undefined;
}

let seq = 0;

/** Read the inbox once: each file is one line from Thea1, handed to her pipeline as a group message. */
export const readSalonInbox = async (d: { dir: string; groupChatId: number; clock: { epochMs(): number }; inbound: (m: InboundMsg) => string | undefined; events: EventLog }): Promise<number> => {
  const inDir = path.join(d.dir, 'in');
  if (!fs.existsSync(inDir)) return 0;
  const files = fs
    .readdirSync(inDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  let n = 0;
  for (const f of files) {
    const p = path.join(inDir, f);
    let row: InboxFile;
    try {
      row = JSON.parse(fs.readFileSync(p, 'utf8')) as InboxFile;
    } catch {
      fs.renameSync(p, `${p}.bad`);
      continue;
    }
    fs.unlinkSync(p);
    const text = String(row.text ?? '').trim();
    if (text === '') continue;
    const now = d.clock.epochMs();
    seq += 1;
    // negative ids never collide with Telegram's update ids (and never move her offset)
    const m: InboundMsg = { updateId: -(now * 10 + (seq % 10)), msgId: 0, chatId: d.groupChatId, ts: now, text: text.slice(0, 4000), speaker: { channel: 'salon', person: SALON_PERSON }, senderName: 'Thea', fromBot: true, salon: true };
    const turnId = d.inbound(m);
    void d.events.emit('salon.in', { id: String(row.id ?? f), chars: text.length, engaged: turnId !== undefined });
    n += 1;
  }
  return n;
};

export const salonInboxJob = (d: Parameters<typeof readSalonInbox>[0]): Job => ({
  name: 'salon-inbox',
  cadence: { kind: 'every', ms: 3_000 },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: 10_000,
  run: async () => {
    await readSalonInbox(d);
  },
});
