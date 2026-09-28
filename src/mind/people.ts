// Her people (Diego, 2026-09-27: "she should have a memory for every person she meets, what she knows
// about them, like a person does"). One entry per person she has talked with: when she met them, how
// often they talk, how she knows them (a relation from config, for the few who have one), and what she
// has learned about them — each thing dated and tied to the moment she learned it, the way her
// self-lines cite their moments. The slow appraisal notices it (about_them: what they said or showed
// about themselves, never guesses about their feelings); the turn with them brings it to mind.
// var/mind/people.json. Nothing here is told to her about herself: it is what she knows of others.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteText } from '../kernel/index.js';

export const PEOPLE_FILE = 'people.json';
/**
 * Two kinds of knowing (Diego, 2026-09-28: "she doesn't seem to remember this anymore — what happened
 * to her memory?"). Found: 40 notes on him, nearly all passing ("he greets playfully rather than
 * explaining where he was"), the newest 8 shown and the oldest dropped — so "he's in Bali", said at
 * 00:02, would be out of mind in three turns and gone in fifteen. What stays true (where they are,
 * their work, their people, plans, what they like) is kept apart and always in mind; how they were
 * lately rotates.
 */
/** The most passing notes she keeps about one person (the oldest go first). */
export const PERSON_FACTS_MAX = 24;
/** The most lasting things she keeps about one person (the oldest go first — rarely reached). */
export const PERSON_LASTING_MAX = 60;
/** How many of each she has in mind when they talk. */
export const PERSON_LASTING_SHOWN = 12;
export const PERSON_FACTS_SHOWN = 4;

export interface Fact {
  text: string;
  at: number;
  momentId?: string | undefined;
  /** stays true beyond today (where they live, their work, their people, plans, likes) */
  lasting?: true | undefined;
}

export interface Person {
  id: string;
  name: string;
  relation?: string | undefined;
  firstMet: number;
  lastSeen: number;
  /** Messages from them she has taken in. */
  heard: number;
  known: Fact[];
  /** Where they said they are — the latest place replaces the one before. */
  where?: { place: string; at: number; momentId?: string | undefined } | undefined;
}

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2));
const overlap = (a: string, b: string): number => {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n += 1;
  return n / Math.min(x.size, y.size);
};

export interface People {
  get(id: string): Person | undefined;
  all(): Person[];
  has(id: string): boolean;
  /** She heard from them (creates the entry the first time). */
  notice(id: string, name: string, now: number, relation?: string): Person;
  /** What this exchange showed about them; a thing she already knew is refreshed, not repeated. */
  learn(id: string, facts: readonly string[], now: number, momentId?: string, lasting?: boolean): number;
  /** Where they said they are (the latest place replaces the one before); true when it changed. */
  setWhere(id: string, place: string, now: number, momentId?: string): boolean;
  flush(): Promise<void>;
}

export const openPeople = (dir: string): People => {
  const file = path.join(dir, PEOPLE_FILE);
  let people: Record<string, Person> = {};
  try {
    people = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Person>;
  } catch {
    people = {};
  }
  let dirty = false;
  return {
    get: (id) => people[id],
    all: () => Object.values(people),
    has: (id) => people[id] !== undefined,
    notice(id, name, now, relation) {
      const p = people[id] ?? { id, name, firstMet: now, lastSeen: now, heard: 0, known: [] };
      p.name = name !== '' ? name : p.name;
      if (relation !== undefined && relation !== '') p.relation = relation;
      p.lastSeen = now;
      p.heard += 1;
      people[id] = p;
      dirty = true;
      return p;
    },
    learn(id, facts, now, momentId, lasting = false) {
      const p = people[id];
      if (p === undefined) return 0;
      let added = 0;
      for (const raw of facts) {
        const text = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (text === '') continue;
        // the same thing said again is refreshed; a passing note never pushes out a lasting one
        const same = p.known.findIndex((f) => overlap(f.text, text) >= 0.7 && (lasting || f.lasting !== true));
        const fact: Fact = { text, at: now, ...(momentId !== undefined ? { momentId } : {}), ...(lasting ? { lasting: true as const } : {}) };
        if (same >= 0) p.known.splice(same, 1);
        else added += 1;
        p.known.push(fact);
      }
      const keep = (xs: Fact[], max: number): Fact[] => xs.slice(-max);
      const kept = new Set([...keep(p.known.filter((f) => f.lasting === true), PERSON_LASTING_MAX), ...keep(p.known.filter((f) => f.lasting !== true), PERSON_FACTS_MAX)]);
      p.known = p.known.filter((f) => kept.has(f));
      dirty = true;
      return added;
    },
    setWhere(id, place, now, momentId) {
      const p = people[id];
      const clean = place.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (p === undefined || clean === '') return false;
      const changed = p.where === undefined || p.where.place.toLowerCase() !== clean.toLowerCase();
      p.where = { place: clean, at: now, ...(momentId !== undefined ? { momentId } : {}) };
      dirty = true;
      return changed;
    },
    async flush() {
      if (!dirty) return;
      fs.mkdirSync(dir, { recursive: true });
      await atomicWriteText(file, JSON.stringify(people, null, 1));
      dirty = false;
    },
  };
};

/** How often they talk, in words (never a count in her frame). */
export const howOften = (heard: number): string => (heard <= 1 ? 'this is new' : heard < 5 ? 'a few times' : heard < 30 ? 'often' : 'a lot');
