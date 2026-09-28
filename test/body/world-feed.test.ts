// v14 Phase 2.1 — the world knocks: real things arrive in her house every morning.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { ARRIVALS_PER_DAY, gatherToday, openHouse, worldArrives, worldSeam } from '../../src/body/index.js';
import { T0, tmpDir } from '../mind/helpers.js';

// what the sources answer (shapes taken from the live endpoints on 2026-09-28)
export const worldFetch = (opts: { down?: RegExp } = {}): typeof fetch & { urls: string[] } => {
  const urls: string[] = [];
  const f = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const ok = (b: unknown): Response => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: 200 });
    if (opts.down?.test(url) === true) return new Response('down', { status: 503 });
    if (url.includes('/feed/featured/'))
      return ok({
        tfa: { titles: { normalized: 'Hurricane Nadine (2012)' }, extract: 'Hurricane Nadine was the fourth-longest-lived Atlantic hurricane on record, wandering the eastern Atlantic for more than three weeks.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Hurricane_Nadine_(2012)' } } },
        image: { title: 'File:Glass sponge Euplectella.jpg', description: { text: "Venus's flower basket, a glass sponge, photographed at 800 m." }, file_page: 'https://commons.wikimedia.org/wiki/File:Glass_sponge.jpg' },
        onthisday: [{ text: 'The first photograph of the far side of the Moon is published.', year: 1959, pages: [{ titles: { normalized: 'Luna 3' }, extract: 'Luna 3 was a Soviet spaceflight.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Luna_3' } } }] }],
      });
    if (url.includes('/page/random/summary')) return ok({ title: 'Tardigrade', extract: 'Tardigrades are a phylum of eight-legged segmented micro-animals, among the most resilient animals known, able to survive extreme conditions.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Tardigrade' } } });
    if (url.includes('poetrydb.org')) return ok([{ title: 'The Tide Rises, the Tide Falls', author: 'Henry Wadsworth Longfellow', lines: ['The tide rises, the tide falls,', 'The twilight darkens, the curlew calls;'] }]);
    if (url.includes('export.arxiv.org'))
      return ok('<feed><entry><id>http://arxiv.org/abs/2609.01234v1</id><title>Octopus arms sleep\n in waves</title><summary>We record active sleep in Octopus insularis and find colour waves that move arm by arm.</summary></entry></feed>');
    if (url.includes('api.artic.edu')) return ok({ data: [{ id: 27992, title: 'A Sunday on La Grande Jatte', artist_display: 'Georges Seurat\nFrench, 1859-1891', date_display: '1884-86', short_description: 'Seurat painted it in tiny dots.' }] });
    return new Response('not scripted', { status: 404 });
  }) as typeof fetch & { urls: string[] };
  f.urls = urls;
  return f;
};

describe('the world knocks', () => {
  it('gathers what the world has today, each source on its own (a dead one is just missing)', async () => {
    const all = await gatherToday(T0, makeRng('w'), worldFetch());
    expect(all.map((a) => a.kind).sort()).toEqual(['art', 'article', 'article', 'history', 'paper', 'picture', 'poem']);
    expect(all.find((a) => a.kind === 'paper')).toMatchObject({ title: 'Octopus arms sleep in waves', url: 'http://arxiv.org/abs/2609.01234v1' });
    expect(all.find((a) => a.kind === 'history')!.title).toMatch(/^1959: The first photograph of the far side of the Moon/);
    expect(all.find((a) => a.kind === 'picture')!.title).toBe('Glass sponge Euplectella');
    const some = await gatherToday(T0, makeRng('w'), worldFetch({ down: /poetrydb|arxiv/ }));
    expect(some.map((a) => a.kind)).not.toContain('poem');
    expect(some.map((a) => a.kind)).not.toContain('paper');
  });

  it('a few arrive once a day, each in its place in her house; the last days are kept; the mind sees what she has not looked at', async () => {
    const house = openHouse(join(tmpDir('thea2-world-'), 'house'));
    const clock = new TestClock(T0);
    const fresh = await worldArrives({ house, clock, rng: makeRng('w'), fetchImpl: worldFetch() });
    expect(fresh).toHaveLength(ARRIVALS_PER_DAY);
    for (const k of ['poem', 'paper', 'art', 'picture', 'history']) expect(fresh.filter((a) => a.kind === k).length).toBeLessThanOrEqual(1);
    expect(fresh.find((a) => a.kind === 'poem')?.place ?? 'on the Kitchen table').toBe('on the Kitchen table');
    expect(await worldArrives({ house, clock, rng: makeRng('w'), fetchImpl: worldFetch() })).toEqual([]); // once a day
    const seam = worldSeam(house);
    expect(seam.unseen(T0 + 60_000)).toHaveLength(ARRIVALS_PER_DAY);
    seam.markSeen(fresh[0]!.id, T0 + 60_000);
    expect(seam.unseen(T0 + 60_000).map((a) => a.id)).not.toContain(fresh[0]!.id);
    expect(seam.unseen(T0 + 3 * 86_400_000)).toEqual([]); // two days on, what she never looked at is no longer "new"
    await clock.advance(86_400_000);
    expect(await worldArrives({ house, clock, rng: makeRng('w2'), fetchImpl: worldFetch() })).toHaveLength(ARRIVALS_PER_DAY); // the next morning
  });
});
