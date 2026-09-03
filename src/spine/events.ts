// M21 spine — the SSE -> L0 bridge (S1.2). `GET /event` speaks Server-Sent
// Events; this file parses the frames, maps the documented v1.18.x event
// vocabulary onto StreamEvents, and stamps `model.call` with the DR.4 field
// names (usage.inputTokens/usage.outputTokens/usage.costUsd, top-level
// stopReason) so the Ledger reads spine turns exactly like native calls.
//
// M21 scope note: one pinned spine child, one active turn (ADR-002 amendment),
// so frames are NOT filtered by session id — the recorded fixtures pin this
// shape and M22's multi-session fan-out will add the filter when casts land.

import type { EventLog } from '../events/index.js';
import type { ModelCallEvent, StopReason } from '../model/index.js';
import type { SpineUsage, StreamEvent } from './types.js';

/** One parsed SSE frame: the `event:` line plus the decoded `data:` value. */
export interface SseFrame {
  event?: string | undefined;
  data: unknown;
}

/**
 * Parses an SSE byte stream into frames. Blank-line delimited; `data:` lines
 * are JSON when they parse as such, raw text otherwise. No guessing beyond
 * that: an undecodable frame is surfaced to the pump as a data event with the
 * raw string, where the type switch ignores it (visible in debugging, inert in
 * dispatch).
 */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf('\n\n');
    while (at !== -1) {
      const rawFrame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of rawFrame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) {
        const raw = dataLines.join('\n');
        let data: unknown = raw;
        try {
          data = JSON.parse(raw) as unknown;
        } catch {
          // keep the raw string — the type switch ignores unknown shapes
        }
        yield { ...(event !== undefined ? { event } : {}), data };
      }
      at = buffer.indexOf('\n\n');
    }
  }
}

/**
 * OpenCode's `finish` vocabulary onto the DR.4 stop-reason vocabulary — the
 * same mapping table M03's openai wire uses (stop -> end_turn, length ->
 * max_tokens, tool-calls -> tool_use). Unknown values pass through as strings.
 */
export const mapFinishToStopReason = (finish: string | undefined): StopReason => {
  switch (finish) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool-calls':
    case 'tool_use':
      return 'tool_use';
    case 'abort':
    case 'aborted':
      return 'aborted';
    default:
      return finish ?? 'end_turn';
  }
};

const emptyUsage = (): { inputTokens: number; outputTokens: number; costUsd?: number } => ({
  inputTokens: 0,
  outputTokens: 0,
});

export interface SseTurnBridgeOpts {
  /** Decide turns buffer text (the object must validate before anything yields). */
  decide: boolean;
  turnStartMs: number;
  nowMs: () => number;
}

export interface SseCompletion {
  usage: SpineUsage;
  stopReason: StopReason;
}

export interface SseFeedResult {
  /** StreamEvents produced by this frame (empty in decide mode). */
  events: StreamEvent[];
  /** True when `session.idle` ended the turn. */
  done: boolean;
  /** Set when `session.error` fired — the caller turns this into an incident. */
  error?: string | undefined;
  /** Set when an assistant message completed (the caller emits model.call). */
  completed?: SseCompletion | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The per-turn frame mapper. In plain turns every text part streams as a
 * text-delta and every completed assistant message yields usage + stop-reason.
 * In decide turns text buffers for validation and usage ACCUMULATES across the
 * logical call (retries + the one repair fold in, per DR.4).
 */
export class SseTurnBridge {
  private readonly decide: boolean;
  private readonly turnStartMs: number;
  private readonly nowMs: () => number;
  private decideBuffer = '';
  private summed: { inputTokens: number; outputTokens: number; costUsd?: number } = emptyUsage();
  private stop: StopReason | undefined;

  constructor(opts: SseTurnBridgeOpts) {
    this.decide = opts.decide;
    this.turnStartMs = opts.turnStartMs;
    this.nowMs = opts.nowMs;
  }

  /** The buffered structured-output text (decide turns). */
  get decideText(): string {
    return this.decideBuffer;
  }

  /** Tokens/cost summed across every message of the logical call. */
  get summedUsage(): { inputTokens: number; outputTokens: number; costUsd?: number } {
    return this.summed;
  }

  get lastStopReason(): StopReason | undefined {
    return this.stop;
  }

  feed(frame: SseFrame): SseFeedResult {
    const data = frame.data;
    if (!isRecord(data) || typeof data['type'] !== 'string') return { events: [], done: false };
    switch (data['type']) {
      case 'message.part.updated':
        return this.feedPartUpdated(data);
      case 'message.updated':
        return this.feedMessageUpdated(data);
      case 'session.idle':
        return { events: [], done: true };
      case 'session.error': {
        const message = isRecord(data['properties']) && typeof data['properties']['error'] === 'string' ? data['properties']['error'] : 'session.error';
        return { events: [], done: true, error: message };
      }
      default:
        return { events: [], done: false };
    }
  }

  private feedPartUpdated(data: Record<string, unknown>): SseFeedResult {
    const props = data['properties'];
    if (!isRecord(props) || !isRecord(props['part'])) return { events: [], done: false };
    const part = props['part'];
    const type = part['type'];
    if (type === 'text' && typeof part['text'] === 'string') {
      if (this.decide) {
        this.decideBuffer += part['text'];
        return { events: [], done: false };
      }
      return { events: [{ type: 'text-delta', text: part['text'] }], done: false };
    }
    if (type === 'tool') {
      const callId = typeof part['callID'] === 'string' ? part['callID'] : typeof part['id'] === 'string' ? part['id'] : '';
      const name = typeof part['tool'] === 'string' ? part['tool'] : 'unknown';
      const state = isRecord(part['state']) ? part['state'] : {};
      const rawArgs = state['input'] ?? {};
      return { events: [{ type: 'tool-call', call: { id: callId, name, args: rawArgs } }], done: false };
    }
    // reasoning parts are not in the M21 StreamEvent vocabulary (her turns run
    // without a thinking trace on the voice door) — visible here, mapped never.
    return { events: [], done: false };
  }

  private feedMessageUpdated(data: Record<string, unknown>): SseFeedResult {
    const props = data['properties'];
    if (!isRecord(props) || !isRecord(props['info'])) return { events: [], done: false };
    const info = props['info'];
    if (info['role'] !== undefined && info['role'] !== 'assistant') return { events: [], done: false };
    const tokens = isRecord(info['tokens']) ? info['tokens'] : {};
    const input = typeof tokens['input'] === 'number' ? tokens['input'] : 0;
    const output = typeof tokens['output'] === 'number' ? tokens['output'] : 0;
    const cost = typeof info['cost'] === 'number' ? info['cost'] : undefined;
    const finish = typeof info['finish'] === 'string' ? info['finish'] : undefined;
    const stopReason = mapFinishToStopReason(finish);
    this.stop = stopReason;
    const usage: SpineUsage = {
      inputTokens: input,
      outputTokens: output,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      latencyMs: Math.max(0, this.nowMs() - this.turnStartMs),
      attempts: 1,
    };
    if (this.decide) {
      this.summed = {
        inputTokens: this.summed.inputTokens + input,
        outputTokens: this.summed.outputTokens + output,
        ...(this.summed.costUsd !== undefined || cost !== undefined
          ? { costUsd: (this.summed.costUsd ?? 0) + (cost ?? 0) }
          : {}),
      };
      return { events: [], done: false };
    }
    return { events: [{ type: 'usage', usage }, { type: 'stop-reason', stopReason }], done: false, completed: { usage, stopReason } };
  }
}

/**
 * The DR.4 `model.call` payload, emitted advisory (a broken log never kills a
 * turn). Field-for-field ModelCallEvent from src/model — the Ledger cannot
 * tell a spine call from a native one.
 */
export const emitModelCall = async (
  events: EventLog,
  payload: ModelCallEvent & { turnId?: string },
  turnId?: string,
): Promise<void> => {
  try {
    const { turnId: _inPayload, ...rest } = payload;
    await events.emit('model.call', rest, turnId ?? payload.turnId);
  } catch {
    // advisory — M02 has already retried once and reported to stderr
  }
};
