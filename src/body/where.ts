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

export const loadWhere = (house: House): WhereInfo | undefined => house.readJson<WhereInfo | undefined>(WHERE_FILE, undefined);
export const saveWhere = (house: House, w: WhereInfo): void => house.writeJson(WHERE_FILE, w);
