// W1.1 — the `thinking` door smoke: which shapes does the z.ai anthropic door
// actually accept, per tier model? Omitted / disabled / enabled 1024 / enabled
// 2048, non-streaming, one short prompt. Records status, latency, stop_reason,
// token usage. Rejects ⇒ `models.thinking: off` for that class (plan v4 §2.1).
// Key comes from env (THEA2_MODEL_API_KEY); never printed.

import { SystemClock } from '../src/kernel/index.js';

const ENDPOINT = process.env['THEA2_MODEL_ENDPOINT'] ?? 'https://api.z.ai/api/anthropic';
const KEY = process.env['THEA2_MODEL_API_KEY'] ?? '';
if (!KEY) {
  console.error('THEA2_MODEL_API_KEY missing');
  process.exit(2);
}

const clock = new SystemClock();
const MODELS = ['glm-5.3-flash', 'glm-5.3'];
type Shape = { label: string; thinking?: Record<string, unknown> };
const SHAPES: Shape[] = [
  { label: 'omitted' },
  { label: 'disabled', thinking: { type: 'disabled' } },
  { label: 'enabled-1024', thinking: { type: 'enabled', budget_tokens: 1024 } },
  { label: 'enabled-2048', thinking: { type: 'enabled', budget_tokens: 2048 } },
];

const rows: string[] = [];
for (const model of MODELS) {
  for (const shape of SHAPES) {
    const body: Record<string, unknown> = {
      model,
      max_tokens: 900,
      temperature: 0.7,
      messages: [{ role: 'user', content: 'Say hi in exactly three words.' }],
      ...(shape.thinking !== undefined ? { thinking: shape.thinking } : {}),
    };
    const t0 = clock.epochMs();
    let status = 0;
    let stopReason = '-';
    let outTokens = '-';
    let err = '';
    try {
      const res = await fetch(`${ENDPOINT.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      const text = await res.text();
      if (res.ok) {
        try {
          const doc = JSON.parse(text) as { stop_reason?: string; usage?: { output_tokens?: number } };
          stopReason = doc.stop_reason ?? '?';
          outTokens = String(doc.usage?.output_tokens ?? '?');
        } catch {
          stopReason = 'unparseable';
          err = text.slice(0, 120);
        }
      } else {
        err = text.replace(/\s+/g, ' ').slice(0, 160);
      }
    } catch (e) {
      err = String(e instanceof Error ? e.message : e).slice(0, 120);
    }
    const ms = clock.epochMs() - t0;
    const line = `${model.padEnd(14)} ${shape.label.padEnd(13)} status=${String(status).padEnd(3)} ${String(ms).padStart(6)}ms stop=${stopReason.padEnd(11)} out=${outTokens.padStart(5)} ${err ? `ERR: ${err}` : ''}`;
    rows.push(line);
    console.log(line);
  }
}
console.log('\n=== CSV ===');
console.log('model,shape,status,latency_ms,stop_reason,output_tokens');
for (const model of MODELS) {
  for (const line of rows) if (line.startsWith(model)) console.log(line);
}
