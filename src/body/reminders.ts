// v9 body — reminders (Thea1's reminders.mjs: "remind me get the plane
// tickets tomorrow!!" must actually fire). Stored in her house; a scheduler
// job checks every minute and hands each due one back to her as a moment she
// lives (a self-entry turn), so she says it in her own words.

import type { House } from './house.js';

export interface Reminder {
  id: string;
  text: string;
  due: number;
  created: number;
  firedAt?: number | undefined;
}

const FILE = 'reminders.json';

/** "in 45m" / "in 3h" / "in 2d" / an ISO time with its offset. undefined = can't tell when. */
export const parseWhen = (when: string, now: number): number | undefined => {
  const rel = /^\s*in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)\s*$/i.exec(when);
  if (rel !== null) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
    return now + Math.round(n * ms);
  }
  if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(when)) return undefined;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(when.trim())) return undefined; // a time without its zone is a guess
  const t = Date.parse(when);
  return Number.isFinite(t) ? t : undefined;
};

export const makeReminders = (house: House) => {
  const all = (): Reminder[] => house.readJson<Reminder[]>(FILE, []);
  const save = (rs: Reminder[]): void => house.writeJson(FILE, rs.slice(-200));
  return {
    add: (text: string, due: number, now: number): Reminder => {
      const r: Reminder = { id: `r${now}`, text: text.slice(0, 500), due, created: now };
      save([...all(), r]);
      return r;
    },
    pending: (): Reminder[] => all().filter((r) => r.firedAt === undefined).sort((a, b) => a.due - b.due),
    /** Marks due ones fired and returns them (at-most-once: the mark lands before she is told). */
    takeDue: (now: number): Reminder[] => {
      const rs = all();
      const due = rs.filter((r) => r.firedAt === undefined && r.due <= now);
      if (due.length === 0) return [];
      for (const r of due) r.firedAt = now;
      save(rs);
      return due;
    },
    cancel: (id: string): boolean => {
      const rs = all();
      const i = rs.findIndex((r) => r.id === id && r.firedAt === undefined);
      if (i < 0) return false;
      rs.splice(i, 1);
      save(rs);
      return true;
    },
  };
};
export type Reminders = ReturnType<typeof makeReminders>;

/** Every minute: due reminders come back to her as moments she lives (so she tells him in her words). */
export const remindersJob = (reminders: Reminders, clock: { epochMs(): number }, selfEntry: (goal: string) => void) => ({
  name: 'reminders',
  cadence: { kind: 'every' as const, ms: 60_000 },
  lane: 'maintenance' as const,
  catchUp: 'skip' as const,
  timeoutMs: 20_000,
  run: async (): Promise<void> => {
    for (const r of reminders.takeDue(clock.epochMs())) {
      selfEntry(`(a reminder you set for him is due now: "${r.text}")`);
    }
  },
});
