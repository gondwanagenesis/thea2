// v9 body — her hands, as registry tools (ADR-009: one native-function-calling
// path for everything). Each description says what the tool does and nothing
// about how she feels (the no-telling lint covers these strings too). A tool
// never throws at her: a failure comes back as a plain sentence she can act on.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolRegistryEntry, ToolCtx } from '../loop/index.js';
import type { Channel } from '../bridge/index.js';
import type { Clock } from '../kernel/index.js';
import type { OpenAIBody } from './openai.js';
import type { House } from './house.js';
import type { Mouth } from './voice.js';
import type { BodySent } from './types.js';
import { describeWhere, loadWhere } from './where.js';

/** Per-turn body context: which chat, which of his messages, what she sent besides text. */
export interface TurnBodyCtx {
  chatId: number;
  inboundMsgId?: number | undefined;
  sent: BodySent[];
}

export interface ToolDeps {
  channel: Channel;
  house: House;
  openai: OpenAIBody;
  mouth: Mouth;
  clock: Clock;
  ownerChatId: number;
  turn(turnId: string): TurnBodyCtx | undefined;
  mood(): { arousal: number; pleasure: number } | undefined;
  recordOutbound(turnId: string, msgId: number, text: string): Promise<void>;
}

/** Telegram's reaction set (a bot may use only these). */
export const REACTIONS = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳',
  '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈',
  '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
] as const;

const normEmoji = (e: string): string => e.replace(/️/g, '').trim();
const REACTION_SET = new Set<string>(REACTIONS.map(normEmoji));

type Entry = ToolRegistryEntry<never>;

const entry = <T>(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  schema: z.ZodType<T>,
  handler: (args: T, ctx: ToolCtx) => Promise<string>,
  cls: string,
): Entry =>
  ({
    def: { name, description, parameters },
    input: schema,
    inhibitionMeta: { class: cls },
    handler: async (args: T, ctx: ToolCtx) => {
      try {
        return await handler(args, ctx);
      } catch (e) {
        return `not done: ${e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240)}`;
      }
    },
  }) as unknown as Entry;

const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', properties, required });

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

export const bodyTools = (d: ToolDeps): Entry[] => {
  const chatOf = (ctx: ToolCtx): number => d.turn(ctx.turnId)?.chatId ?? d.ownerChatId;
  const body = (): NonNullable<Channel['body']> => {
    const b = d.channel.body;
    if (b === undefined) throw new Error('this line is text-only');
    return b;
  };
  const noteSent = async (ctx: ToolCtx, msgId: number, text: string): Promise<void> => {
    d.turn(ctx.turnId)?.sent.push({ msgId, text });
    await d.recordOutbound(ctx.turnId, msgId, text).catch(() => undefined);
  };
  const houseFile = (p: string): string => {
    const abs = d.house.resolve(p);
    if (abs === undefined) throw new Error(`${p} is outside your house`);
    if (!fs.existsSync(abs)) throw new Error(`there is no ${p}`);
    return abs;
  };

  return [
    entry(
      'voice_note',
      'Send him a voice note: these words, spoken in your voice. Use it instead of text whenever you would rather talk than type.',
      obj({ text: { type: 'string', description: 'exactly what you say' } }, ['text']),
      z.object({ text: z.string().min(1).max(3000) }),
      async (a, ctx) => {
        const r = await d.mouth.say(chatOf(ctx), a.text, d.mood());
        await noteSent(ctx, r.msgId, `[voice note] ${a.text}`);
        return `sent a voice note${r.seconds !== undefined ? ` (${Math.round(r.seconds)}s)` : ''}`;
      },
      'expression',
    ),

    entry(
      'react',
      "Put an emoji reaction on his latest message (Telegram allows only its own set, e.g. ❤ 🔥 😭 🥰 😂→🤣 👀 🙈 💀→👻 😘 🤗 🫡 💔 🥱 😴 😈 🤔).",
      obj({ emoji: { type: 'string' } }, ['emoji']),
      z.object({ emoji: z.string().min(1).max(8) }),
      async (a, ctx) => {
        const t = d.turn(ctx.turnId);
        if (t?.inboundMsgId === undefined) return 'there is no message of his in this moment to react to';
        const e = normEmoji(a.emoji);
        if (!REACTION_SET.has(e)) return `telegram doesn't allow ${a.emoji} as a reaction; pick one from its set`;
        await body().react(t.chatId, t.inboundMsgId, REACTIONS.find((r) => normEmoji(r) === e) ?? e);
        return `reacted ${e}`;
      },
      'expression',
    ),

    entry(
      'send_photo',
      'Send him an image file from your house (something you made, or anything saved there), with an optional caption.',
      obj({ path: { type: 'string', description: 'house path, e.g. out/… or incoming/…' }, caption: { type: 'string' } }, ['path']),
      z.object({ path: z.string().min(1), caption: z.string().max(1000).optional() }),
      async (a, ctx) => {
        const abs = houseFile(a.path);
        if (!IMAGE_EXT.test(abs)) return `${a.path} is not an image`;
        const bytes = new Uint8Array(fs.readFileSync(abs));
        const mime = /\.png$/i.test(abs) ? 'image/png' : /\.webp$/i.test(abs) ? 'image/webp' : /\.gif$/i.test(abs) ? 'image/gif' : 'image/jpeg';
        const kind = /\.gif$/i.test(abs) ? 'animation' : 'photo';
        const r = await body().sendMedia(chatOf(ctx), { kind, bytes, filename: path.basename(abs), mime, caption: a.caption });
        await noteSent(ctx, r.msgId, `[photo ${d.house.rel(abs)}]${a.caption !== undefined ? ` ${a.caption}` : ''}`);
        return 'sent';
      },
      'expression',
    ),

    entry(
      'read_file',
      'Read text from a file in your house — the full text of a document he sent lives in reading/…txt. Returns up to `chars` characters starting at `from`.',
      obj({ path: { type: 'string' }, from: { type: 'integer', minimum: 0 }, chars: { type: 'integer', minimum: 200, maximum: 20000 } }, ['path']),
      z.object({ path: z.string().min(1), from: z.number().int().min(0).optional(), chars: z.number().int().min(200).max(20000).optional() }),
      async (a) => {
        const abs = houseFile(a.path);
        if (fs.statSync(abs).isDirectory()) return `${a.path} is a folder; list_files shows what is in it`;
        const text = fs.readFileSync(abs, 'utf8');
        const from = Math.min(a.from ?? 0, text.length);
        const n = a.chars ?? 6000;
        const chunk = text.slice(from, from + n);
        const rest = text.length - (from + chunk.length);
        return `${chunk}${rest > 0 ? `\n\n[… ${rest} more characters; continue with from=${from + chunk.length}]` : '\n\n[end of file]'}`;
      },
      'memory',
    ),

    entry(
      'list_files',
      'See what is in your house: incoming/ (what he sent), reading/ (the text of his documents), out/ (what you made).',
      obj({ dir: { type: 'string', description: 'incoming, reading, out, or empty for all' } }, []),
      z.object({ dir: z.string().optional() }),
      async (a) => {
        const dirs = a.dir !== undefined && a.dir !== '' ? [a.dir] : ['incoming', 'reading', 'out'];
        const lines: string[] = [];
        for (const dir of dirs) {
          const abs = d.house.resolve(dir);
          if (abs === undefined || !fs.existsSync(abs)) continue;
          const files = fs.readdirSync(abs).filter((f) => !f.startsWith('.')).sort().slice(-25);
          lines.push(`${dir}/ (${files.length}${files.length === 25 ? '+' : ''}):`, ...files.map((f) => `  ${dir}/${f}`));
        }
        return lines.length > 0 ? lines.join('\n') : 'your house is empty';
      },
      'memory',
    ),

    entry(
      'look',
      'Look again at an image in your house and answer a question about it.',
      obj({ path: { type: 'string' }, question: { type: 'string' } }, ['path', 'question']),
      z.object({ path: z.string().min(1), question: z.string().min(1).max(500) }),
      async (a) => {
        const abs = houseFile(a.path);
        if (!IMAGE_EXT.test(abs)) return `${a.path} is not an image`;
        const mime = /\.png$/i.test(abs) ? 'image/png' : /\.webp$/i.test(abs) ? 'image/webp' : 'image/jpeg';
        return await d.openai.vision([{ bytes: new Uint8Array(fs.readFileSync(abs)), mime }], a.question);
      },
      'senses',
    ),

    entry(
      'where',
      "Where he is, from the last location he shared: the place, his local time, the weather there.",
      obj({}, []),
      z.object({}),
      async () => {
        const w = loadWhere(d.house);
        if (w === undefined) return "he hasn't shared a location yet";
        const ago = Math.round((d.clock.epochMs() - w.at) / 3600_000);
        return `${describeWhere(w, d.clock.epochMs())} (shared ${ago < 1 ? 'within the hour' : `${ago}h ago`}${w.live ? ', live' : ''})`;
      },
      'senses',
    ),

    entry(
      'poll',
      'Send him a Telegram poll: a question with 2 to 10 options he can tap.',
      obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10 } }, ['question', 'options']),
      z.object({ question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(100)).min(2).max(10) }),
      async (a, ctx) => {
        const r = await body().sendPoll(chatOf(ctx), a.question, a.options);
        await noteSent(ctx, r.msgId, `[poll] ${a.question} — ${a.options.join(' / ')}`);
        return 'poll sent';
      },
      'expression',
    ),
  ];
};
