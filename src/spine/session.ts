// M21 spine — session lifecycle (S1.2). One spine session per conversation;
// our 4h session-break drives the fork/new. The spine child itself has NO
// cross-session memory (verified 2026-09-03) — recall stays ours — so the
// mapping is pure bookkeeping: conversation key -> {sessionId, lastTurnMs}.

export interface SpineSessionRecord {
  id: string;
  conversationId: string;
  /** Epoch ms of the last turn seen on this session. */
  lastTurnMs: number;
  turns: number;
  /** How many times the break forked this conversation onto a fresh session. */
  forks: number;
}

export type SessionCreateReason = 'first-turn' | 'session-break';

export interface SessionEnsureResult {
  session: SpineSessionRecord;
  /** True when a fresh session was created on this turn. */
  created: boolean;
  reason?: SessionCreateReason | undefined;
  /** The idle that triggered the break, when it fired. */
  brokeAfterMs?: number | undefined;
}

/**
 * The conversation -> session map. `create` is the runner's POST /session
 * (injected so the store stays pure); `nowMs` comes from the injected clock.
 */
export class SpineSessions {
  private readonly byConversation = new Map<string, SpineSessionRecord>();

  constructor(private readonly sessionBreakMs: number) {}

  async ensure(
    conversationId: string,
    nowMs: number,
    create: (reason: SessionCreateReason) => Promise<string>,
  ): Promise<SessionEnsureResult> {
    const prev = this.byConversation.get(conversationId);
    if (prev === undefined) {
      const id = await create('first-turn');
      const rec: SpineSessionRecord = { id, conversationId, lastTurnMs: nowMs, turns: 1, forks: 0 };
      this.byConversation.set(conversationId, rec);
      return { session: rec, created: true, reason: 'first-turn' };
    }
    const idle = nowMs - prev.lastTurnMs;
    if (idle >= this.sessionBreakMs) {
      // the 4h break: a fresh spine session (OpenCode's fork endpoint is the
      // M22 upgrade path; M21 forks by creating new, which loses nothing —
      // recall is ours, the spine session is just the live window).
      const id = await create('session-break');
      const rec: SpineSessionRecord = { id, conversationId, lastTurnMs: nowMs, turns: 1, forks: prev.forks + 1 };
      this.byConversation.set(conversationId, rec);
      return { session: rec, created: true, reason: 'session-break', brokeAfterMs: idle };
    }
    prev.lastTurnMs = nowMs;
    prev.turns += 1;
    return { session: prev, created: false };
  }

  get(conversationId: string): SpineSessionRecord | undefined {
    return this.byConversation.get(conversationId);
  }
}

/** The conversation key for an entry: his chat, or the entry kind's singleton. */
export const conversationIdFor = (entry: { kind: string; inbound?: { chatId: number } | undefined }): string =>
  entry.inbound !== undefined ? `tg:${entry.inbound.chatId}` : `entry:${entry.kind}`;
