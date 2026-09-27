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
/** The most she keeps about one person (the oldest go first). */
export const PERSON_FACTS_MAX = 40;
/** How many she has in mind when they talk. */
export const PERSON_FACTS_SHOWN = 8;

export interface Fact {
  text: string;
  at: number;
  momentId?: string | undefined;
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
  learn(id: string, facts: readonly string[], now: number, momentId?: string): number;
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
    learn(id, facts, now, momentId) {
      const p = people[id];
      if (p === undefined) return 0;
      let added = 0;
      for (const raw of facts) {
        const text = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (text === '') continue;
        const same = p.known.findIndex((f) => overlap(f.text, text) >= 0.7);
        const fact: Fact = { text, at: now, ...(momentId !== undefined ? { momentId } : {}) };
        if (same >= 0) p.known.splice(same, 1);
        else added += 1;
        p.known.push(fact);
      }
      if (p.known.length > PERSON_FACTS_MAX) p.known = p.known.slice(-PERSON_FACTS_MAX);
      dirty = true;
      return added;
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
