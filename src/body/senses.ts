// v9 body — the senses. One inbound message in; the text this turn runs on
// out: his words (typed, or heard and transcribed) and, in brackets, what came
// with them — what a photo shows, how his voice sounds, how a file opens,
// where he is. That is material: what happened, never what to feel about it.
//
// Every sense fails open. A photo that won't download becomes "[he sent a
// photo — it didn't load]", never a dead turn.

import * as fs from 'node:fs';
import type { Clock } from '../kernel/index.js';
import type { Channel, InboundMedia, InboundMsg } from '../bridge/index.js';
import type { OpenAIBody } from './openai.js';
import type { Exec, Perceived, WhereInfo } from './types.js';
import type { House } from './house.js';
import { toWav16k, videoParts } from './media.js';
import { readFileText, readingPathFor } from './reading.js';
import { describeWhere, locate, saveWhere } from './where.js';

export interface SensesDeps {
  openai: OpenAIBody;
  exec: Exec;
  house: House;
  channel: Channel;
  clock: Clock;
  fetchImpl?: typeof fetch | undefined;
}

export interface Senses {
  perceive(m: InboundMsg): Promise<Perceived>;
  /** A live-location ping (recorded, never a turn): update where he is, silently. */
  whereUpdate(m: InboundMsg): Promise<WhereInfo | undefined>;
}

export const PHOTO_PROMPT =
  'Describe this image for someone who cannot see it: what it shows, the people in it and their expressions, the setting, light and colours, and any text in it (quote it exactly). Plain description, 2 to 5 sentences.';
export const FRAMES_PROMPT =
  'These are stills from one short video, in order. Describe what the video shows and what happens across it, the people and their expressions, the setting, and any text. Plain description, 2 to 5 sentences.';
export const LISTEN_PROMPT =
  'In one short line, describe how the speaker sounds: tone, energy, pace, and anything in the background. Do not repeat or summarise the words.';

/** How much of a file she sees at once in the turn; the rest is a read_file away. */
export const FILE_OPENING_CHARS = 1500;
const TRANSCRIBE_MAX_SEC = 600;

const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

const extOf = (media: InboundMedia, path: string): string => {
  const fromPath = /\.([a-z0-9]{2,5})$/i.exec(path)?.[1];
  if (fromPath !== undefined) return fromPath.toLowerCase();
  switch (media.kind) {
    case 'voice':
      return 'oga';
    case 'video_note':
    case 'video':
      return 'mp4';
    case 'animation':
      return 'mp4';
    case 'photo':
      return 'jpg';
    default:
      return 'bin';
  }
};

const mimeForImage = (path: string): string => (/\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg');

export const makeSenses = (d: SensesDeps): Senses => {
  const body = d.channel.body;

  const download = async (fileId: string): Promise<{ bytes: Uint8Array; path: string }> => {
    if (body === undefined) throw new Error('this channel cannot fetch files');
    return body.fetchFile(fileId);
  };

  const whereFrom = async (loc: Extract<InboundMedia, { kind: 'location' }>): Promise<WhereInfo> => {
    const w = await locate({ lat: loc.lat, lon: loc.lon, live: loc.live, title: loc.title, address: loc.address, at: d.clock.epochMs() }, d.fetchImpl);
    saveWhere(d.house, w);
    return w;
  };

  const sense = async (m: InboundMsg, media: InboundMedia, trace: Perceived['trace']): Promise<{ lines: string[]; said?: string; voice?: boolean; saved?: string }> => {
    const t0 = d.clock.epochMs();
    const stamp = t0;
    const mark = (sense: string, ok: boolean, error?: string): void => {
      trace.push({ sense, ms: d.clock.epochMs() - t0, ok, ...(error !== undefined ? { error: error.slice(0, 200) } : {}) });
    };
    try {
      switch (media.kind) {
        case 'photo': {
          const f = await download(media.fileId);
          const saved = d.house.save('incoming', `photo.${extOf(media, f.path)}`, f.bytes, stamp);
          const seen = await d.openai.vision([{ bytes: f.bytes, mime: mimeForImage(f.path) }], PHOTO_PROMPT);
          mark('eyes', true);
          return { lines: [`[photo: ${seen || 'an image'}]`], saved: d.house.rel(saved) };
        }
        case 'sticker': {
          mark('sticker', true);
          return { lines: [`[sticker${media.emoji !== undefined ? ` ${media.emoji}` : ''}]`] };
        }
        case 'voice':
        case 'audio': {
          const f = await download(media.fileId);
          const ext = extOf(media, f.path);
          const saved = d.house.save('incoming', `${media.kind}.${ext}`, f.bytes, stamp);
          if (media.kind === 'audio' && media.durationSec > TRANSCRIBE_MAX_SEC) {
            mark('ears', true);
            return { lines: [`[audio${media.title !== undefined ? ` "${media.title}"` : ''}, ${mmss(media.durationSec)} — too long to listen through here; saved at house/${d.house.rel(saved)}]`], saved: d.house.rel(saved) };
          }
          const wav = await toWav16k(d.exec, d.house, f.bytes, ext, stamp);
          const [words, how] = await Promise.all([
            d.openai.transcribe(wav ?? f.bytes, wav !== undefined ? 'voice.wav' : `voice.${ext}`, wav !== undefined ? 'audio/wav' : 'audio/ogg'),
            wav !== undefined && media.kind === 'voice' ? d.openai.listen(wav, LISTEN_PROMPT).catch(() => '') : Promise.resolve(''),
          ]);
          mark('ears', true);
          if (media.kind === 'voice') {
            const head = `[voice note, ${mmss(media.durationSec)}${how !== '' ? ` — ${how.replace(/\s+/g, ' ').replace(/\.$/, '')}` : ''}]`;
            return { lines: [head], said: words, voice: true, saved: d.house.rel(saved) };
          }
          return { lines: [`[audio${media.title !== undefined ? ` "${media.title}"` : ''}, ${mmss(media.durationSec)}${words !== '' ? `: "${words.slice(0, 1500)}"` : ' — no words in it'}]`], saved: d.house.rel(saved) };
        }
        case 'video':
        case 'video_note':
        case 'animation': {
          const f = await download(media.fileId);
          const ext = extOf(media, f.path);
          const saved = d.house.save('incoming', `${media.kind}.${ext}`, f.bytes, stamp);
          const parts = await videoParts(d.exec, d.house, f.bytes, ext, media.durationSec, stamp);
          const [seen, words] = await Promise.all([
            parts.frames.length > 0 ? d.openai.vision(parts.frames.map((b) => ({ bytes: b, mime: 'image/jpeg' })), FRAMES_PROMPT) : Promise.resolve(''),
            parts.wav !== undefined && media.kind !== 'animation' ? d.openai.transcribe(parts.wav, 'video.wav', 'audio/wav').catch(() => '') : Promise.resolve(''),
          ]);
          mark('eyes+ears', true);
          const label = media.kind === 'video_note' ? 'round video' : media.kind === 'animation' ? 'gif' : 'video';
          const dur = media.durationSec > 0 ? `, ${mmss(media.durationSec)}` : '';
          return {
            lines: [`[${label}${dur}: ${seen || 'could not make out the picture'}${words !== '' ? ` — he says: "${words.slice(0, 1200)}"` : ''}]`],
            ...(media.kind === 'video_note' && words !== '' ? { said: '' } : {}),
            saved: d.house.rel(saved),
          };
        }
        case 'document': {
          const f = await download(media.fileId);
          const saved = d.house.save('incoming', media.fileName, f.bytes, stamp);
          const read = await readFileText(d.exec, saved, media.fileName, media.mime);
          mark('reading', read !== undefined);
          if (read === undefined || read.text === '') {
            if (media.mime?.startsWith('image/') === true) {
              const seen = await d.openai.vision([{ bytes: f.bytes, mime: media.mime }], PHOTO_PROMPT);
              return { lines: [`[image file ${media.fileName}: ${seen}]`], saved: d.house.rel(saved) };
            }
            return { lines: [`[file: ${media.fileName} — not something you can read as text; saved at house/${d.house.rel(saved)}]`], saved: d.house.rel(saved) };
          }
          const txt = readingPathFor(d.house.root, saved);
          fs.writeFileSync(txt, read.text);
          const size = read.pages !== undefined ? `${read.pages} pages, ` : '';
          const opening = read.text.slice(0, FILE_OPENING_CHARS).replace(/\s+\n/g, '\n');
          const more = read.text.length > FILE_OPENING_CHARS ? ` (read_file "${d.house.rel(txt)}" for the rest)` : '';
          return {
            lines: [`[file: ${media.fileName} — ${size}${Math.round(read.text.length / 1000)}k characters${more}]`, `[it opens:]\n${opening}${read.text.length > FILE_OPENING_CHARS ? '\n…' : ''}`],
            saved: d.house.rel(saved),
          };
        }
        case 'location': {
          const w = await whereFrom(media);
          mark('where', true);
          return { lines: [`[he shared his location${media.live ? ' (live)' : ''}: ${describeWhere(w, d.clock.epochMs())}]`] };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mark(media.kind, false, msg);
      const what = media.kind === 'photo' ? 'a photo' : media.kind === 'voice' ? 'a voice note' : media.kind === 'document' ? `a file (${media.fileName})` : media.kind === 'location' ? 'his location' : `a ${media.kind.replace('_', ' ')}`;
      return { lines: [`[he sent ${what} — it didn't come through: ${/20 MB|too big|file_path/i.test(msg) ? 'too big to open' : 'it failed to load'}]`] };
    }
  };

  return {
    perceive: async (m) => {
      const trace: Perceived['trace'] = [];
      const lines: string[] = [];
      let voice = false;
      let saved: string | undefined;
      let said = m.text;
      if (m.edited === true) lines.push('(he edited his earlier message; it now says:)');
      if (m.replyTo !== undefined && m.replyTo.text !== '') {
        lines.push(`(replying to ${m.replyTo.fromBot ? 'your message' : 'his earlier message'}: «${m.replyTo.text.slice(0, 400)}»)`);
      }
      if (m.media !== undefined) {
        const r = await sense(m, m.media, trace);
        lines.push(...r.lines);
        if (r.voice === true) voice = true;
        if (r.saved !== undefined) saved = r.saved;
        if (r.said !== undefined && r.said !== '') said = said === '' ? r.said : `${r.said}\n${said}`;
      }
      const text = [...lines, said].filter((s) => s.trim() !== '').join('\n');
      return { text: text === '' ? '[an empty message]' : text, voice, ...(saved !== undefined ? { saved } : {}), trace };
    },

    whereUpdate: async (m) => {
      if (m.media?.kind !== 'location') return undefined;
      try {
        return await whereFrom(m.media);
      } catch {
        return undefined;
      }
    },
  };
};
