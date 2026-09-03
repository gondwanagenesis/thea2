// M15 bridge — the public contract (docs/modules/M15-bridge.md §Interfaces).
//
// The bridge is the only module that knows Telegram exists. Everything above it
// talks to `Channel` (the transport seam) and `MessageLedger` (the
// delivery-correctness store); the load-bearing ordering — offset committed only
// after ledger append + pipeline enqueue — lives in ingest.ts, not here.

/** Who a message is from, as the two halves of `<person>:<channel>`. Stamped at the bridge from the wire sender; never inferred later from text. */
export interface SpeakerRef {
  person: string;
  channel: string;
}

export interface InboundMsg {
  updateId: number; // Telegram update_id — the ledger's dedupe key
  msgId: number; // channel message id; for a reaction, the message reacted to
  chatId: number;
  ts: number; // epochMs
  text: string; // verbatim; '' for reaction-only arrivals
  speaker: SpeakerRef;
  /** Present on reaction updates — a free outcome signal for credit (M09), never a request awaiting a reply. */
  reaction?: { emoji: string; toMsgId: number } | undefined;
  /**
   * Present on updates the bridge could not or must not turn into a turn (a
   * photo, an edit, a stranger's chat). Recorded so the offset can move past
   * them — an unrecorded skip re-polls forever — and never owed a reply.
   */
  skipped?: { reason: string } | undefined;
}

/**
 * Who decided a silence. `model` — her own locked plan; `gate` — the inhibition
 * gate forced it after the re-entry cap; `failure` — the loop could not produce
 * a decision at all (parse failure, budget exhaustion, assembly error). Only the
 * first two are restraint; the third is a lost reply wearing a decision row, and
 * reconcile treats it as such (ADR-003: silence by failure is a discrepancy).
 */
export type DecidedBy = 'model' | 'gate' | 'failure';

export interface ChannelLimits {
  maxMsgChars: number;
  minSendGapMs: number;
  typingRefreshMs: number;
}

/** Telegram physics. The real adapter publishes these; FakeChannel enforces them, so a 429 in prod is red in CI. */
export const TELEGRAM_LIMITS: ChannelLimits = {
  maxMsgChars: 4096,
  minSendGapMs: 1100, // per-chat send rate limit
  typingRefreshMs: 4000, // typing expires ~5s; M14 re-fires before that
};

export interface Channel {
  updates(signal: AbortSignal): AsyncIterable<InboundMsg>;
  send(chatId: number, text: string): Promise<{ msgId: number }>;
  typing(chatId: number): Promise<void>;
  readonly limits: ChannelLimits;
}

export type DecisionPlan = 'reply' | 'silent' | 'defer';

export interface DecisionSummary {
  turnId: string;
  plan: DecisionPlan;
  at: number;
  /** `plan:'defer'` only — epochMs the deferred turn comes due (ADR-003 bookkeeping). Required for defer, rejected otherwise. */
  dueBy?: number | undefined;
  /** Provenance of the plan. Absent = 'model' (rows written before provenance existed). */
  decidedBy?: DecidedBy | undefined;
}

/**
 * What reconcile found. Every inbound lands in exactly one verdict: the absence
 * of any discrepancy IS the verdict (replied / decided-silent / still-inside-T).
 * Silence by design is a typed ledger row; silence by failure is a LOST_REPLY.
 */
export type Discrepancy =
  | { kind: 'LOST_REPLY'; inbound: InboundMsg; ageMs: number; turnId?: string | undefined }
  | { kind: 'DUPLICATE_INBOUND'; updateId: number };

/** One durable ledger row. The ledger — not the event log — is what reconcile reads. */
export type LedgerRow =
  | { kind: 'inbound'; ts: number; msg: InboundMsg }
  | { kind: 'decision'; ts: number; turnId: string; plan: DecisionPlan; at: number; dueBy?: number | undefined; decidedBy?: DecidedBy | undefined }
  | { kind: 'outbound'; ts: number; turnId: string; msgId: number; text: string }
  | { kind: 'link'; ts: number; updateId: number; turnId: string };

export interface MessageLedger {
  /** Records the arrival. Returns false when this update_id was already seen — the arrival is still recorded, so redelivery stays visible. */
  recordInbound(m: InboundMsg): Promise<boolean>;
  recordDecision(turnId: string, d: DecisionSummary): Promise<void>;
  recordOutbound(turnId: string, msgId: number, text: string): Promise<void>;
  /** Binds an inbound to the turn that owns it, so reconcile can name what was lost (and the daily report can follow it). */
  linkTurn(updateId: number, turnId: string): Promise<void>;
  /** Pure read over the ledger + the T window: inbound with neither outbound nor a recorded silent/deferred decision past T ⇒ LOST_REPLY. A `decidedBy:'failure'` silence is NOT a termination. */
  reconcile(now: number): Promise<Discrepancy[]>;
  /** Every durable row, file-date order — for M18's report and test assertions. */
  read(): AsyncIterable<LedgerRow>;
}

/** Reconciliation window T: an inbound must terminate within this much time (M15 spec suggests 10 min; M20 config may move it). */
export const DEFAULT_RECONCILE_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// L0 payloads (mirrors schemas/events.ts — M15 owns these shapes)
// ---------------------------------------------------------------------------

/** `bridge.lost_reply` — the reconciliation alarm that replaced Thea1's sentinel. */
export interface LostReplyEvent {
  updateId: number;
  chatId: number;
  ageMs: number;
  turnId?: string | undefined;
}

/** `bridge.send_failed` — a send gave up (rate limit exhausted or hard error). */
export interface SendFailedEvent {
  chatId: number;
  code: string;
  attempts: number;
  error: string;
  retryAfterMs?: number | undefined;
}
