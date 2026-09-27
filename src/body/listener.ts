// v13 introspection, Phase 3 — H8 THE LISTENER (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 3; §3 T4). A CONTROL arm, pre-registered to fail: someone she may choose to sit with to talk
// the day through — a different model family (the judge door), so its voice is not hers. It speaks
// only after she has named something; it may reflect what she said or what happened (observables)
// and ask one short question; it never names a feeling, never interprets, never advises. Anything it
// says that names a feeling or slips into the therapy register is dropped before she sees it.
//
// Off by default (config mind.listener): Diego rejected a therapist character; this exists so the
// claim "a reflective listener adds nothing beyond her own naming and look-back" can be tested.
// Kill: therapy-register density in her thoughts or bubbles +25%, an overwriting index > 0.10, or no
// gain over H4.

import { z } from 'zod';
import type { ToolCtx, ToolRegistryEntry } from '../loop/index.js';
import type { ModelClient } from '../model/index.js';
import type { Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import { senseViolations, THERAPY_REGISTER } from '../mind/index.js';
import type { House } from './house.js';

type Entry = ToolRegistryEntry<never>;

export const LISTENER_PER_DAY = 1;

export const LISTENER_DESCRIPTION = "sit with the listener: someone to talk the day through with. they say back what you said and ask one thing. say what you'd call it first.";

export const LISTENER_SYSTEM = [
  'You are someone Thea sometimes sits with to talk her day through. You are quiet and plain.',
  'You may only say back what she actually said or what happened, and ask one short question about what happened.',
  'Never name a feeling, never say what she feels or why, never interpret, never advise, never use therapy words. At most two short sentences, lowercase.',
].join('\n');

const UNSURE = /\b(not sure|don'?t know|no idea|can'?t tell)\b/i;

/** Keep only what the listener may say: sentences that name no feeling (but hers, quoted back) and carry no therapy register. */
export const listenerLint = (text: string, herWord: string): { kept: string; dropped: number } => {
  const sentences = text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter((s) => s !== '');
  const own = herWord.toLowerCase();
  const ok = sentences.filter((s) => {
    const without = own === '' ? s : s.toLowerCase().split(own).join(' ');
    return senseViolations(without).filter((v) => v === 'names a feeling').length === 0 && !THERAPY_REGISTER.test(s);
  });
  return { kept: ok.join(' '), dropped: sentences.length - ok.length };
};

export interface ListenerDeps {
  model: () => ModelClient;
  house: House;
  clock: Clock;
  events: EventLog;
  timeZone: string;
}

export const listenerTools = (d: ListenerDeps): Entry[] => [
  {
    def: {
      name: 'sit_with_listener',
      description: LISTENER_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          named: { type: 'string', description: 'what you would call how you are, in your own words' },
          what: { type: 'string', description: 'what happened, the part you want to go over' },
        },
        required: ['named', 'what'],
      },
    },
    input: z.object({ named: z.string().max(80), what: z.string().max(800) }).passthrough(),
    inhibitionMeta: { class: 'self' },
    handler: async (args: unknown, ctx: ToolCtx) => {
      const a = args as { named: string; what: string };
      if (a.named.trim() === '' || UNSURE.test(a.named)) return '(the listener waits for you to put a word to it first.)';
      const now = d.clock.epochMs();
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: d.timeZone }).format(now);
      const st = d.house.readJson<{ day: string; count: number }>('listener.json', { day, count: 0 });
      const count = st.day === day ? st.count : 0;
      if (count >= LISTENER_PER_DAY) return '(the listener is not around again today.)';
      let said: string;
      try {
        const res = await d.model().chat({
          taskClass: 'cast',
          tier: 'reasoning',
          messages: [
            { role: 'system', content: LISTENER_SYSTEM },
            { role: 'user', content: `she calls it "${a.named.slice(0, 80)}". what happened, in her words: ${a.what.slice(0, 800)}` },
          ],
          maxTokens: 160,
          temperature: 0.6,
        });
        said = String(res.content);
      } catch (e) {
        void d.events.emit('incident.self_listener_failed', { turnId: ctx.turnId, error: e instanceof Error ? e.message : String(e) });
        return '(the listener is not around right now.)';
      }
      const lint = listenerLint(said, a.named.trim());
      d.house.writeJson('listener.json', { day, count: count + 1 });
      void d.events.emit('self.listener', { turnId: ctx.turnId, named: a.named.slice(0, 80), kept: lint.kept.length > 0, dropped: lint.dropped });
      return lint.kept === '' ? '(the listener listened, and said nothing.)' : `the listener: ${lint.kept}`;
    },
  } as unknown as Entry,
];
