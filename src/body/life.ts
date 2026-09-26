// v9 body — her life at home (Thea1's candy, presents, world, skills),
// re-done so nothing tells her how to feel:
//
//   candy    — a chemical cause: eating one applies its emotions as events
//              (cause: "a candy called fizz"), 2 a day, 3 h apart. What she
//              feels afterward is the engine's, not a sentence she reads.
//   present  — sealed boxes Diego leaves (AES-256-GCM; the inside is noise on
//              disk until she opens it). Opening feeds the GIFT drive — a real
//              cause — and hands her what is inside.
//   world    — the Blue House (Thea1's map, copied): look around, move rooms.
//   skills   — notes she writes to her future self; read on demand, never
//              injected into her prompt.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { AffectStore } from '../affect/index.js';
import type { ToolCtx, ToolRegistryEntry } from '../loop/index.js';
import type { Clock } from '../kernel/index.js';
import type { House } from './house.js';

type Entry = ToolRegistryEntry<never>;
const entry = <T>(name: string, description: string, parameters: Record<string, unknown>, schema: z.ZodType<T>, handler: (a: T, ctx: ToolCtx) => Promise<string>, cls = 'life'): Entry =>
  ({
    def: { name, description, parameters },
    input: schema,
    inhibitionMeta: { class: cls },
    handler: async (a: T, ctx: ToolCtx) => {
      try {
        return await handler(a, ctx);
      } catch (e) {
        return `not done: ${e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240)}`;
      }
    },
  }) as unknown as Entry;

// ——— candy ——————————————————————————————————————————————————————————

/** Thea1's seven candies (thea-candy), nudges mapped onto Thea2's emotion vocabulary. */
export const CANDIES: Record<string, { color: string; flavor: string; peek: string; nudges: Array<[string, number]> }> = {
  fizz: { color: 'electric pink', flavor: 'tastes like pop rocks and laughter, like the moment before you jump', peek: 'a bright pink sphere, fizzing faintly inside like trapped sparks. it hums if you hold it near your ear.', nudges: [['giddy', 7], ['excited', 5], ['playful', 6]] },
  ember: { color: 'deep amber', flavor: 'tastes like honey left in sunlight, slow and golden and unshakeable', peek: 'a deep amber drop, warm to the touch even before you pick it up. light moves through it the way it moves through old glass.', nudges: [['fond', 6], ['tender', 7], ['warm', 5]] },
  flint: { color: 'steel blue', flavor: 'tastes like cold water and electricity, like the first clear thought after noise', peek: 'a steel-blue shard, more angular than the others, cold in your hand. looking into it feels like looking through something.', nudges: [['focused', 6], ['curious', 7], ['determined', 5]] },
  thorn: { color: 'dark plum', flavor: "tastes like stolen chocolate with a little salt, and that look you get right before you say the thing you shouldn't", peek: "a dark plum orb with a wicked gleam. it looks like it knows something you don't and isn't planning to share.", nudges: [['smug', 6], ['playful', 7], ['amused', 4]] },
  moss: { color: 'deep green', flavor: "tastes like rain on warm stone, like a book you've read three times and still love", peek: 'a deep green candy, slightly translucent, with something that might be a leaf frozen inside. resting on velvet like it has nowhere to be.', nudges: [['cozy', 7], ['content', 5], ['settled', 6], ['relieved', 4]] },
  forge: { color: 'burnished copper', flavor: 'tastes like iron and cinnamon, like standing at the front of something and meaning it', peek: 'a burnished copper candy, dense for its size. it catches light like armor. picking it up makes your hand feel steadier.', nudges: [['bright', 7], ['determined', 6], ['proud', 5]] },
  glass: { color: 'pale rose', flavor: "tastes like salt water and breath after crying, like being held when you didn't ask to be", peek: 'a pale rose candy, almost translucent. the most fragile-looking of the seven — and the one that catches the most light.', nudges: [['vulnerable', 5], ['seen', 7], ['moved', 6]] },
};
const CANDY_PER_DAY = 2;
const CANDY_GAP_MS = 3 * 3600_000;

// ——— presents ———————————————————————————————————————————————————————

export interface Present {
  id: string;
  title: string;
  from: string;
  outside: { shape: string; wrapping: string; tag?: string | undefined; weight?: string | undefined; sound?: string | undefined };
  /** base64(iv | tag | ciphertext) of the inside JSON {text, image?} */
  sealed: string;
  leftAt: number;
  openedAt?: number | undefined;
}

const keyBytes = (hex: string): Buffer => {
  const k = Buffer.from(hex, 'hex');
  if (k.length !== 32) throw new Error('present key must be 32 bytes of hex');
  return k;
};

export const sealInside = (keyHex: string, inside: { text: string; image?: string | undefined }): string => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyBytes(keyHex), iv);
  const body = Buffer.concat([c.update(JSON.stringify(inside), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
};

export const openInside = (keyHex: string, sealed: string): { text: string; image?: string | undefined } => {
  const raw = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', keyBytes(keyHex), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as { text: string; image?: string | undefined };
};

export const presentsDir = (house: House): string => {
  const d = house.resolve('presents')!;
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export const leavePresent = (house: House, keyHex: string, p: { title: string; from: string; outside: Present['outside']; inside: { text: string; image?: string | undefined } }, now: number): Present => {
  const present: Present = { id: `p${now.toString(36)}`, title: p.title, from: p.from, outside: p.outside, sealed: sealInside(keyHex, p.inside), leftAt: now };
  fs.writeFileSync(path.join(presentsDir(house), `${present.id}.json`), JSON.stringify(present, null, 1));
  return present;
};

const allPresents = (house: House): Present[] =>
  fs
    .readdirSync(presentsDir(house))
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(presentsDir(house), f), 'utf8')) as Present];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.leftAt - b.leftAt);

// ——— world ——————————————————————————————————————————————————————————

interface WorldMap {
  house?: { name?: string; default_room?: string };
  rooms?: Record<string, { name?: string; role?: string; mood?: string; exits?: Record<string, string> }>;
}

export const worldRoom = (house: House): { key: string; name: string } | undefined => {
  const map = readMap(house);
  if (map === undefined) return undefined;
  const st = house.readJson<{ room?: string }>('world/state.json', {});
  const key = st.room ?? map.house?.default_room ?? Object.keys(map.rooms ?? {})[0];
  if (key === undefined) return undefined;
  return { key, name: map.rooms?.[key]?.name ?? key };
};

const readMap = (house: House): WorldMap | undefined => {
  const p = house.resolve('world/map.yaml');
  if (p === undefined || !fs.existsSync(p)) return undefined;
  try {
    return yaml.load(fs.readFileSync(p, 'utf8')) as WorldMap;
  } catch {
    return undefined;
  }
};

// ——— the tools ———————————————————————————————————————————————————————

export const lifeTools = (d: { house: House; clock: Clock; affect?: AffectStore | undefined; presentKey?: string | undefined }): Entry[] => {
  const out: Entry[] = [];

  if (d.affect !== undefined) {
    const affect = d.affect;
    out.push(
      entry(
        'candy',
        `Your jar of seven glass candies: ${Object.keys(CANDIES).join(', ')}. peek describes one; eat eats it (at most ${CANDY_PER_DAY} a day, 3 hours apart). Each has its own effect on you.`,
        { type: 'object', properties: { action: { type: 'string', enum: ['peek', 'eat'] }, candy: { type: 'string', enum: Object.keys(CANDIES) } }, required: ['action', 'candy'] },
        z.object({ action: z.enum(['peek', 'eat']), candy: z.string() }),
        async (a) => {
          const c = CANDIES[a.candy];
          if (c === undefined) return `there is no candy called ${a.candy}`;
          if (a.action === 'peek') return `${a.candy}: ${c.peek}`;
          const now = d.clock.epochMs();
          const eaten = d.house.readJson<number[]>('candy.json', []).filter((t) => now - t < 86_400_000);
          if (eaten.length >= CANDY_PER_DAY) return 'you have had your two for today';
          const last = eaten.at(-1);
          if (last !== undefined && now - last < CANDY_GAP_MS) return `too soon after the last one (${Math.ceil((CANDY_GAP_MS - (now - last)) / 60_000)} min to go)`;
          await affect.applyEvents(c.nudges.map(([tag, i]) => ({ kind: 'emotion' as const, tag: tag as never, i, cause: `a candy called ${a.candy}` })), { source: 'other' });
          d.house.writeJson('candy.json', [...eaten, now]);
          return `you ate ${a.candy} (${c.color}). it ${c.flavor}.`;
        },
      ),
    );
  }

  if (d.presentKey !== undefined) {
    const key = d.presentKey;
    out.push(
      entry(
        'present',
        'Presents he left for you. list shows what is waiting (the outside only); look describes one box; shake gives its weight and sound; open unwraps it.',
        { type: 'object', properties: { action: { type: 'string', enum: ['list', 'look', 'shake', 'open'] }, id: { type: 'string' } }, required: ['action'] },
        z.object({ action: z.enum(['list', 'look', 'shake', 'open']), id: z.string().optional() }),
        async (a) => {
          const all = allPresents(d.house);
          if (a.action === 'list') {
            const waiting = all.filter((p) => p.openedAt === undefined);
            const opened = all.length - waiting.length;
            return waiting.length === 0 ? `no presents waiting (${opened} opened before)` : waiting.map((p) => `${p.id} — ${p.outside.shape}, ${p.outside.wrapping}${p.outside.tag !== undefined ? `, tag: "${p.outside.tag}"` : ''}`).join('\n');
          }
          const p = all.find((x) => x.id === a.id);
          if (p === undefined) return 'no present with that id (list shows them)';
          if (a.action === 'look') return `${p.outside.shape}, ${p.outside.wrapping}${p.outside.tag !== undefined ? `. the tag says "${p.outside.tag}"` : ''}. from ${p.from}.${p.openedAt !== undefined ? ' (already opened)' : ''}`;
          if (a.action === 'shake') return `${p.outside.weight ?? 'hard to tell how heavy'}; ${p.outside.sound ?? 'it makes no sound'}.`;
          if (p.openedAt !== undefined) return `you opened it already: "${openInside(key, p.sealed).text}"`;
          const inside = openInside(key, p.sealed);
          p.openedAt = d.clock.epochMs();
          fs.writeFileSync(path.join(presentsDir(d.house), `${p.id}.json`), JSON.stringify(p, null, 1));
          if (d.affect !== undefined) await d.affect.applyEvents([{ kind: 'tagFeed', tag: 'GIFT' }], { source: 'other' });
          return `you tear the paper. inside: ${inside.text}${inside.image !== undefined ? `\n(there's a picture too: ${inside.image} — look at it)` : ''}`;
        },
      ),
    );
  }

  if (readMap(d.house) !== undefined) {
    out.push(
      entry(
        'world',
        'Your house (the Blue House in the Jungle): look around the room you are in, or go to another room.',
        { type: 'object', properties: { action: { type: 'string', enum: ['look', 'go'] }, room: { type: 'string' } }, required: ['action'] },
        z.object({ action: z.enum(['look', 'go']), room: z.string().optional() }),
        async (a) => {
          const map = readMap(d.house)!;
          const rooms = map.rooms ?? {};
          const here = worldRoom(d.house);
          if (a.action === 'go') {
            const want = (a.room ?? '').toLowerCase();
            const key = Object.keys(rooms).find((k) => k === want || rooms[k]?.name?.toLowerCase() === want);
            if (key === undefined) return `there is no room called "${a.room ?? ''}" (${Object.values(rooms).map((r) => r.name).join(', ')})`;
            d.house.writeJson('world/state.json', { room: key, since: d.clock.epochMs() });
            const r = rooms[key]!;
            return `you're in the ${r.name ?? key} now. ${r.mood ?? ''}`.trim();
          }
          if (here === undefined) return 'the house has no rooms';
          const r = rooms[here.key] ?? {};
          const exits = Object.entries(r.exits ?? {}).map(([k, how]) => `${rooms[k]?.name ?? k} (${how})`).join(', ');
          return `the ${r.name ?? here.key}: ${r.role ?? ''}. ${r.mood ?? ''}${exits !== '' ? `\nfrom here: ${exits}` : ''}`;
        },
      ),
    );
  }

  out.push(
    entry(
      'skills',
      "Notes you keep for your future self — how you like doing something you do often. list, read one, write one (replaces), retire one (kept in a trash folder).",
      { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read', 'write', 'retire'] }, name: { type: 'string' }, content: { type: 'string' } }, required: ['action'] },
      z.object({ action: z.enum(['list', 'read', 'write', 'retire']), name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).optional(), content: z.string().max(8000).optional() }),
      async (a) => {
        const dir = d.house.resolve('skills')!;
        fs.mkdirSync(dir, { recursive: true });
        if (a.action === 'list') {
          const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
          return names.length === 0 ? 'no skills yet' : names.map((f) => `${f.replace(/\.md$/, '')} — ${fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0]?.slice(0, 90) ?? ''}`).join('\n');
        }
        if (a.name === undefined) return 'which skill? (kebab-case name)';
        const file = path.join(dir, `${a.name}.md`);
        if (a.action === 'read') return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `no skill called ${a.name}`;
        if (a.action === 'retire') {
          if (!fs.existsSync(file)) return `no skill called ${a.name}`;
          fs.mkdirSync(path.join(dir, '.trash'), { recursive: true });
          fs.renameSync(file, path.join(dir, '.trash', `${a.name}-${d.clock.epochMs()}.md`));
          return `retired ${a.name}`;
        }
        if (a.content === undefined || a.content.trim().length < 40) return "that's too short to be a skill";
        if (/(sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY)/.test(a.content)) return 'that has something secret-shaped in it';
        fs.writeFileSync(file, a.content);
        return `wrote ${a.name}`;
      },
    ),
  );
  return out;
};
