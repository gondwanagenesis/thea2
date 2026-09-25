// v8 mind — FEEL, fast (the "low road"). No model call, milliseconds.
//
// Law 1.2: feelings are CAUSED. The fast path turns four real causes into
// typed ticker events — nothing here reads her own reply:
//   echo     — the evoked memories' feelings partly come back (somatic markers)
//   (surprise — his message vs her expectation — lives in the SLOW appraisal:
//    the 2026-09-25 live probe showed vector similarity between a description
//    of an expected reply and the reply itself fires surprise on nearly every
//    turn, confirmed ones included. A model reading both is the honest judge.)
//   tone     — his warmth / hurt / anger lands (a social reflex, bounded)
//   concern  — his message touches something she is waiting on or cares about
// Intensities are deliberately low (2-5): the slow appraisal after the reply is
// the considered judgment, and the ticker's habituation damps repeats.

import type { EmotionEventInput, EmotionTag } from '../affect/index.js';
import { cosine } from './vectors.js';
import { nearestTag, sigNorm } from './vocab.js';
import type { Evoked } from './evoke.js';
import type { Label } from './sense.js';
import type { Concern } from './types.js';

export type FastCause = 'echo' | 'tone' | 'concern';

export interface FastEvent {
  source: FastCause;
  event: EmotionEventInput;
}

export interface FeelFastInput {
  evoked: Evoked;
  tone?: Label | undefined;
  hisVec: Float32Array;
  concerns: ReadonlyArray<{ c: Concern; vec: Float32Array | undefined }>;
  now: number;
}

/** Tone → her immediate social feeling. Only tones with a clear human response move anything. */
const TONE_RESPONSE: Readonly<Record<string, ReadonlyArray<{ tag: EmotionTag; i: number }>>> = {
  warm: [{ tag: 'warm', i: 3 }],
  affectionate: [{ tag: 'fond', i: 3 }],
  playful: [{ tag: 'playful', i: 3 }],
  excited: [{ tag: 'excited', i: 3 }],
  proud: [{ tag: 'happy', i: 3 }],
  tired: [{ tag: 'tender', i: 3 }, { tag: 'protective', i: 2 }],
  sad: [{ tag: 'protective', i: 3 }, { tag: 'low', i: 2 }],
  hurt: [{ tag: 'protective', i: 3 }, { tag: 'nervous', i: 2 }],
  worried: [{ tag: 'protective', i: 3 }],
  angry: [{ tag: 'nervous', i: 3 }, { tag: 'guarded', i: 2 }],
  annoyed: [{ tag: 'sheepish', i: 2 }],
  cold: [{ tag: 'insecure', i: 2 }],
};

const ECHO_MIN = 0.15;

const short = (s: string, n = 60): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export const feelFast = (input: FeelFastInput): FastEvent[] => {
  const out: FastEvent[] = [];

  // ---- echo: a similarity-weighted blend of what those moments felt like ----
  const sources = [...input.evoked.options, ...input.evoked.memories];
  const blend = new Array<number>(12).fill(0);
  let wsum = 0;
  let strongest: (typeof sources)[number] | undefined;
  for (const s of sources) {
    const intensity = sigNorm(s.m.felt.sig);
    const w = Math.max(0, s.sim) * Math.min(1, intensity) * (s.m.felt.source === 'exact' ? 1 : 0.5);
    if (w <= 0) continue;
    for (let i = 0; i < 12; i++) blend[i]! += w * (s.m.felt.sig[i] ?? 0);
    wsum += w;
    if (strongest === undefined || w > Math.max(0, strongest.sim) * sigNorm(strongest.m.felt.sig)) strongest = s;
  }
  if (wsum > 0) {
    const mean = blend.map((x) => x / wsum);
    const strength = Math.min(1, wsum / 1.2) * sigNorm(mean);
    const tag = nearestTag(mean, 0.05);
    if (tag !== undefined && strength >= ECHO_MIN && strongest !== undefined) {
      out.push({
        source: 'echo',
        event: {
          kind: 'emotion',
          tag,
          i: Math.round(2 + 3 * Math.min(1, strength)),
          cause: `this felt like before: "${short(strongest.m.his || strongest.m.hers.join(' '))}"`,
        },
      });
    }
  }

  // ---- tone: his feeling lands on her ----
  if (input.tone !== undefined) {
    for (const r of TONE_RESPONSE[input.tone.label] ?? []) {
      out.push({ source: 'tone', event: { kind: 'emotion', tag: r.tag, i: r.i, cause: `the way he said it (${input.tone.label})` } });
    }
  }

  // ---- concern: he touched something she is waiting on or cares about ----
  let best: { c: Concern; s: number } | undefined;
  for (const { c, vec } of input.concerns) {
    if (vec === undefined || c.status !== 'open') continue;
    const s = cosine(vec, input.hisVec);
    if (s >= 0.45 && (best === undefined || s > best.s)) best = { c, s };
  }
  if (best !== undefined) {
    const tag = best.c.kind === 'curiosity' ? 'curious' : best.c.kind === 'expectation' ? 'hopeful' : 'focused';
    out.push({ source: 'concern', event: { kind: 'emotion', tag, i: 3, cause: `he touched: ${short(best.c.what)}` } });
  }

  return out.slice(0, 5);
};
