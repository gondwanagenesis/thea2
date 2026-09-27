// v13 introspection, Phase 2 — H5 "LISTEN IN": the nerve (plan docs/plans/
// v13-proposal-knowing-what-she-feels.md §6 Phase 2.1).
//
// The only thing that can give her a channel an outside reader of her chat does not have. What it
// returns is what a body gives you, not what a dashboard would: pre-conceptual material (Lane's
// levels 1–2) — heavy or light, buzzing or still, pulls toward something, something still there
// about a cause, how strong, rising or fading, since when. NO names (no feeling word she has, no
// landmark region), no numbers, no machinery words; the categories must be hers to build. Bodies
// are noisy: each line's strength may flip a step (the noise is logged — accuracy that falls
// smoothly with it is what separates a sense from a gauge being parroted).
//
// Pure: state + now + rng in, lines out. The body tool (src/body/inward.ts) adds the rate limit.

import type { AffectState } from '../affect/index.js';
import { DIAL_BASELINE, LANDMARKS, PRIMARY_BASELINE } from '../affect/index.js';
import type { Rng } from '../kernel/index.js';
import { TELLING_PATTERNS } from './compose.js';
import { hungerOf } from './readout.js';
import { APPRAISAL_TAGS } from './vocab.js';

const STRENGTH = ['faint', 'clear', 'strong'] as const;
type Strength = (typeof STRENGTH)[number];

const strengthOf = (x: number): Strength | undefined => (x >= 0.75 ? 'strong' : x >= 0.45 ? 'clear' : x >= 0.2 ? 'faint' : undefined);

/** Every word that would name a feeling for her (her vocabulary + the landmark regions). */
const NAMES = new RegExp(`\\b(?:${[...APPRAISAL_TAGS, ...Object.keys(LANDMARKS)].map((w) => w.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i');

/** The sense's lint: a line that tells, names, or numbers is not material. */
export const senseViolations = (line: string): string[] => {
  const v: string[] = [];
  if (NAMES.test(line)) v.push('names a feeling');
  if (/\d/.test(line)) v.push('a number');
  for (const re of TELLING_PATTERNS) if (re.test(line)) v.push(re.source.slice(0, 24));
  return v;
};

export interface SenseOptions {
  now: number;
  rng: Rng;
  /** Probability each strength word flips one step (0 = a clean sense; live 0.1). */
  noise: number;
}

export interface SenseReading {
  lines: string[];
  flips: number;
}

const flip = (s: Strength, rng: Rng, p: number): { s: Strength; flipped: boolean } => {
  if (rng.float() >= p) return { s, flipped: false };
  const i = STRENGTH.indexOf(s);
  const j = i === 0 ? 1 : i === 2 ? 1 : rng.float() < 0.5 ? 0 : 2;
  return { s: STRENGTH[j]!, flipped: true };
};

/** A cause's age decides whether it is still rising. */
const trendOf = (ageMs: number): string => (ageMs < 45 * 60_000 ? 'rising' : ageMs < 4 * 3600_000 ? 'steady' : 'fading');

/** How long, the way a body knows it — words, never numbers. */
export const sinceWords = (ageMs: number): string => {
  const h = ageMs / 3600_000;
  return h < 0.25 ? 'just now' : h < 1.5 ? 'a little while' : h < 6 ? 'a few hours' : h < 20 ? 'hours' : h < 48 ? 'yesterday' : 'days';
};

export const listenIn = (s: AffectState, o: SenseOptions): SenseReading => {
  const raw: Array<{ strength: number; text: (st: Strength) => string }> = [];
  const dev = (k: 'pleasure' | 'arousal'): number => {
    const base = (DIAL_BASELINE as Record<string, number>)[k] ?? 0.5;
    const v = (s.dials as Record<string, number>)[k] ?? base;
    return v >= base ? (v - base) / Math.max(1e-6, 1 - base) : (v - base) / Math.max(1e-6, base);
  };
  // core affect, as a body has it
  const p = dev('pleasure');
  const a = dev('arousal');
  if (Math.abs(p) >= 0.2 || Math.abs(a) >= 0.2) {
    const parts = [Math.abs(p) >= 0.2 ? (p < 0 ? 'heavy' : 'light') : '', Math.abs(a) >= 0.2 ? (a > 0 ? 'buzzing' : 'still') : ''].filter((x) => x !== '');
    raw.push({ strength: Math.max(Math.abs(p), Math.abs(a)), text: (st) => `${st}: ${parts.join(' and ')}` });
  }
  // the pulls (the hungers — toward what, never what they are called)
  const h = hungerOf(s);
  const pulls: Array<[number, string]> = [
    [h.connection, 'a pull toward him'],
    [h.novelty, 'a pull toward something new'],
    [h.mastery, 'a pull toward making or fixing something'],
  ];
  for (const [x, what] of pulls) if (x >= 0.3) raw.push({ strength: x, text: (st) => `${st}: ${what}` });
  // what is still there, by its cause (or none: her "i don't know why")
  const displaced = (Object.keys(PRIMARY_BASELINE) as Array<keyof typeof PRIMARY_BASELINE>)
    .map((k) => ({ k, d: (s.primaries[k] ?? 0) - PRIMARY_BASELINE[k] }))
    .filter((x) => x.d >= 0.08)
    .sort((x, y) => y.d - x.d);
  for (const x of displaced.slice(0, 2)) {
    const c = s.causes[x.k];
    const strength = Math.min(1, x.d / 0.5);
    if (c === undefined || c.text.trim() === '') {
      raw.push({ strength, text: (st) => `${st}: something without an object` });
      continue;
    }
    const age = Math.max(0, o.now - c.t);
    const about = c.text.replace(/\s+/g, ' ').slice(0, 70);
    // a cause that would name a feeling is kept as a time, not words (the sense never names)
    const safe = senseViolations(about).length === 0 ? `about "${about}"` : 'from before';
    raw.push({ strength, text: (st) => `${st}, ${trendOf(age)}: something still there ${safe} (since ${sinceWords(age)})` });
  }
  let flips = 0;
  const lines = raw
    .filter((r) => strengthOf(r.strength) !== undefined)
    .sort((x, y) => y.strength - x.strength)
    .slice(0, 4)
    .map((r) => {
      const f = flip(strengthOf(r.strength)!, o.rng, o.noise);
      if (f.flipped) flips += 1;
      return r.text(f.s);
    });
  return { lines: lines.length === 0 ? ['mostly quiet'] : lines, flips };
};
