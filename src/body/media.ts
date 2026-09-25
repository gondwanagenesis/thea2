// v9 body — ffmpeg plumbing: voice notes to wav for listening, frames and the
// sound track out of a video, durations. Temp files live in the house's tmp/
// and are removed after use; a failure returns undefined, never throws past here.

import * as fs from 'node:fs';
import type { Exec } from './types.js';
import type { House } from './house.js';

const rm = (p: string): void => {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // best effort: tmp/ is swept by sleep anyway
  }
};

/** Any audio (Telegram .oga, mp3, m4a…) → 16 kHz mono wav bytes. */
export const toWav16k = async (exec: Exec, house: House, bytes: Uint8Array, ext: string, stamp: number): Promise<Uint8Array | undefined> => {
  const inp = house.tmp(`in.${ext}`, stamp);
  const out = house.tmp('out.wav', stamp);
  fs.writeFileSync(inp, bytes);
  try {
    const r = await exec.run('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-ac', '1', '-ar', '16000', out], { timeoutMs: 60_000 });
    if (r.code !== 0 || !fs.existsSync(out)) return undefined;
    return new Uint8Array(fs.readFileSync(out));
  } finally {
    rm(inp);
    rm(out);
  }
};

/** Seconds of media, from ffprobe; undefined if it can't tell. */
export const durationOf = async (exec: Exec, file: string): Promise<number | undefined> => {
  const r = await exec.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 20_000 });
  const n = Number(Buffer.from(r.stdout).toString('utf8').trim());
  return r.code === 0 && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** A few stills spread across a video (or GIF), as jpeg bytes, plus its sound as wav if it has any. */
export const videoParts = async (
  exec: Exec,
  house: House,
  bytes: Uint8Array,
  ext: string,
  durationSec: number,
  stamp: number,
): Promise<{ frames: Uint8Array[]; wav?: Uint8Array | undefined }> => {
  const inp = house.tmp(`video.${ext}`, stamp);
  fs.writeFileSync(inp, bytes);
  const frames: Uint8Array[] = [];
  const made: string[] = [];
  try {
    const dur = durationSec > 0 ? durationSec : ((await durationOf(exec, inp)) ?? 1);
    const points = dur < 2 ? [0] : [0.1, 0.5, 0.9].map((f) => Math.max(0, dur * f));
    for (const [i, t] of points.entries()) {
      const out = house.tmp(`frame${i}.jpg`, stamp);
      made.push(out);
      const r = await exec.run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', inp, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', out], { timeoutMs: 30_000 });
      if (r.code === 0 && fs.existsSync(out)) frames.push(new Uint8Array(fs.readFileSync(out)));
    }
    const wavOut = house.tmp('video.wav', stamp);
    made.push(wavOut);
    const a = await exec.run('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-vn', '-ac', '1', '-ar', '16000', wavOut], { timeoutMs: 60_000 });
    const wav = a.code === 0 && fs.existsSync(wavOut) && fs.statSync(wavOut).size > 2000 ? new Uint8Array(fs.readFileSync(wavOut)) : undefined;
    return { frames, ...(wav !== undefined ? { wav } : {}) };
  } finally {
    rm(inp);
    for (const f of made) rm(f);
  }
};

/** Re-encode speech to Ogg/Opus mono (Telegram's voice-note format) when a provider returns something else. */
export const toOggOpus = async (exec: Exec, house: House, bytes: Uint8Array, ext: string, stamp: number): Promise<{ bytes: Uint8Array; seconds?: number | undefined } | undefined> => {
  const inp = house.tmp(`speech.${ext}`, stamp);
  const out = house.tmp('speech.ogg', stamp);
  fs.writeFileSync(inp, bytes);
  try {
    const r = await exec.run('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', out], { timeoutMs: 60_000 });
    if (r.code !== 0 || !fs.existsSync(out)) return undefined;
    const seconds = await durationOf(exec, out);
    return { bytes: new Uint8Array(fs.readFileSync(out)), ...(seconds !== undefined ? { seconds } : {}) };
  } finally {
    rm(inp);
    rm(out);
  }
};
