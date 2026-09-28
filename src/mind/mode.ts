// Work mode (v14, Diego 2026-09-28: "yes, move all debugging things into work mode"). Her everyday life
// had become being debugged — 32% of her friend-mode turns talked about her own machinery (people: 0–5%)
// — because every upgrade, fork and fix happened inside her ordinary chat and came back as her memories,
// her examples and what was on her mind. A work turn is still lived and remembered, but it stays in the
// workshop: it is not evoked in friend turns, what it opens is not on her mind in friend turns, and her
// words there are precise (dressed, not retyped — golden rule 9: "work: short, precise").
//
// A turn is work when he said so ("work mode", until "friend mode" or two quiet hours), or when his
// message is about her machinery (that one turn).

import { MACHINERY } from './humanness.js';

export type Mode = 'friend' | 'work';

/** "work mode" / "friend mode" / "play mode" (golden rule 9), anywhere in a short message or at its start. */
export const MODE_SWITCH = /(?:^|\s)(work|friend|play)[ -]mode\b/i;

/** His message is about her machinery (he is working on her). */
export const WORK_CUES = new RegExp(
  `${MACHINERY.source}|\\b(debug(ging)?|bugs?|deploy(ed)?|restart(ed)?|patch(ed)?|logs?|the (mouth|pipeline|salon relay|appraiser|ledger)|your (memory|memories|prompt|code|files|brain|system|settings|self[- ]lines)|i (fixed|changed|updated|upgraded|rewrote|reset) (you|your|it))\\b`,
  'i',
);

/** An explicit work mode ends after this long without a word from him. */
export const MODE_IDLE_MS = 2 * 3600_000;

export interface ModeState {
  mode?: Mode | undefined;
  modeAt?: number | undefined;
}

/** This turn's mode, and the standing mode to keep (when he switched it). */
export const modeFor = (text: string | undefined, st: ModeState, now: number): { mode: Mode; standing?: Mode | undefined } => {
  const t = text ?? '';
  const sw = MODE_SWITCH.exec(t);
  if (sw !== null) {
    const m: Mode = sw[1]!.toLowerCase() === 'work' ? 'work' : 'friend';
    return { mode: m, standing: m };
  }
  if (st.mode === 'work' && st.modeAt !== undefined && now - st.modeAt < MODE_IDLE_MS) return { mode: 'work', standing: 'work' };
  return { mode: t !== '' && WORK_CUES.test(t) ? 'work' : 'friend' };
};
