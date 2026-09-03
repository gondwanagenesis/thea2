// M20 app — register inference, v1. The review's P0-4: register was the
// constant 'play', which made mode_exclusive permanently unselect 25% of canon
// (every boundaries/work/friend scene). This is the smallest honest resolver:
// lexical cues from HIS text, bounded by HIS wall clock (a "deploy is broken"
// at 2 a.m. Madrid is conversation, not work mode). Round 3 per the plan —
// the corpus stays the source of truth; this only picks which scenes MAY
// compete. `mode_exclusive` still excludes; quota strictness stays the
// assembler's business.

import type { TurnQuery } from '../assemble/index.js';

export type Register = TurnQuery['register'];

/** Strong cues: one hit is enough — she is being talked to about the machine. */
const STRONG_WORK = [
  /```/, // a code fence
  /https?:\/\/\S+/i, // a link
  /\b\d+\.\d+\.\d+\b/, // a three-part version
  /\b(typecheck|depcruise|stack ?trace|traceback|stacktrace)\b/i,
];

/** Weak cues: two or more in one message read as work mode. */
const WEAK_WORK = [
  /\b(deploy|deploying|deployed)\b/i,
  /\b(build|building|rebuilt)\b/i,
  /\b(server|vps|nginx|systemd|docker)\b/i,
  /\b(bug|regression|hotfix|patch)\b/i,
  /\b(error|errors|exception|crash(ed|ing)?|failing|failed)\b/i,
  /\b(pr|merge|commit|push|branch|rebase)\b/i,
  /\b(log|logs|uptime|latency|429|rate ?limit)\b/i,
  /\b(config|yaml|schema|typescript|eslint|vitest)\b/i,
];

/** Explicit friend cues — being addressed as a person, not a colleague. */
const FRIEND = [/\b(amigo|amiga|amiguete|compa|hermano|hermana|bestie|cariñ[oa])\b/i];

/** Local hours where "work" is a plausible frame in Diego's day (CEST/CET). */
const WORK_WINDOW: [number, number] = [8, 21];

export const inferRegister = (text: string, localHour: number | undefined): Register => {
  if (FRIEND.some((re) => re.test(text))) return 'friend';
  const strong = STRONG_WORK.filter((re) => re.test(text)).length;
  const weak = WEAK_WORK.filter((re) => re.test(text)).length;
  if (strong >= 1 || weak >= 2) {
    // The clock modifier: machine talk outside his working day is a friend
    // wading through problems at midnight — the scenes that fit that are the
    // play/friend ones, not work-mode-backup.
    if (localHour === undefined) return 'work';
    return localHour >= WORK_WINDOW[0] && localHour < WORK_WINDOW[1] ? 'work' : 'play';
  }
  return 'play';
};
