// M14 realize — the ONLY text operations the realizer may perform (spec
// §Behavior: "output texts are the decision's bubbles verbatim ... merging
// adjacent bubbles and splitting an oversized bubble on paragraph/sentence
// boundaries"). This file is where that permission is bounded: there is no
// paraphrase, restyle, or trim-beyond-boundary anywhere else in the module, and
// the property tests hold the outputs to the whitespace-squash invariant so a
// rewrite cannot slip in unnoticed.

import { RealizeError } from './errors.js';

/** Sentence boundary: a terminator followed by whitespace. Ellipsis included; quotes/brackets are not chased. */
const SENTENCE_END = /[.!?…]\s/g;

/**
 * Shapes the decision's bubbles into sendable ones: whitespace-only bubbles
 * dropped, oversized bubbles split, over-count merges joined with '\n' — until
 * every piece fits `maxChars` and, when merging can still get there, the count
 * fits `maxBubbles`. The char cap outranks the count cap: merging that would
 * breach `maxChars` is skipped (the extra bubble survives), because Telegram
 * rejects the send while five-vs-six bubbles is only style.
 */
export const shapeBubbles = (bubbles: readonly string[], maxChars: number, maxBubbles: number): string[] => {
  // Whitespace-only bubbles carry no words; dropping them keeps the squash
  // invariant (they contribute nothing to it) and avoids empty sends.
  const pieces: string[] = [];
  for (const b of bubbles) {
    const trimmed = b.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > maxChars) pieces.push(...splitBubble(trimmed, maxChars));
    else pieces.push(trimmed);
  }

  // Merge pass: chain adjacent joins left to right while the count is over the
  // cap and the join fits the char limit.
  let i = 0;
  while (pieces.length > maxBubbles && i < pieces.length - 1) {
    const merged = `${pieces[i] ?? ''}\n${pieces[i + 1] ?? ''}`;
    if (merged.length <= maxChars) {
      pieces.splice(i, 2, merged);
    } else {
      i += 1;
    }
  }
  return pieces;
};

/** Splits one oversized bubble, preferring paragraph cuts, then sentence cuts. */
const splitBubble = (text: string, maxChars: number): string[] => {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const cut = cutAt(rest, maxChars);
    if (cut === -1) {
      // No legal cut exists: one sentence is longer than the channel accepts.
      // Sending it anyway would die in the transport (FakeChannel throws in
      // CI); failing here names the cause instead.
      throw new RealizeError(
        'realize/unsplittable-bubble',
        `bubble of ${text.length} chars has no paragraph/sentence boundary within maxMsgChars ${maxChars}`,
      );
    }
    const head = rest.slice(0, cut).trim();
    if (head.length > 0) pieces.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
};

/**
 * Index just past the best boundary at or before `maxChars`, or -1. Paragraph
 * cuts win over sentence cuts — a paragraph break loses less of the shape —
 * and only the whitespace at the cut is consumed, which is what keeps the
 * squash invariant exact.
 */
const cutAt = (s: string, maxChars: number): number => {
  const para = s.lastIndexOf('\n\n', maxChars - 2);
  if (para !== -1) return para + 2;

  let cut = -1;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(s); m !== null; m = SENTENCE_END.exec(s)) {
    const end = m.index + m[0].length; // just past the whitespace
    if (end > maxChars) break;
    cut = end;
  }
  return cut;
};
