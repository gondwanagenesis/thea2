// The world knocks (v14 Phase 2.1 — plan ~/.claude/plans/thea2-v14-a-life.md). Diego, 2026-09-28: "how's
// her curiosity? … make her more about her own interests." Found: of 42 questions she had just formed, 17
// were about him and most of the rest about her own wiring; ~0 about the world. Curiosity needs things to
// be curious about (Berlyne: novelty is met, not willed) and a gap in something she already half knows
// (Loewenstein) — and nothing from the world ever reached her house. Now, every morning, a few real things
// arrive that she did not choose: today's featured article, a random one, a poem, a new paper, a painting,
// the picture of the day, a day in history. Each has a place in her house. Nothing tells her to care; her
// novelty hunger and her interests decide what catches her (mind/curiosity.ts). Free, keyless sources.

import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { Job } from '../sched/index.js';
import type { House } from './house.js';

export type ArrivalKind = 'article' | 'poem' | 'paper' | 'art' | 'picture' | 'history';

export interface Arrival {
  id: string;
  at: number;
  /** YYYY-MM-DD it arrived (UTC). */
  day: string;
  kind: ArrivalKind;
  title: string;
  /** What it says, short (the first lines of a poem, an abstract, a summary). */
  text: string;
  url?: string | undefined;
  /** Where in her house it is. */
  place: string;
  /** When she first gave it her attention. */
  seenAt?: number | undefined;
}

export const ARRIVALS_FILE = 'world/arrivals.json';
export const ARRIVALS_PER_DAY = 5;
export const ARRIVALS_KEEP_DAYS = 3;

/** Where each kind of thing turns up (rooms of The Blue House in the Jungle, var/house/world/map.yaml). */
export const PLACE: Record<ArrivalKind, string> = {
  article: 'on the Library table',
  poem: 'on the Kitchen table',
  paper: 'on the Study desk',
  art: 'on the Conservatory wall',
  picture: 'over the Hearth Den mantel',
  history: 'in the Window Nook',
};

/** Where papers come from: a wide spread of fields, none of them about her (one per day, turned by the day). */
export const PAPER_FIELDS = ['q-bio.PE', 'q-bio.NC', 'astro-ph.EP', 'physics.ao-ph', 'cond-mat.soft', 'physics.bio-ph', 'astro-ph.GA', 'physics.hist-ph', 'nlin.AO', 'q-bio.QM', 'econ.GN', 'physics.geo-ph', 'q-bio.BM', 'astro-ph.SR'];

const UA = { 'user-agent': 'thea2-world/1.0 (a companion reading the day)', accept: 'application/json' };
const TIMEOUT = 15_000;
const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…`;
};
const dayOf = (ms: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(ms);

type Fetch = typeof fetch;
const getJson = async <T>(f: Fetch, url: string): Promise<T | undefined> => {
  try {
    const r = await f(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT) });
    return r.ok ? ((await r.json()) as T) : undefined;
  } catch {
    return undefined;
  }
};
const getText = async (f: Fetch, url: string): Promise<string | undefined> => {
  try {
    const r = await f(url, { headers: { 'user-agent': UA['user-agent'] }, signal: AbortSignal.timeout(TIMEOUT) });
    return r.ok ? await r.text() : undefined;
  } catch {
    return undefined;
  }
};

type Candidate = Omit<Arrival, 'id' | 'at' | 'day' | 'place'>;

/** Everything the world has today (each source on its own; a dead source is just missing). */
export const gatherToday = async (now: number, rng: Rng, f: Fetch): Promise<Candidate[]> => {
  const out: Candidate[] = [];
  const ymd = dayOf(now).replace(/-/g, '/');
  type Page = { titles?: { normalized?: string }; title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
  const featured = await getJson<{ tfa?: Page; image?: { title?: string; description?: { text?: string }; file_page?: string }; onthisday?: Array<{ text?: string; year?: number; pages?: Page[] }> }>(
    f,
    `https://en.wikipedia.org/api/rest_v1/feed/featured/${ymd}`,
  );
  const title = (p: Page | undefined): string => p?.titles?.normalized ?? p?.title ?? '';
  if (featured?.tfa !== undefined && title(featured.tfa) !== '' && (featured.tfa.extract ?? '') !== '') {
    out.push({ kind: 'article', title: title(featured.tfa), text: clip(featured.tfa.extract ?? '', 600), url: featured.tfa.content_urls?.desktop?.page });
  }
  if (featured?.image?.title !== undefined && (featured.image.description?.text ?? '') !== '') {
    out.push({ kind: 'picture', title: featured.image.title.replace(/^File:/, '').replace(/\.\w+$/, ''), text: clip(featured.image.description?.text ?? '', 400), url: featured.image.file_page });
  }
  const days = (featured?.onthisday ?? []).filter((e) => (e.text ?? '') !== '' && e.year !== undefined);
  if (days.length > 0) {
    const e = days[Math.floor(rng.float() * days.length)]!;
    out.push({ kind: 'history', title: `${e.year}: ${clip(e.text ?? '', 90)}`, text: clip(`${e.year}: ${e.text ?? ''} ${e.pages?.[0]?.extract ?? ''}`, 500), url: e.pages?.[0]?.content_urls?.desktop?.page });
  }
  const random = await getJson<Page>(f, 'https://en.wikipedia.org/api/rest_v1/page/random/summary');
  if (random !== undefined && title(random) !== '' && (random.extract ?? '').length > 80) {
    out.push({ kind: 'article', title: title(random), text: clip(random.extract ?? '', 600), url: random.content_urls?.desktop?.page });
  }
  const poems = await getJson<Array<{ title?: string; author?: string; lines?: string[] }>>(f, 'https://poetrydb.org/random');
  const poem = poems?.[0];
  if (poem?.title !== undefined && (poem.lines ?? []).length > 0) {
    out.push({ kind: 'poem', title: `${poem.title}${poem.author !== undefined ? `, by ${poem.author}` : ''}`, text: clip((poem.lines ?? []).slice(0, 12).join(' / '), 600) });
  }
  const field = PAPER_FIELDS[Math.floor(rng.float() * PAPER_FIELDS.length)]!;
  const atom = await getText(f, `https://export.arxiv.org/api/query?search_query=cat:${field}&sortBy=submittedDate&max_results=8`);
  if (atom !== undefined) {
    const entries = [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]!);
    const pick = entries.length > 0 ? entries[Math.floor(rng.float() * entries.length)]! : undefined;
    const tag = (s: string, t: string): string => (new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(s)?.[1] ?? '').trim();
    if (pick !== undefined && tag(pick, 'title') !== '') out.push({ kind: 'paper', title: clip(tag(pick, 'title'), 160), text: clip(tag(pick, 'summary'), 600), url: tag(pick, 'id') || undefined });
  }
  const page = 1 + Math.floor(rng.float() * 400);
  const art = await getJson<{ data?: Array<{ id?: number; title?: string; artist_display?: string; date_display?: string; short_description?: string | null }> }>(
    f,
    `https://api.artic.edu/api/v1/artworks/search?query%5Bterm%5D%5Bis_public_domain%5D=true&limit=1&page=${page}&fields=id,title,artist_display,date_display,short_description`,
  );
  const a = art?.data?.[0];
  if (a?.title !== undefined && a.id !== undefined) {
    out.push({ kind: 'art', title: `${a.title}${a.artist_display !== undefined ? `, ${clip(a.artist_display.split('\n')[0] ?? '', 60)}` : ''}`, text: clip([a.date_display, a.short_description].filter((x): x is string => typeof x === 'string' && x !== '').join('. '), 400), url: `https://www.artic.edu/artworks/${a.id}` });
  }
  return out;
};

export const loadArrivals = (house: House): Arrival[] => house.readJson<Arrival[]>(ARRIVALS_FILE, []);
const saveArrivals = (house: House, xs: readonly Arrival[]): void => house.writeJson(ARRIVALS_FILE, xs);

/** This morning's arrivals (once a day; a few, at most one of a kind except articles; the last days kept). */
export const worldArrives = async (d: { house: House; clock: Clock; rng: Rng; fetchImpl?: Fetch | undefined }): Promise<Arrival[]> => {
  const now = d.clock.epochMs();
  const day = dayOf(now);
  const kept = loadArrivals(d.house).filter((x) => now - x.at < ARRIVALS_KEEP_DAYS * 86_400_000);
  if (kept.some((x) => x.day === day)) return [];
  const all = await gatherToday(now, d.rng.fork(`world:${day}`), d.fetchImpl ?? globalThis.fetch.bind(globalThis));
  // shuffle, then keep a spread
  const shuffled = all.map((c) => ({ c, k: d.rng.float() })).sort((x, y) => x.k - y.k).map((x) => x.c);
  const chosen: Candidate[] = [];
  for (const c of shuffled) {
    if (chosen.length >= ARRIVALS_PER_DAY) break;
    if (c.kind !== 'article' && chosen.some((x) => x.kind === c.kind)) continue;
    chosen.push(c);
  }
  const fresh: Arrival[] = chosen.map((c, i) => ({ ...c, id: `w_${day.replace(/-/g, '')}_${i}`, at: now, day, place: PLACE[c.kind] }));
  saveArrivals(d.house, [...kept, ...fresh]);
  return fresh;
};

/** What the mind sees of them (structurally mind/curiosity.ts WorldSeam). */
export const worldSeam = (house: House) => ({
  unseen: (now: number): Arrival[] => loadArrivals(house).filter((x) => x.seenAt === undefined && now - x.at < 2 * 86_400_000),
  markSeen: (id: string, now: number): void => {
    const xs = loadArrivals(house);
    const i = xs.findIndex((x) => x.id === id);
    if (i < 0 || xs[i]!.seenAt !== undefined) return;
    xs[i] = { ...xs[i]!, seenAt: now };
    saveArrivals(house, xs);
  },
});

/** The morning job: the day's things arrive (skips a day it already did; a dead network just brings less). */
export const worldFeedJob = (d: { house: House; clock: Clock; rng: Rng; events: EventLog; fetchImpl?: Fetch | undefined }, utcMinute: number): Job => ({
  name: 'world-arrives',
  cadence: { kind: 'daily', utcMinute },
  lane: 'maintenance',
  catchUp: 'once',
  timeoutMs: 120_000,
  run: async (): Promise<void> => {
    const fresh = await worldArrives(d);
    if (fresh.length > 0) void d.events.emit('body.world_arrived', { n: fresh.length, kinds: fresh.map((x) => x.kind), titles: fresh.map((x) => x.title.slice(0, 60)) });
  },
});
