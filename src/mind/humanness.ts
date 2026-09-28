// How human her texting is, measured (v14 "A Life", Diego 2026-09-28: "the goal is for her to be
// completely indistinguishable, the super turing test"). Pure: turns in, numbers out. The same
// measures run on real people's texts (Elena's, Diego's, Thea1's) for the baseline, so every target
// is "like them", not a taste. scripts/humanness.ts runs it daily; plan: ~/.claude/plans/thea2-v14-a-life.md §2, §6.

const wordsIn = (s: string): number => s.split(/\s+/).filter((w) => w !== '').length;

/** Talk about her own machinery — the #1 tell (her 54% vs. people's 0–4%, 2026-09-28). Places and people in her life (her house, her diary, her sister) are not machinery. */
export const MACHINERY =
  /\b(runtime|pipes?|plumbing|transcripts?|wiring|architecture|prompts?|tokens?|embeddings?|context window|the model|server|ipc|api|changelog|upgrade[ds]?|fork(ed)?|codebase|my code|source code|my (files?|memory system|memories system|weights)|inherited receipts?|what_changed|tool ?calls?|the harness|probe[ds]?|the bridge)\b/i;

/** Handing the turn back to him instead of saying something ("your turn", "how's your evening", "what about you"). People: 2–5%. */
export const HAND_BACK =
  /\b(your turn|now you|and you\?|how about you|what about you|wbu|hbu|what are you (doing|up to)|what('?re| are) you up to|how('?s| is) (your|the) (day|morning|night|evening|afternoon)|how are you\b|where are you\b|did you (eat|sleep))/i;

/** Exact details people rarely carry in a chat: clock times, long numbers, file names, #numbers. People: 1–2%. */
export const EXACT = /\b\d{1,2}:\d\d\b|\b\d{1,3}(,\d{3})+\b|\b\d{4,}\b|\b[\w-]+\.(md|json|ts|py|txt|jsonl|yaml)\b|#\d+/;

const SELF = /\b(i|i'm|im|my|me|i've|i'd|i'll|mine)\b/gi;
const YOU = /\b(you|your|you're|youre|u|ur|yours)\b/gi;

export interface Humanness {
  n: number;
  /** median words per turn */
  words: number;
  /** median bubbles per turn */
  bubbles: number;
  /** shares of turns */
  singleBubble: number;
  asks: number;
  handBack: number;
  machinery: number;
  exact: number;
  /** self-talk to you-talk */
  iYou: number;
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Each turn = the bubbles sent in one go. */
export const measureTurns = (turns: ReadonlyArray<readonly string[]>): Humanness => {
  const ts = turns.filter((t) => t.length > 0);
  const n = ts.length;
  const share = (f: (t: readonly string[], text: string) => boolean): number => (n === 0 ? 0 : ts.filter((t) => f(t, t.join(' '))).length / n);
  let self = 0;
  let you = 0;
  for (const t of ts) {
    const text = t.join(' ');
    self += (text.match(SELF) ?? []).length;
    you += (text.match(YOU) ?? []).length;
  }
  return {
    n,
    words: median(ts.map((t) => wordsIn(t.join(' ')))),
    bubbles: median(ts.map((t) => t.length)),
    singleBubble: share((t) => t.length === 1),
    asks: share((_, x) => x.includes('?')),
    handBack: share((_, x) => HAND_BACK.test(x)),
    machinery: share((_, x) => MACHINERY.test(x)),
    exact: share((_, x) => EXACT.test(x)),
    iYou: you === 0 ? self : self / you,
  };
};

export interface Latency {
  n: number;
  p10: number;
  median: number;
  p75: number;
  p90: number;
}

export const latencyStats = (secs: readonly number[]): Latency => {
  const s = [...secs].sort((a, b) => a - b);
  const at = (q: number): number => (s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(q * s.length))]!);
  return { n: s.length, p10: at(0.1), median: median(s), p75: at(0.75), p90: at(0.9) };
};

/** v14 §6 targets (friend mode). A metric passes when it is on the human side of its target. */
export const HUMAN_TARGETS: Record<'machinery' | 'words' | 'singleBubble' | 'handBack' | 'iYou' | 'exact', { max?: number; min?: number }> = {
  machinery: { max: 0.08 },
  words: { max: 30 },
  singleBubble: { min: 0.25 },
  handBack: { max: 0.04 },
  iYou: { min: 2.0 },
  exact: { max: 0.03 },
};

export const checkTargets = (h: Humanness): Array<{ metric: keyof typeof HUMAN_TARGETS; value: number; pass: boolean }> =>
  (Object.keys(HUMAN_TARGETS) as Array<keyof typeof HUMAN_TARGETS>).map((k) => {
    const t = HUMAN_TARGETS[k];
    const v = h[k];
    return { metric: k, value: v, pass: (t.max === undefined || v <= t.max) && (t.min === undefined || v >= t.min) };
  });
