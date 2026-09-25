// v9 body — the OpenAI senses and voice: eyes (vision), ears (transcription +
// listening for how he sounds), mouth (speech). One small client over fetch,
// injected so tests script it. Keys ride headers only and never reach an error.

import type { BodyCfg } from './types.js';

export interface OpenAIBody {
  /** Look at one or more images and answer the prompt. */
  vision(images: ReadonlyArray<{ bytes: Uint8Array; mime: string }>, prompt: string, maxTokens?: number): Promise<string>;
  /** His words, verbatim. */
  transcribe(bytes: Uint8Array, filename: string, mime: string): Promise<string>;
  /** Listen to a wav (16 kHz mono) and answer the prompt about HOW it sounds. */
  listen(wav: Uint8Array, prompt: string): Promise<string>;
  /** Speak text in her voice; returns Ogg/Opus bytes (Telegram's voice-note format). */
  speak(text: string, instructions?: string | undefined): Promise<Uint8Array>;
}

const TIMEOUT_MS = 90_000;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export class OpenAIBodyError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    detail: string,
  ) {
    super(`openai ${op}: HTTP ${status} ${detail.slice(0, 300)}`);
  }
}

export const openAIBody = (cfg: Pick<BodyCfg, 'openaiKey' | 'openaiEndpoint' | 'visionModel' | 'transcribeModel' | 'listenModel' | 'ttsModel' | 'ttsVoice'>, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): OpenAIBody => {
  const base = cfg.openaiEndpoint.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${cfg.openaiKey}` };
  const scrub = (t: string): string => (cfg.openaiKey === '' ? t : t.split(cfg.openaiKey).join('***'));

  const chat = async (op: string, body: Record<string, unknown>): Promise<string> => {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new OpenAIBodyError(op, res.status, scrub(text));
    const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = j.choices?.[0]?.message?.content;
    return typeof c === 'string' ? c.trim() : '';
  };

  return {
    vision: (images, prompt, maxTokens = 500) =>
      chat('vision', {
        model: cfg.visionModel,
        max_completion_tokens: maxTokens,
        ...(cfg.visionModel.startsWith('gpt-5') ? { reasoning_effort: 'none' } : {}),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${b64(im.bytes)}` } })),
            ],
          },
        ],
      }),

    transcribe: async (bytes, filename, mime) => {
      const form = new FormData();
      form.append('model', cfg.transcribeModel);
      form.append('file', new Blob([Uint8Array.from(bytes)], { type: mime }), filename);
      const res = await fetchImpl(`${base}/audio/transcriptions`, { method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      if (!res.ok) throw new OpenAIBodyError('transcribe', res.status, scrub(text));
      const j = JSON.parse(text) as { text?: unknown };
      return typeof j.text === 'string' ? j.text.trim() : '';
    },

    listen: (wav, prompt) =>
      chat('listen', {
        model: cfg.listenModel,
        modalities: ['text'],
        max_completion_tokens: 120,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_audio', input_audio: { data: b64(wav), format: 'wav' } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),

    speak: async (text, instructions) => {
      const res = await fetchImpl(`${base}/audio/speech`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.ttsModel,
          voice: cfg.ttsVoice,
          input: text.slice(0, 4000),
          response_format: 'opus',
          ...(instructions !== undefined && instructions !== '' ? { instructions } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new OpenAIBodyError('speak', res.status, scrub(await res.text()));
      return new Uint8Array(await res.arrayBuffer());
    },
  };
};
