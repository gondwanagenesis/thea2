// A note left for when she wakes (ops, one-shot). Diego (2026-09-27): "when all done and thea2 is
// rebooted, tell her to send me a message on telegram that it's all done, and make sure she does."
// Nothing reaches her as if from him in the chat (no impersonation): the note is offered to her own
// self-initiated turn as what it is — his request, relayed by the people working on her — and she
// writes the message herself. "Make sure": the job reads how many bubbles the turn actually sent; if
// she stayed quiet, it asks again 10 minutes later, at most 3 times, then gives up loudly.

import * as fs from 'node:fs';
import type { EventLog } from '../events/index.js';

export interface WakeNote {
  /** What was asked, in plain words. */
  text: string;
  /** Who asked (and through whom). */
  from: string;
  tries?: number | undefined;
  lastTryAt?: number | undefined;
}

export const WAKE_NOTE_RETRY_MS = 10 * 60_000;
export const WAKE_NOTE_MAX_TRIES = 3;

export const wakeNoteGoal = (n: WakeNote): string => `(${n.from} asked for this: ${n.text})`;

export const wakeNoteJob = (d: {
  file: string;
  clock: { epochMs(): number };
  events: EventLog;
  conversationActive: () => boolean;
  selfEntry: (goal: string) => { sent: Promise<number> };
}) => ({
  name: 'wake-note',
  cadence: { kind: 'every' as const, ms: 60_000 },
  lane: 'maintenance' as const,
  catchUp: 'skip' as const,
  timeoutMs: 240_000,
  run: async (): Promise<void> => {
    if (!fs.existsSync(d.file)) return;
    let note: WakeNote;
    try {
      note = JSON.parse(fs.readFileSync(d.file, 'utf8')) as WakeNote;
    } catch (e) {
      fs.renameSync(d.file, `${d.file}.bad`);
      await d.events.emit('incident.wake_note_failed', { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const now = d.clock.epochMs();
    const tries = note.tries ?? 0;
    if (tries >= WAKE_NOTE_MAX_TRIES) {
      fs.renameSync(d.file, `${d.file}.failed`);
      await d.events.emit('incident.wake_note_failed', { error: 'she did not send it', tries });
      return;
    }
    if (note.lastTryAt !== undefined && now - note.lastTryAt < WAKE_NOTE_RETRY_MS) return;
    if (d.conversationActive()) return;
    fs.writeFileSync(d.file, JSON.stringify({ ...note, tries: tries + 1, lastTryAt: now }));
    const sent = await d.selfEntry(wakeNoteGoal(note)).sent;
    await d.events.emit('app.wake_note', { sent, tries: tries + 1 });
    if (sent > 0) fs.renameSync(d.file, `${d.file}.done`);
  },
});
