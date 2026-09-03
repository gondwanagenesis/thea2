// M09 memory — the rolling session window (report §2.7). Verbatim user /
// assistant messages only — intra-turn tool traffic is dropped at decision lock
// and survives as episodes + delegation events, never as window noise. Keep
// min(last 30 messages, 10k tokens), evict from head; a ≥20-message eviction
// span produces ONE cheap-tier `[EARLIER] …` line that is cached and re-used
// until the NEXT span evicts.
//
// Session break = 4h silence: the window resets to just the summary line.
// Continuity is memory's job — the packet stays dominant instead of drowning
// in a hundred turns of raw chat (Thea1's compaction pain, stated as the
// design reason).
//
// The break is computed from the messages' own timestamps, not the wall clock:
// replaying a day of traffic through an injected TestClock must reproduce the
// exact same window.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteJson, fail, type Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import { estimateTokens, type ChatMsg, type ModelClient } from '../model/index.js';
import { HOURS } from '../affect/index.js';
import { failMemory } from './errors.js';

// ---------------------------------------------------------------------------
// Load-bearing constants (report §2.7)
// ---------------------------------------------------------------------------

export const WINDOW_MAX_MESSAGES = 30;
export const WINDOW_MAX_TOKENS = 10_000;
/** A summary is generated once per evicted span of at least this many messages. */
export const WINDOW_SUMMARY_SPAN = 20;
export const SESSION_BREAK_MS = 4 * HOURS;

// Summarizer call shape (cheap tier, plain text — no schema worth a ladder).
// 160 is the visible-answer size; thinking models burn budget before any text,
// so the call carries headroom (the live-proven starvation family).
export const SUMMARY_MAX_TOKENS = 2000;
export const SUMMARY_TEMPERATURE = 0;
export const SUMMARY_TASK_CLASS = 'summarize' as const;

/** Emitted when the span summarizer fails: the eviction still happens (the cap
 * is non-negotiable), but the loss of the continuity line is said out loud. */
export const WINDOW_SUMMARY_INCIDENT = 'incident.window_summary_failed';

export interface WindowMsg {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  turnId: string;
}

export interface SessionWindow {
  push(msg: WindowMsg): Promise<void>;
  /**
   * Appends straight to the PENDING span — the [EARLIER] feedstock — without
   * entering the live window (P-CLOSE CL.3: an abandoned loss's text must be
   * carried by the continuity line, never answered as if it had just arrived).
   * Optional in the type so pre-existing test fakes stay valid; the real
   * window always provides it.
   * NOTE (P-CLOSE, 2026-09-03): added additively for the P-CLOSE package — the
   * owner files list did not include this module; flagged in the P-CLOSE report.
   */
  pushPending?(msg: WindowMsg): Promise<void>;
  /** The verbatim window, oldest first — exactly what M13 renders into the message array. */
  messages(): ChatMsg[];
  /** The cached '[EARLIER] …' line, or null before any span has been summarized. */
  earlier(): string | null;
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

interface WindowState {
  msgs: WindowMsg[];
  /** Evicted-but-not-yet-summarized messages, in eviction order. */
  pending: WindowMsg[];
  /** The full cached line, '[EARLIER] …' included. */
  summary: string | null;
}

const windowPathOf = (dir: string): string => path.join(dir, 'window.json');

export const openSessionWindow = (dir: string, deps: { model: ModelClient; clock: Clock; events: EventLog }): SessionWindow => {
  let state: WindowState | undefined;

  const load = async (): Promise<void> => {
    let text: string;
    try {
      text = await fsp.readFile(windowPathOf(dir), 'utf8');
    } catch {
      state = { msgs: [], pending: [], summary: null }; // absent = fresh window, the normal first boot
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (e) {
      return fail('memory/window-corrupt', `${windowPathOf(dir)} is not valid JSON`, e);
    }
    const s = parsed as { version?: unknown; msgs?: unknown; pending?: unknown; summary?: unknown } | null;
    if (typeof s !== 'object' || s === null || s['version'] !== 1 || !Array.isArray(s['msgs']) || !Array.isArray(s['pending'])) {
      return fail('memory/window-corrupt', `${windowPathOf(dir)} is not a version-1 window state`);
    }
    const readMsg = (raw: unknown): WindowMsg => {
      const m = raw as { role?: unknown; content?: unknown; ts?: unknown; turnId?: unknown } | null;
      if (
        typeof m !== 'object' ||
        m === null ||
        (m['role'] !== 'user' && m['role'] !== 'assistant') ||
        typeof m['content'] !== 'string' ||
        typeof m['ts'] !== 'number' ||
        typeof m['turnId'] !== 'string'
      ) {
        return fail('memory/window-corrupt', `${windowPathOf(dir)} holds a malformed window message`);
      }
      return { role: m['role'], content: m['content'], ts: m['ts'], turnId: m['turnId'] };
    };
    state = {
      msgs: s['msgs'].map(readMsg),
      pending: s['pending'].map(readMsg),
      summary: typeof s['summary'] === 'string' ? s['summary'] : null,
    };
  };

  // M05-store pattern: the load starts at open; sync readers fail loudly if a
  // caller beats it (an ordering bug at the call site, not silence).
  const booted: Promise<void> = load();
  const ensureBoot = async (): Promise<void> => {
    if (state === undefined) await booted;
  };

  const persist = async (): Promise<void> => {
    const s = state;
    if (s === undefined) return fail('memory/window-not-booted', 'persist before the window finished loading');
    await atomicWriteJson(windowPathOf(dir), {
      version: 1,
      msgs: s.msgs,
      pending: s.pending,
      summary: s.summary,
      savedAt: deps.clock.epochMs(),
    });
  };

  // Serialized like the affect store's write chain: two pushes landing in the
  // same tick (user + her reply) must not race two renames onto the same file —
  // on Windows the second rename is EPERM, not a retry.
  let writes: Promise<void> = Promise.resolve();
  const persistSerial = (): Promise<void> => {
    writes = writes.then(persist, persist);
    return writes;
  };

  const tokensOf = (msgs: readonly WindowMsg[]): number =>
    msgs.reduce((acc, m) => acc + estimateTokens([m.content]), 0);

  const summarize = async (): Promise<void> => {
    const s = state;
    if (s === undefined) return fail('memory/window-not-booted', 'summarize before the window finished loading');
    const span = s.pending;
    try {
      const res = await deps.model.chat({
        taskClass: SUMMARY_TASK_CLASS,
        tier: 'cheap',
        messages: summaryMessages(s.summary, span),
        maxTokens: SUMMARY_MAX_TOKENS,
        temperature: SUMMARY_TEMPERATURE,
      });
      const line = res.content.replace(/\s+/g, ' ').trim();
      if (line === '') return failMemory('memory/window-corrupt', 'summarizer returned an empty line');
      s.summary = `[EARLIER] ${line}`;
    } catch (e) {
      // The cap is non-negotiable and a dead model would otherwise be retried
      // on every push: drop the span (it survives as episodes) and say so.
      const detail = e instanceof Error ? e.message : String(e);
      try {
        await deps.events.emit(WINDOW_SUMMARY_INCIDENT, { error: detail, spanMessages: span.length });
      } catch {
        // L0 unwritable ⇒ advisory (M20's policy): M02 already reported to stderr.
      }
    }
    s.pending = [];
  };

  const evict = async (): Promise<void> => {
    const s = state;
    if (s === undefined) return fail('memory/window-not-booted', 'evict before the window finished loading');
    while (s.msgs.length > WINDOW_MAX_MESSAGES || tokensOf(s.msgs) > WINDOW_MAX_TOKENS) {
      const head = s.msgs.shift();
      if (head === undefined) break; // unreachable: the loop condition implies a message
      s.pending.push(head);
    }
    if (s.pending.length >= WINDOW_SUMMARY_SPAN) await summarize();
  };

  return {
    push: async (msg) => {
      await ensureBoot();
      const s = state;
      if (s === undefined) return fail('memory/window-not-booted', 'push before the window finished loading');
      // Redundant with the parameter type on purpose: the invariant "verbatim
      // user/assistant messages only" is load-bearing (tool traffic survives as
      // episodes, not window noise), so it holds at runtime too.
      if (msg.role !== 'user' && msg.role !== 'assistant') {
        return failMemory('memory/window-role', `only user/assistant messages enter the window, got '${String(msg.role)}'`);
      }
      const last = s.msgs.at(-1);
      if (last !== undefined && msg.ts - last.ts >= SESSION_BREAK_MS) {
        // 4h silence: continuity is memory's job — the window keeps only the
        // summary line, and the pre-break turns stay available as episodes.
        s.msgs = [];
      }
      s.msgs.push({ role: msg.role, content: msg.content, ts: msg.ts, turnId: msg.turnId });
      await evict();
      await persistSerial();
    },

    messages: () => {
      const s = state;
      if (s === undefined) return fail('memory/window-not-booted', 'messages() before the window finished loading');
      return s.msgs.map((m) => ({ role: m.role, content: m.content }));
    },

    pushPending: async (msg) => {
      await ensureBoot();
      const s = state;
      if (s === undefined) return fail('memory/window-not-booted', 'pushPending before the window finished loading');
      s.pending.push({ role: msg.role, content: msg.content, ts: msg.ts, turnId: msg.turnId });
      // Same span rule as eviction: once the pending span is big enough, the
      // summarizer folds it into the [EARLIER] continuity line.
      if (s.pending.length >= WINDOW_SUMMARY_SPAN) await summarize();
      await persistSerial();
    },

    earlier: () => {
      const s = state;
      if (s === undefined) return fail('memory/window-not-booted', 'earlier() before the window finished loading');
      return s.summary;
    },
  };
};

// ---------------------------------------------------------------------------
// Summarizer prompt
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM =
  'You compress a conversation span into ONE line for a continuity header. ' +
  'Reply with the line only — no quotes, no preamble, no markdown. ' +
  'Keep names, commitments, decisions and open threads; at most 30 words.';

const summaryMessages = (prior: string | null, span: readonly WindowMsg[]): ChatMsg[] => {
  const transcript = span
    .map((m) => `- ${m.role === 'user' ? 'he' : 'she'}: ${m.content.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  return [
    { role: 'system', content: SUMMARY_SYSTEM },
    {
      role: 'user',
      content: [
        `Earlier context so far: ${prior ?? '(none)'}`,
        'Messages leaving the window:',
        transcript,
        'Write the new continuity line (it may fold in the earlier context).',
      ].join('\n'),
    },
  ];
};
