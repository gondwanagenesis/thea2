// v8 mind — the data shapes of "Nothing Told" (plan thea2-v8-nothing-told.md).
//
// A MOMENT is a real exchange stored as a memory: what he said, what she said
// back, how she felt then (a vector in the coupling space, never a label in her
// prompt), what she expected, and how it landed. Precedents (her options) are
// moments whose reply is usable as "how she has been"; diary/thought moments
// are memories of what happened. Nothing here is fiction: imported moments are
// Thea's real texts, lived moments are Thea2's own.

export type MomentKind = 'reply' | 'text_first' | 'diary' | 'thought';

/** Where a felt vector came from — exact state, Thea1's (circular) inheritance, or an estimate from text. */
export type FeltSource = 'exact' | 'inherited' | 'estimated';

export interface Felt {
  /** Dense 12-dim deviation vector in coupling space (AFFECT_DIMS order), entries in [-1,1]. */
  sig: number[];
  /** One word for how she felt (a ticker vocabulary tag). Rendered only in the past tense. */
  word?: string | undefined;
  source: FeltSource;
}

export interface Outcome {
  /** -2..2 — how it landed, graded from what came next. */
  landed: number;
  /** A plain phrase ("he laughed and kept going"). Rendered as memory, never as advice. */
  why: string;
  at: number;
}

export interface Line {
  who: 'him' | 'her';
  text: string;
}

/**
 * v9: something she DID in a moment (a tool she used), beside what she said.
 * Her imported history kept only words ("on it", "sent") — the acts behind
 * them were lost, so her precedents taught her to narrate instead of act.
 * Lived moments keep both, and a detached job's outcome lands here later.
 */
export interface Act {
  tool: string;
  /** What with — the scene, the query, the brief (short). */
  what: string;
  /** How it went: the tool's answer, then (for detached work) how it landed. */
  result?: string | undefined;
  /** The detached job this act started, if any (its outcome updates `result`). */
  job?: string | undefined;
}

export interface Moment {
  id: string;
  /** Epoch ms of her reply (or of the diary line / thought). */
  ts: number;
  source: 'imported' | 'lived';
  kind: MomentKind;
  /** Up to three lines of context before his message, oldest first. */
  before: Line[];
  /** The message she answered ('' when she spoke first, or for diary/thought). */
  his: string;
  /** Her bubbles, verbatim, in order. */
  hers: string[];
  move?: string | undefined;
  tone?: string | undefined;
  mode?: 'play' | 'friend' | 'work' | undefined;
  felt: Felt;
  expect?: string | undefined;
  outcome?: Outcome | undefined;
  /** Learned value in [-1,1], updated by reward-prediction error. */
  value: number;
  importance?: number | undefined;
  /** Diego starred it (⭐): weighted up, never decays. */
  gold?: boolean | undefined;
  /** Diego rejected it (👎): never shown again. */
  never?: boolean | undefined;
  /** Mining flags (petname, broken, leak…): a flagged moment is never an option. */
  flags?: string[] | undefined;
  shown: number;
  lastShownTurn?: number | undefined;
  lastShownAt?: number | undefined;
  followed: number;
  lastFollowedAt?: number | undefined;
  /** Telegram message ids of her bubbles (lived) — reactions (⭐/👎) find the moment by these. */
  msgIds?: number[] | undefined;
  /** The shown option this reply followed (null = something new) — credited when the outcome lands. */
  followedFrom?: string | null | undefined;
  /** Options shown when this reply was made. */
  shownOptions?: string[] | undefined;
  /** v9: what she did (tools) in this moment, beside what she said. */
  acts?: Act[] | undefined;
}

export type ConcernKind = 'loop' | 'expectation' | 'care' | 'curiosity';
export type About = 'diego' | 'self' | 'world';

/** Something she cares about or is waiting on — the ground her appraisals stand on. */
export interface Concern {
  id: string;
  /** Her words. */
  what: string;
  kind: ConcernKind;
  about: About;
  /** Epoch ms an expectation comes due. */
  due?: number | undefined;
  importance: number;
  status: 'open' | 'closed';
  created: number;
  touched: number;
  source: 'imported' | 'lived';
  // ——— v12 agency (plan docs/plans/v12-curious-for-her-own-sake.md §1.3) ———
  /** One thing she could do about it herself, without anyone. */
  selfStep?: string | undefined;
  /** Who it truly depends on, when nothing is hers to do. */
  blockedOn?: string | undefined;
  /** When a stale belief behind this loop was last turned into "is this still true?". */
  checkedAt?: number | undefined;
  // ——— v12 questions (kind 'curiosity', §1.1) ———
  /** 0–1: could she find it out with her tools, her memory, or by asking. */
  knowability?: number | undefined;
  /** 0–1: how much she already knows (curiosity peaks in the middle). */
  confidence?: number | undefined;
  /** Running mean learning progress of her pursuits of it (0–2). */
  lp?: number | undefined;
  tries?: number | undefined;
  /** Which generator gave birth to it. */
  born?: QuestionSource | undefined;
  /** 0–1 at birth: distance from what she has already explored. */
  novel?: number | undefined;
  /** Her interest domain this belongs to (a topic). */
  domain?: string | undefined;
  /** The question or loop this one grew out of. */
  parent?: string | undefined;
  /** A question about a person or another mind — pursued by asking them. */
  who?: { person: string; name: string; chatId: number; said?: string | undefined } | undefined;
}

/** v12: where a question came from (§1.2). */
export type QuestionSource = 'gap' | 'followup' | 'mind' | 'browse' | 'stale';

/** v12: something she has come to be into — earned from learning progress, fading with neglect (§1.7). */
export interface Interest {
  id: string;
  topic: string;
  /** Accumulated learning progress (decays with a 14-day half-life from `touched`). */
  strength: number;
  /** Mean learning progress of her pursuits in it (0–2). */
  lp: number;
  created: number;
  touched: number;
  /** Thought ids of what she found out (her evidence of being into it). */
  cites: string[];
}

/** One private thought — her inner stream. Never sent; may surface in [on my mind]. */
export interface Thought {
  id: string;
  ts: number;
  text: string;
  about: About;
  itemKey?: string | undefined;
  source: 'imported' | 'lived';
}

/** One line of her self-narrative with the moments it stands on (uncited lines are dropped). */
export interface SelfLine {
  text: string;
  cites: string[];
}

export interface WanderState {
  /** His-zone day the counters belong to (YYYY-MM-DD). */
  day: string;
  thoughts: number;
  textsFirst: number;
  lastTextFirstAt?: number | undefined;
  /** Texts she started since he last wrote (golden rule 20: the wait doubles with each). */
  firstsSinceHis?: number | undefined;
  /** item key → epoch ms it last won attention (habituation decays from here). */
  habit: Record<string, number>;
  /** v12: things she looked into / people she asked today (daily budgets). */
  pursuits?: number | undefined;
  asks?: number | undefined;
}

/** v12: her running sense of how much she tends to learn (the foraging "environment average"). */
export interface CuriosityState {
  /** Running mean learning progress across her pursuits (0–2). */
  meanLp: number;
  n: number;
  /** Epoch ms something new last came her way (a question born, a finding). */
  lastNewAt?: number | undefined;
  /** Duplicate concerns have been merged once (the v12 boot pass). */
  merged?: boolean | undefined;
}

export interface MindState {
  turn: number;
  /** Her last private expectation and when she formed it. */
  lastExpect?: { text: string; at: number; momentId: string } | undefined;
  /** The moment her previous reply became (its outcome is graded by his next message). */
  lastMomentId?: string | undefined;
  /** What was shown on the last turn — the followed-option inference reads it. */
  lastShown?: { turn: number; at: number; ids: string[] } | undefined;
  wander: WanderState;
  /** v12 curiosity bookkeeping. */
  curiosity?: CuriosityState | undefined;
  lastSleepDay?: string | undefined;
  /** Epoch ms of her last sent message and his last message (for silence and gaps). */
  lastHerAt?: number | undefined;
  lastHisAt?: number | undefined;
}

/** One shown-options log row (append-only). */
export interface ShownRow {
  turn: number;
  at: number;
  turnId: string;
  options: Array<{ id: string; score: number; sim: number }>;
  memories: string[];
  followed?: string | null | undefined;
}
