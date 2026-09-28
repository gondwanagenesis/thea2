// Where he says he is (Diego, 2026-09-28: "it is 8 am. I am in Bali. y do u keep forgetting that?").
// Only a shared pin could move her clock, so every turn stamped Madrid time as "his time" — and she
// kept doing the math on the wrong planet. Now a place he names moves it, until he names another.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { startThead } from '../../src/app/index.js';
import { placeFromWords, whereFresh } from '../../src/body/index.js';
import { inbound, runToQuiescent, T0 } from '../mind/helpers.js';
import { bootV9 } from './helpers.js';

// what Open-Meteo's geocoder answered for these names on 2026-09-28 (first "Bali" is in India)
const GEO: Record<string, unknown[]> = {
  Bali: [
    { name: 'Bāli', admin1: 'West Bengal', country: 'India', timezone: 'Asia/Kolkata', population: 296973, latitude: 22.65, longitude: 88.34 },
    { name: 'Bali', admin1: 'Bali', country: 'Indonesia', timezone: 'Asia/Makassar', population: 4225384, latitude: -8.5, longitude: 115.0 },
    { name: 'Bali', admin1: 'Gansu', country: 'China', timezone: 'Asia/Shanghai', population: 7101, latitude: 34.0, longitude: 105.0 },
  ],
  Canggu: [
    { name: 'Canggu', admin1: 'East Java', country: 'Indonesia', timezone: 'Asia/Jakarta', latitude: -7.4, longitude: 112.4 },
    { name: 'Canggu', admin1: 'East Java', country: 'Indonesia', timezone: 'Asia/Jakarta', latitude: -7.5, longitude: 112.5 },
    { name: 'Canggu', admin1: 'Bali', country: 'Indonesia', timezone: 'Asia/Makassar', latitude: -8.65, longitude: 115.13 },
  ],
};
const geoFetch = (opts: { down?: boolean } = {}): typeof fetch & { urls: string[] } => {
  const urls: string[] = [];
  const f = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('geocoding-api.open-meteo.com')) {
      if (opts.down === true) return new Response('down', { status: 500 });
      const name = decodeURIComponent(/name=([^&]+)/.exec(url)?.[1] ?? '');
      return new Response(JSON.stringify({ results: GEO[name] ?? [] }), { status: 200 });
    }
    if (url.includes('api.open-meteo.com/v1/forecast')) return new Response(JSON.stringify({ current: { temperature_2m: 28.2, weather_code: 1, is_day: 1 } }), { status: 200 });
    return new Response('not scripted', { status: 404 });
  }) as typeof fetch & { urls: string[] };
  f.urls = urls;
  return f;
};

describe('a place he names becomes where he is', () => {
  it('"Bali, Indonesia" is Bali the island (Asia/Makassar), not Bāli in West Bengal; with no country, the most populous', async () => {
    expect(await placeFromWords('Bali, Indonesia', T0, geoFetch())).toMatchObject({ place: 'Bali, Indonesia', timeZone: 'Asia/Makassar', stated: true, live: false, at: T0, tempC: 28 });
    expect(await placeFromWords('Bali', T0, geoFetch())).toMatchObject({ timeZone: 'Asia/Makassar' });
    // the region says which Canggu (the first ones are in East Java, an hour off)
    expect(await placeFromWords('Canggu, Bali, Indonesia', T0, geoFetch())).toMatchObject({ place: 'Canggu, Bali, Indonesia', timeZone: 'Asia/Makassar' });
  });

  it('nothing agrees with what he said, or the geocoder is down: no guess', async () => {
    expect(await placeFromWords('Bali, Peru', T0, geoFetch())).toBeUndefined();
    expect(await placeFromWords('Nowhereville', T0, geoFetch())).toBeUndefined();
    expect(await placeFromWords('Bali, Indonesia', T0, geoFetch({ down: true }))).toBeUndefined();
  });

  it('the sky is a snapshot: said while fresh, left out after (a place named yesterday is not 23° today)', async () => {
    const { describeWhere } = await import('../../src/body/index.js');
    const w = { lat: -8.3, lon: 115, place: 'Bali, Indonesia', live: false, stated: true, at: T0, timeZone: 'Asia/Makassar', tempC: 23, sky: 'partly cloudy' };
    expect(describeWhere(w, T0 + 3600_000)).toMatch(/^Bali, Indonesia — \d\d:\d\d there, 23°, partly cloudy$/);
    expect(describeWhere(w, T0 + 5 * 3600_000)).toMatch(/^Bali, Indonesia — \d\d:\d\d there$/);
    // named at 00:02, the sky read at 10:26: fresh from when it was read
    expect(describeWhere({ ...w, skyAt: T0 + 10 * 3600_000 }, T0 + 11 * 3600_000)).toContain('23°');
    expect(await placeFromWords('Bali, Indonesia', T0, geoFetch(), T0 + 10 * 3600_000)).toMatchObject({ at: T0, skyAt: T0 + 10 * 3600_000 });
  });

  it('a live pin is trusted for three days; a place he named, until he names another', () => {
    const day = 86_400_000;
    const base = { lat: 0, lon: 0, place: 'x', at: T0 };
    expect(whereFresh({ ...base, live: true }, T0 + 2 * day)).toBe(true);
    expect(whereFresh({ ...base, live: true }, T0 + 4 * day)).toBe(false);
    expect(whereFresh({ ...base, live: false, stated: true }, T0 + 30 * day)).toBe(true);
  });

  it('e2e: he says he is in Bali → his clock moves there, she knows where he is, and it stays apart from the passing notes', { timeout: 60_000 }, async () => {
    const f = geoFetch();
    const h = await bootV9({}, { fetchImpl: f });
    const decide = { toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['oh. good morning then'], confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] };
    h.model.enqueue(decide);
    h.model.enqueue({ toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 5, about_them: ['he corrected the time plainly'], lasting_about_them: ['he is staying in Bali'], where_they_are: 'Bali, Indonesia' } }] });
    h.model.enqueue(decide);
    h.model.enqueue({ toolCalls: [{ id: 'a2', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 3 } }] });
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'it is 8 am. I am in Bali. y do u keep forgetting that?' }));
    await runToQuiescent(h);
    const where = JSON.parse(fs.readFileSync(join(h.dir, 'var', 'house', 'where.json'), 'utf8')) as { timeZone?: string; stated?: boolean; place: string };
    expect(where).toMatchObject({ timeZone: 'Asia/Makassar', stated: true, place: 'Bali, Indonesia' });
    // the next turn: his time is Bali time, and he is where he said
    await h.clock.advance(3600_000);
    h.channel.queueInbound(inbound({ updateId: 501, msgId: 901, ts: T0 + 3600_000, text: 'how is your morning' }));
    await runToQuiescent(h);
    await handle.stop();
    const turns = h.model.calls.filter((c) => c.taskClass === 'turn');
    const second = turns.at(-1)!.messages.map((x) => String(x.content)).join('\n');
    const bali = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Makassar' }).format(T0 + 3600_000);
    expect(second).toMatch(new RegExp(`\\[now\\]\\n\\w+ ${bali}:\\d\\d his time\\.`)); // Bali time, not Madrid
    expect(second).toContain('where he is: Bali, Indonesia');
    expect(second).toContain('where they are: Bali, Indonesia (they said');
    expect(second).toMatch(/what you know about them:\n- he is staying in Bali/);
    expect(second).toMatch(/lately:\n- he corrected the time plainly/);
    expect(f.urls.filter((u) => u.includes('geocoding')).length).toBe(1); // looked up once
  });
});
