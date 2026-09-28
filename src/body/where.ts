// v9 body — where he is. Thea1's where.mjs, re-done for Thea2: a shared
// location becomes a place name (BigDataCloud reverse geocode), his local time
// zone and sky (Open-Meteo). Free, keyless APIs; a failure keeps the raw fix.

import type { WhereInfo } from './types.js';
import type { House } from './house.js';

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

const TIMEOUT = 15_000;
export const WHERE_FILE = 'where.json';

export const locate = async (
  fix: { lat: number; lon: number; live: boolean; title?: string | undefined; address?: string | undefined; at: number },
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<WhereInfo> => {
  let place = [fix.title, fix.address].filter((x): x is string => typeof x === 'string' && x !== '').join(', ');
  try {
    if (place === '') {
      const r = await fetchImpl(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${fix.lat}&longitude=${fix.lon}&localityLanguage=en`,
        { signal: AbortSignal.timeout(TIMEOUT) },
      );
      if (r.ok) {
        const j = (await r.json()) as { locality?: string; city?: string; principalSubdivision?: string; countryName?: string };
        place = [j.locality || j.city, j.principalSubdivision, j.countryName].filter((x): x is string => typeof x === 'string' && x !== '').join(', ');
      }
    }
  } catch {
    // the coordinates alone still say where he is
  }
  const info: WhereInfo = { lat: fix.lat, lon: fix.lon, place: place !== '' ? place : `${fix.lat.toFixed(3)}, ${fix.lon.toFixed(3)}`, live: fix.live, at: fix.at };
  try {
    const r = await fetchImpl(
      `https://api.open-meteo.com/v1/forecast?latitude=${fix.lat}&longitude=${fix.lon}&current=temperature_2m,weather_code,is_day&timezone=auto`,
      { signal: AbortSignal.timeout(TIMEOUT) },
    );
    if (r.ok) {
      const j = (await r.json()) as { timezone?: string; current?: { temperature_2m?: number; weather_code?: number; is_day?: number } };
      if (typeof j.timezone === 'string') info.timeZone = j.timezone;
      if (typeof j.current?.temperature_2m === 'number') info.tempC = Math.round(j.current.temperature_2m);
      if (typeof j.current?.weather_code === 'number') info.sky = WMO[j.current.weather_code] ?? undefined;
      if (typeof j.current?.is_day === 'number') info.isDay = j.current.is_day === 1;
    }
  } catch {
    // no weather is fine
  }
  return info;
};

/** "Ubud, Bali, Indonesia — 21:40 there, 27°, light rain" */
export const describeWhere = (w: WhereInfo, now: number): string => {
  const bits: string[] = [];
  if (w.timeZone !== undefined) {
    try {
      bits.push(`${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: w.timeZone }).format(now)} there`);
    } catch {
      // unknown zone: leave the time out
    }
  }
  if (w.tempC !== undefined) bits.push(`${w.tempC}°`);
  if (w.sky !== undefined) bits.push(w.sky);
  return bits.length > 0 ? `${w.place} — ${bits.join(', ')}` : w.place;
};

/**
 * A place he NAMED ("I'm in Bali") → where he is, with his time zone (2026-09-28: he had told her twice
 * he was in Bali, but only a shared pin could move her clock, so every turn still stamped Madrid time as
 * "his time"). Open-Meteo's geocoder, keyless like the rest. Its first "Bali" is a town in India, so the
 * words after the first comma must agree with the match (a region or a country); with nothing to agree
 * with, the most populous match (Bali the island, 4.2 M, over Bāli in West Bengal, 0.3 M).
 */
export const placeFromWords = async (said: string, at: number, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<WhereInfo | undefined> => {
  const parts = said.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const name = parts[0];
  if (name === undefined) return undefined;
  const hints = parts.slice(1).map((s) => s.toLowerCase());
  let best: { name: string; admin1?: string; country?: string; latitude: number; longitude: number; timezone?: string; population?: number } | undefined;
  try {
    const r = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { results?: Array<NonNullable<typeof best>> };
    const agrees = (x: NonNullable<typeof best>, h: string): boolean => [x.admin1, x.country].some((v) => v !== undefined && (v.toLowerCase().includes(h) || h.includes(v.toLowerCase())));
    const score = (x: NonNullable<typeof best>): number => hints.filter((h) => agrees(x, h)).length;
    const ranked = [...(j.results ?? [])].sort((a, b) => score(b) - score(a) || (b.population ?? 0) - (a.population ?? 0));
    best = ranked[0];
    if (best === undefined || (hints.length > 0 && score(best) === 0)) return undefined; // nothing agrees with what he said
  } catch {
    return undefined;
  }
  const place = [best.name, best.admin1 !== best.name ? best.admin1 : undefined, best.country].filter((x): x is string => typeof x === 'string' && x !== '').join(', ');
  const info = await locate({ lat: best.latitude, lon: best.longitude, live: false, title: place, at }, fetchImpl);
  return { ...info, ...(best.timezone !== undefined ? { timeZone: best.timezone } : {}), stated: true };
};

/** A live pin stops updating, so it is trusted for three days; a static pin or a place he named, until he says otherwise. */
export const WHERE_LIVE_FRESH_MS = 3 * 24 * 3600_000;
export const WHERE_STATED_FRESH_MS = 60 * 24 * 3600_000;
export const whereFresh = (w: WhereInfo, now: number): boolean => now - w.at < (w.live ? WHERE_LIVE_FRESH_MS : WHERE_STATED_FRESH_MS);

export const loadWhere = (house: House): WhereInfo | undefined => house.readJson<WhereInfo | undefined>(WHERE_FILE, undefined);
export const saveWhere = (house: House, w: WhereInfo): void => house.writeJson(WHERE_FILE, w);
