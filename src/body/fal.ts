// v9 body — fal.ai: her camera and her video. Images run on the synchronous
// endpoint (fal.run, ~5-30 s); video runs on the queue (queue.fal.run) and is
// polled on the injected Clock. The key rides the header and never an error.

import type { Clock } from '../kernel/index.js';

export interface Fal {
  image(model: string, input: Record<string, unknown>): Promise<{ bytes: Uint8Array; url: string; seed?: number | undefined }>;
  video(model: string, input: Record<string, unknown>, opts?: { maxWaitMs?: number | undefined }): Promise<{ bytes: Uint8Array; url: string }>;
}

const IMAGE_TIMEOUT_MS = 180_000;
const POLL_MS = 5_000;

export class FalError extends Error {}

export const makeFal = (key: string, clock: Clock, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Fal => {
  const auth = { authorization: `Key ${key}` };
  const scrub = (t: string): string => (key === '' ? t : t.split(key).join('***')).slice(0, 300);
  const download = async (url: string): Promise<Uint8Array> => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!r.ok) throw new FalError(`download ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  return {
    image: async (model, input) => {
      const res = await fetchImpl(`https://fal.run/${model}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) throw new FalError(`fal ${model}: HTTP ${res.status} ${scrub(text)}`);
      const j = JSON.parse(text) as { images?: Array<{ url?: string }>; seed?: number };
      const url = j.images?.[0]?.url;
      if (typeof url !== 'string') throw new FalError(`fal ${model}: no image in the response`);
      return { bytes: await download(url), url, ...(typeof j.seed === 'number' ? { seed: j.seed } : {}) };
    },
    video: async (model, input, opts) => {
      const res = await fetchImpl(`https://queue.fal.run/${model}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (!res.ok) throw new FalError(`fal ${model}: HTTP ${res.status} ${scrub(text)}`);
      const q = JSON.parse(text) as { status_url?: string; response_url?: string };
      if (typeof q.status_url !== 'string' || typeof q.response_url !== 'string') throw new FalError(`fal ${model}: no queue urls`);
      const deadline = clock.epochMs() + (opts?.maxWaitMs ?? 8 * 60_000);
      for (;;) {
        await clock.waitUntil(clock.epochMs() + POLL_MS);
        const s = await fetchImpl(q.status_url, { headers: auth, signal: AbortSignal.timeout(30_000) });
        const st = (await s.json().catch(() => ({}))) as { status?: string };
        if (st.status === 'COMPLETED') break;
        if (st.status !== 'IN_QUEUE' && st.status !== 'IN_PROGRESS') throw new FalError(`fal ${model}: status ${String(st.status)}`);
        if (clock.epochMs() > deadline) throw new FalError(`fal ${model}: still not done after ${Math.round((opts?.maxWaitMs ?? 480_000) / 60_000)} min`);
      }
      const r = await fetchImpl(q.response_url, { headers: auth, signal: AbortSignal.timeout(60_000) });
      const rt = await r.text();
      if (!r.ok) throw new FalError(`fal ${model}: result HTTP ${r.status} ${scrub(rt)}`);
      // fal marks a request COMPLETED even when validation failed; the reason is in `detail`.
      const j = JSON.parse(rt) as { video?: { url?: string }; detail?: unknown };
      const url = j.video?.url;
      if (typeof url !== 'string') throw new FalError(`fal ${model}: no video in the result${j.detail !== undefined ? ` (${scrub(JSON.stringify(j.detail))})` : ''}`);
      return { bytes: await download(url), url };
    },
  };
};
