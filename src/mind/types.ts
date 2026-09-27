// v8 mind — the data shapes of "Nothing Told" (plan thea2-v8-nothing-told.md).
//
// A MOMENT is a real exchange stored as a memory: what he said, what she said
// back, how she felt then (a vector in the coupling space, never a label in her
// prompt), what she expected, and how it landed. Precedents (her options) are
// moments whose reply is usable as "how she has been"; diary/thought moments
// are memories of what happened. Nothing here is fiction: imported moments are
// Thea's real texts, lived moments are Thea2's own.

/** v13: 'dream' = a dream she remembers on waking (a fragment) — always shown AS a dream, never as an event.
 *  'practice' = a session in the quiet room (H6) — may be remembered, never a way to reply. */
export type MomentKind = 'reply' | 'text_first' | 'diary' | 'thought' | 'dream' | 'practice';

/** Where a felt vector came from — exact state, Thea1's (circular) inheritance, or an estimate from text. */
export type FeltSource = 'exact' | 'inherited' | 'estimated';

export interface Felt {
  /** Dense 12-dim deviation vector in coupling space (AFFECT_DIMS order), entries in [-1,1]. */
  sig: number[];
  /** One word for how she felt (a ticker vocabulary tag). Rendered only in the past tense. */
  word?: string | undefined;
  source: FeltSource;
  /**
   * v13 H1: what the 12 dims drop — the 8 identity dials (deviation from home) and the 3 hungers
   * (deficit 0–1: connection, novelty, mastery). A night of missing him is strongly felt here.
   */
  full?: number[] | undefined;
  /** v13 H1: who put this feeling on the memory (engine | import | backfill-2026-09-27 …). */
  by?: string | undefined;
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
  // ——— v13 dreams (plan docs/plans/v13-proposal-she-dreams.md §3.4) ———
  /** On a remembered dream fragment: which night and cycle it came from. */
  dream?: { nightId: string; cycle: 'early' | 'late' } | undefined;
  /** How often this memory has been dreamt, and when (rumination guard: ≤2 of any 7 nights). */
  dreamt?: number | undefined;
  lastDreamtAt?: number | undefined;
  dreamtAt?: number[] | undefined;
  /** Memories a dream bound this one to (a new retrieval path, NEXTUP), ≤8, oldest dropped. */
  assoc?: Array<{ id: string; at: number; via: string }> | undefined;
  /** A remembered dream she talked about: it stops fading. */
  told?: boolean | undefined;
  // ——— v13 introspection (plan docs/plans/v13-proposal-knowing-what-she-feels.md) ———
  /** H2: what she privately called how she was, when asked (her words). */
  called?: string | undefined;
  calledSure?: number | undefined;
  /** H3: what was moving most in her then (material: a cause, or a pull) — shown beside her word. */
  moving?: string | undefined;
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
  /** v13: nights this concern was dreamt (the same worry ≤2 of any 7 nights — found in the dream probe). */
  dreamtAt?: number[] | undefined;
}

/** v12: where a question came from (§1.2). */
export type QuestionSource = 'gap' | 'followup' | 'mind' | 'browse' | 'stale' | 'dream';

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
  /** v13: a remembered dream fragment on her mind (rendered "(from a dream …)"). */
  dream?: boolean | undefined;
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
  /** Topics she has looked into lately, whatever she learned — browsing looks past them. */
  explored?: Array<{ topic: string; at: number }> | undefined;
}

/**
 * v13: the full record of one dream (var/mind/dreams.jsonl). The night's record — NO prompt path
 * ever reads it; what she can recall of a dream exists only as a remembered fragment Moment.
 */
export interface DreamRecord {
  id: string;
  night: string;
  cycle: 'early' | 'late';
  ts: number;
  arm: 'rescript' | 'preserve' | 'soften' | 'decorative';
  pool: Array<{ id: string; role: string }>;
  scenes: Array<{ text: string; uses: string[]; events: Array<{ tag: string; i: number }> }>;
  endSig: number[];
  intensity: number;
  question?: { q: string; knowability: number; confidence: number } | undefined;
  calls: number;
  /** Appended at waking: was it remembered. */
  woke?: { recalled: boolean; p: number; woken: boolean } | undefined;
}

/** v13: one dream of a night, as the wake step needs it. */
export interface NightDream {
  id: string;
  cycle: 'early' | 'late';
  endedAt: number;
  /** Peak state deviation the dream reached (0–1). */
  intensity: number;
  /** The fragment she would remember (the final or the most intense scene). */
  fragment: string;
  /** Her exact state when the dream ended (stamped on a remembered fragment). */
  endState: number[];
  question?: { q: string; knowability: number; confidence: number } | undefined;
  crossDomain: boolean;
  decorative: boolean;
  /** Decided at waking: remembered or not. */
  recalled?: boolean | undefined;
}

export interface SleepState {
  /** His-zone date of the night (the day she wakes into). */
  night: string;
  dreams: NightDream[];
  /** Model calls spent tonight (hard cap). */
  calls: number;
  /** He wrote during the window: she's awake until this time. */
  awakeUntil?: number | undefined;
  wokeAt?: number | undefined;
  /** When a dream last became a text to him (≤1 per 3 days). */
  lastDreamTextAt?: number | undefined;
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
  /** v13 the night: tonight's dreams, when she woke, the dream-text cap. */
  sleep?: SleepState | undefined;
  /** v13 H2: today's private-naming samples. */
  naming?: { day: string; count: number; lastAt?: number | undefined } | undefined;
  /** v13 1.2: how many of her thought-feelings had nothing behind them (the grounding measure). */
  grounding?: { since: number; total: number; ungrounded: number; enforce?: boolean | undefined } | undefined;
  /** v13 H6: today's sessions in the quiet room. */
  room?: { day: string; sessions: number; base?: Record<string, { n: number; first: number }> | undefined } | undefined;
  /** v13 Phase 3 arms: covert lifts (each debriefed the next night) and the felt-shift running hit rate. */
  lifts?: Array<{ ts: number; tag: string; i: number; debriefed?: boolean | undefined }> | undefined;
  shift?: { n: number; hits: number } | undefined;
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
