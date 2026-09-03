// Door latency smoke — streaming, real-sized packet, decide tool.
// Measures TTFT (first visible token or tool-arg delta), total, output tokens,
// stop reason, and whether a decide tool call arrived. Keys from env only.
import fs from 'node:fs';
import yaml from 'js-yaml';

const ZAI = process.env.THEA2_MODEL_API_KEY || '';
const NW = process.env.THEA2_NEURALWATT_KEY || '';
const promptFile = process.argv[2] || '/tmp/rendered-prompt.txt';
const only = process.argv[3] || '';
const raw = fs.readFileSync(promptFile, 'utf8');
const parts = raw.split(/^----- role: (\w+) -----$/m).slice(1);
const msgs = [];
for (let i = 0; i < parts.length; i += 2) msgs.push({ role: parts[i], content: parts[i + 1].trim() });
const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
const convo = msgs.filter(m => m.role !== 'system');
// Replace the last user line with a live-like question.
convo[convo.length - 1] = { role: 'user', content: 'how are you feeling?' };

const decide = {
  name: 'decide',
  description: 'Lock your decision for this turn. Call it once, last. bubbles = the messages to send, in order (empty unless plan is reply).',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', enum: ['reply', 'silent', 'defer'] },
      bubbles: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      weight: { type: 'number', minimum: 0, maximum: 1 },
      reluctance: { type: 'number', minimum: 0, maximum: 1 },
      completeness: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['plan', 'bubbles', 'confidence', 'weight', 'reluctance', 'completeness'],
  },
};

const cases = [
  // ---- z.ai anthropic door ----
  { door: 'zai', model: 'glm-5.3-flash', label: 'prod-today(no thinking field)', extra: {} },
  { door: 'zai', model: 'glm-5.3-flash', label: 'effort=low', extra: { thinking: { type: 'enabled' }, reasoning_effort: 'low' } },
  { door: 'zai', model: 'glm-5.3-flash', label: 'effort=low+forced-decide', extra: { thinking: { type: 'enabled' }, reasoning_effort: 'low' }, force: true },
  { door: 'zai', model: 'glm-5.3-flash', label: 'budget_tokens=256', extra: { thinking: { type: 'enabled', budget_tokens: 256 } } },
  { door: 'zai', model: 'glm-5.3-flash', label: 'effort=low temp0.9 top_p0.95', extra: { thinking: { type: 'enabled' }, reasoning_effort: 'low', temperature: 0.9, top_p: 0.95 } },
  { door: 'zai', model: 'glm-5.3', label: 'effort=low+forced-decide', extra: { thinking: { type: 'enabled' }, reasoning_effort: 'low' }, force: true },
  // ---- neuralwatt openai door ----
  { door: 'nw', model: 'glm-5.3', label: 'effort=low', extra: { reasoning_effort: 'low' } },
  { door: 'nw', model: 'glm-5.3', label: 'effort=none', extra: { reasoning_effort: 'none' } },
  { door: 'nw', model: 'deepseek-v4-flash', label: 'effort=none', extra: { reasoning_effort: 'none' } },
  { door: 'nw', model: 'deepseek-v4-flash', label: 'effort=none+forced-decide', extra: { reasoning_effort: 'none' }, force: true },
  { door: 'nw', model: 'qwen3.6-35b-fast', label: 'effort=none', extra: { reasoning_effort: 'none' } },
  { door: 'nw', model: 'glm-5.2-fast', label: 'effort=none', extra: { reasoning_effort: 'none' } },
  { door: 'nw', model: 'kimi-k3-fast', label: 'effort=none', extra: { reasoning_effort: 'none' } },
  { door: 'nw', model: 'gemma-4-31b', label: 'no-effort-field', extra: {} },
];

const now = () => Date.now();
const out = [];

async function runZai(c) {
  const body = {
    model: c.model, max_tokens: 3072, temperature: 0.7, stream: true,
    system, messages: convo,
    tools: [{ name: decide.name, description: decide.description, input_schema: decide.parameters }],
    ...(c.force ? { tool_choice: { type: 'tool', name: 'decide' } } : {}),
    ...c.extra,
  };
  const t0 = now();
  const res = await fetch(c.url ?? 'https://api.z.ai/api/anthropic/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': c.key ?? ZAI, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) return { status: res.status, err: (await res.text()).slice(0, 200) };
  let ttft = null, ttfThink = null, stop = '?', outTok = '?', inTok = '?', text = '', toolArgs = '', thinkChars = 0, sawTool = false;
  for await (const ev of sse(res.body)) {
    const j = JSON.parse(ev);
    if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') sawTool = true;
    if (j.type === 'content_block_delta') {
      const d = j.delta;
      if (d.type === 'thinking_delta') { thinkChars += (d.thinking || '').length; if (ttfThink === null) ttfThink = now() - t0; }
      if (d.type === 'text_delta') { text += d.text; if (ttft === null) ttft = now() - t0; }
      if (d.type === 'input_json_delta') { toolArgs += d.partial_json; if (ttft === null) ttft = now() - t0; }
    }
    if (j.type === 'message_delta') { stop = j.delta?.stop_reason ?? stop; outTok = j.usage?.output_tokens ?? outTok; inTok = j.usage?.input_tokens ?? inTok; }
    if (j.type === 'message_start') { inTok = j.message?.usage?.input_tokens ?? inTok; }
  }
  return { status: 200, ttft, ttfThink, total: now() - t0, stop, inTok, outTok, thinkChars, sawTool, sample: (toolArgs || text).replace(/\s+/g, ' ').slice(0, 160) };
}

async function runNw(c) {
  const body = {
    model: c.model, max_tokens: 3072, temperature: 0.7, stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'system', content: system }, ...convo],
    tools: [{ type: 'function', function: { name: decide.name, description: decide.description, parameters: decide.parameters } }],
    ...(c.force ? { tool_choice: { type: 'function', function: { name: 'decide' } } } : {}),
    ...c.extra,
  };
  const t0 = now();
  const res = await fetch(c.url ?? 'https://api.neuralwatt.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key ?? NW}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) return { status: res.status, err: (await res.text()).slice(0, 200) };
  let ttft = null, ttfThink = null, stop = '?', outTok = '?', inTok = '?', text = '', toolArgs = '', thinkChars = 0, sawTool = false;
  for await (const ev of sse(res.body)) {
    if (ev.trim() === '[DONE]') break;
    let j; try { j = JSON.parse(ev); } catch { continue; }
    const ch = j.choices?.[0];
    const d = ch?.delta || {};
    const rc = d.reasoning_content || d.reasoning;
    if (rc) { thinkChars += rc.length; if (ttfThink === null) ttfThink = now() - t0; }
    if (d.content) { text += d.content; if (ttft === null) ttft = now() - t0; }
    if (d.tool_calls) { sawTool = true; for (const tc of d.tool_calls) { toolArgs += tc.function?.arguments || ''; } if (ttft === null) ttft = now() - t0; }
    if (ch?.finish_reason) stop = ch.finish_reason;
    if (j.usage) { outTok = j.usage.completion_tokens ?? outTok; inTok = j.usage.prompt_tokens ?? inTok; }
  }
  return { status: 200, ttft, ttfThink, total: now() - t0, stop, inTok, outTok, thinkChars, sawTool, sample: (toolArgs || text).replace(/\s+/g, ' ').slice(0, 160) };
}

async function* sse(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
      if (data) yield data;
    }
  }
}

// ---- standing gate (v7 M.2): `npm run door:smoke -- --gate` ----
// Reads models.doors.voice from thea2.config.yaml, makes 3 streaming decide
// calls over the door's own wire, fails (exit 1) if p50 TTFT > 4 s or any call
// errors. Runs where the keys live (VPS), never in CI.
const GATE_MS = 4000, GATE_CALLS = 3;

async function gateVoice() {
  const cfg = yaml.load(fs.readFileSync(new URL('../thea2.config.yaml', import.meta.url), 'utf8'));
  const door = cfg.models?.doors?.voice;
  if (!door) { console.error('gate FAIL: thea2.config.yaml has no models.doors.voice'); return 2; }
  const key = process.env[door.keyEnv || ''] || '';
  if (!key) { console.error(`gate FAIL: env ${door.keyEnv || '(unset keyEnv)'} is empty - keys live in /etc/thea2/keys.env on the VPS`); return 2; }
  const base = (door.endpoint || '').replace(/\/$/, '');
  const extra = {};
  if (door.protocol === 'anthropic') {
    extra.thinking = { type: 'enabled', ...(door.thinkingBudget ? { budget_tokens: door.thinkingBudget } : {}) };
  } else {
    const eff = door.effort && door.effort !== 'none' ? door.effort
      : (/glm-5/.test(door.model) ? 'minimal' : undefined);
    if (eff) extra.reasoning_effort = eff;
  }
  if (door.temperature !== undefined) extra.temperature = door.temperature;
  if (door.topP !== undefined) extra.top_p = door.topP;
  const force = door.forcing === 'tool_choice';
  const c = {
    door: 'voice', model: door.model, label: 'gate', extra, force,
    url: door.protocol === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`,
    key,
  };
  const ttfts = [];
  for (let i = 0; i < GATE_CALLS; i++) {
    let r;
    try { r = await (door.protocol === 'anthropic' ? runZai(c) : runNw(c)); }
    catch (e) { r = { status: 0, err: String(e.message || e).slice(0, 160) }; }
    const line = `gate ${i + 1}/${GATE_CALLS} ${door.model.padEnd(18)} ` +
      (r.err ? `HTTP ${r.status} ERR ${r.err}` :
        `ttft=${String(r.ttft).padStart(6)}ms total=${String(r.total).padStart(6)}ms stop=${String(r.stop).padEnd(10)} tool=${r.sawTool}`);
    console.log(line);
    if (r.err || r.ttft === null || r.ttft === undefined) { console.error('gate FAIL: a call errored or never produced first output'); return 1; }
    ttfts.push(r.ttft);
  }
  ttfts.sort((a, b) => a - b);
  const p50 = ttfts[Math.floor((ttfts.length - 1) / 2)];
  const ok = p50 <= GATE_MS;
  console.log(`gate: voice=${door.model}@${door.endpoint} p50 TTFT ${p50}ms over ${GATE_CALLS} calls (cap ${GATE_MS}ms) -> ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

if (process.argv.includes('--gate')) { process.exit(await gateVoice()); }

for (const c of cases) {
  if (only && !(c.door + ':' + c.model + ':' + c.label).includes(only)) continue;
  let r;
  try { r = await (c.door === 'zai' ? runZai(c) : runNw(c)); } catch (e) { r = { status: 0, err: String(e.message || e).slice(0, 160) }; }
  const line = `${c.door.padEnd(3)} ${c.model.padEnd(18)} ${c.label.padEnd(30)} ` +
    (r.err ? `HTTP ${r.status} ERR ${r.err}` :
      `ttft=${String(r.ttft).padStart(6)}ms think-start=${String(r.ttfThink).padStart(6)}ms total=${String(r.total).padStart(6)}ms stop=${String(r.stop).padEnd(10)} in=${r.inTok} out=${r.outTok} thinkChars=${r.thinkChars} tool=${r.sawTool} | ${r.sample}`);
  console.log(line);
  out.push({ ...c, ...r });
}
fs.writeFileSync('/tmp/door-smoke.json', JSON.stringify(out, null, 1));
