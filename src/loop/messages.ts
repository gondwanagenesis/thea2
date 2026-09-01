// M13 loop — the message-array layout (§2.7). The order is load-bearing and
// byte-stable: head system message (packet + [PROCEDURAL] appended, so the
// procedure exemplars sit beside the tool definitions they exemplify), the
// optional [EARLIER] continuity line, the rolling window verbatim, the current
// turn, and [INHIBITION] last — recency wins. The 'merged' fallback folds the
// trailer into the head message for backends that mishandle trailing system
// messages; the two modes must carry the same text, only the envelope differs.

import { estimateTokens, type ChatMsg } from '../model/index.js';
import type { SessionWindow } from '../memory/index.js';
import type { LoopPacket } from './types.js';
import type { InhibitionPlacement } from './config.js';

export interface MessageLayoutInput {
  packet: LoopPacket;
  window: SessionWindow;
  /** The current turn as the model sees it: his message, or the entry's goal. */
  turnText: string;
  placement: InhibitionPlacement;
}

export const buildMessages = (i: MessageLayoutInput): ChatMsg[] => {
  const head = withProcedural(i.packet);
  const trailer = i.packet.trailerText();
  const msgs: ChatMsg[] = [];

  if (i.placement === 'merged') {
    msgs.push({ role: 'system', content: `${head}\n\n${trailer}` });
  } else {
    msgs.push({ role: 'system', content: head });
  }

  const earlier = i.window.earlier();
  if (earlier !== null) msgs.push({ role: 'system', content: earlier });

  msgs.push(...i.window.messages());
  msgs.push({ role: 'user', content: i.turnText });

  if (i.placement === 'trailing') msgs.push({ role: 'system', content: trailer });
  return msgs;
};

/** [PROCEDURAL] travels with the tool defs — appended to the head message, never inside [EXEMPLARS]. */
const withProcedural = (packet: LoopPacket): string => {
  const head = packet.systemText();
  const proc = packet.proceduralText();
  return proc === null || proc === '' ? head : `${head}\n\n${proc}`;
};

// ---------------------------------------------------------------------------
// Observation budget (§2.7: current turn + this-turn tool observations ≤ 6k)
// ---------------------------------------------------------------------------

/** Minimum observation kept when truncating — a tool answer cut to nothing is a tool that never answered. */
const MIN_OBSERVATION_CHARS = 200;

/**
 * Fits one observation into the token that remains of the turn budget. Returns
 * the text to render into the tool-role message, truncation-marked when cut.
 */
export const fitObservation = (text: string, usedTokens: number, budgetTokens: number): string => {
  const remaining = budgetTokens - usedTokens;
  if (remaining >= estimateTokens([text])) return text;
  if (remaining <= 0) return '[budget] truncated — the observation budget for this turn is spent';
  // ~4 chars/token (estimateTokens), with slack so the marker itself fits.
  const maxChars = Math.max(MIN_OBSERVATION_CHARS, remaining * 4 - 32);
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}…[truncated to fit the observation budget]`;
};
