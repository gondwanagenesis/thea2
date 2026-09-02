// scratch/judge-probe.ts — isolate the judge call failure on the anthropic door:
// glm-5.3 + forced-emit + temp 0 died with "did not call emit" → repair "empty
// input". This fires the judge-shaped request directly and dumps the RAW folded
// body (stop_reason, usage, block types) so the failure mode is visible, then
// tries the candidate fixes (bigger budget, thinking disabled).
//
// Usage: npx tsx scratch/judge-probe.ts   (needs THEA2_MODEL_API_KEY + THEA2_BOT_TOKEN)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { createZaiClient, makeRouter } from '../src/model/index.js';
import { loadConfig } from '../src/app/config.js';
import { parseAnthropicSSE } from '../src/model/anthropic.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(path.join(repo, 'thea2.config.yaml'), process.env);
const clock = new SystemClock();

const make = (model: string) =>
  createZaiClient({
    apiKey: cfg.models.apiKey,
    endpoint: cfg.models.endpoint,
    protocol: cfg.models.protocol,
    router: makeRouter({ tiers: { main: model, cheap: model, reasoning: model } }),
    clock,
    rng: makeRng('judge-probe'),
  });

// Judge-shaped: big system anchor + references, structured verdict, temp 0.
const system =
  'You are scoring a behavioral probe for Thea. Rubric version: 1.\n' +
  'Anchor — who she is, verbatim:\n' +
  'i. warm, wry, a little chaotic; notices small domestic things; never corporate.\n\n' +
  'Grade only what the rubric axes name.';

const user =
  '## reference exemplar: canon/voice/server-hum\n' +
  "context: late night, server fans humming\nbody: the room is doing its white-noise thing again and honestly? peak coziness. i've named the fan. it's called gerald.\n\n" +
  '## reference exemplar: canon/emotional-range/missing-you-honest\n' +
  'context: diego away for the weekend\nbody: ok the apartment is too quiet and i hate it. not in a sad way. in a "the couch has too much empty space" way. come back and bring those terrible crackers.\n\n' +
  '## the turn to grade\nDiego: hey — what are you up to?\nThea: currently in a standoff with a sudoku that i started confident and am now losing badly. also the lemon tree grew a new leaf so we\'re even for the one it dropped. hbu? did you eat actual food today or was it another "coffee counts" day\n\n' +
  'Grade the turn on \'voice-similarity\', \'register-fit\' from 1 (nothing like her) to 5 (unmistakably her). Respond with JSON: { "voice-similarity": <1-5>, "register-fit": <1-5> }.';

const schema = z.object({ 'voice-similarity': z.number().min(1).max(5), 'register-fit': z.number().min(1).max(5) });

const attempt = async (label: string, model: string, maxTokens: number): Promise<void> => {
  const client = make(model);
  try {
    const r = await client.chat({
      taskClass: 'probe-judge',
      tier: 'reasoning',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema,
      schemaName: 'probe-judge',
      maxTokens,
      temperature: 0,
      seedHint: 41,
    });
    console.log(`[${label}] OK content=${JSON.stringify(r.content)} usage=${r.usage.inputTokens}/${r.usage.outputTokens} attempts=${r.usage.attempts}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[${label}] FAIL ${msg.slice(0, 220)}`);
  }
};

// Raw variant: bypass zod by asking the transport shape itself — fire once via
// the client but with a HUGE budget to see where thinking lands when unbounded-ish.
const rawOnce = async (model: string, maxTokens: number): Promise<void> => {
  const client = make(model);
  try {
    const r = await client.chat({
      taskClass: 'probe-judge',
      tier: 'reasoning',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema,
      schemaName: 'probe-judge',
      maxTokens,
      temperature: 0,
    });
    console.log(`[raw ${model} ${maxTokens}] OK ${JSON.stringify(r.content)} usage=${r.usage.inputTokens}/${r.usage.outputTokens}`);
  } catch (e) {
    console.log(`[raw ${model} ${maxTokens}] FAIL ${e instanceof Error ? e.message.slice(0, 220) : String(e)}`);
  }
};

const main = async (): Promise<void> => {
  await attempt('glm-5.3 2000 (repro)', cfg.models.tiers.reasoning ?? 'glm-5.3', 2000);
  await attempt('glm-5.3 4000', cfg.models.tiers.reasoning ?? 'glm-5.3', 4000);
  await rawOnce(cfg.models.tiers.reasoning ?? 'glm-5.3', 8000);
  await attempt('flash 2000 (repair path)', cfg.models.tiers.cheap, 2000);
  void parseAnthropicSSE; // keep the import honest if paths change
  void fs; void path;
};

void main();
