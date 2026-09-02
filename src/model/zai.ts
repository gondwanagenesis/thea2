// M03 model — the real client: Z.ai's OpenAI-compatible chat endpoint.
// Composition only — every behavior lives in transport.ts / client.ts.

import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import { chatCore, createModelClient } from './client.js';
import { zaiTransport } from './transport.js';
import type { BackoffConfig } from './tiers.js';
import type { EndpointCapabilities, ModelClient, ModelRouter } from './types.js';

export interface ZaiClientDeps {
  /** Bearer token, injected (M20 passes process.env.ZAI_API_KEY). Never read env here. */
  apiKey: string;
  log: EventLog;
  router: ModelRouter;
  clock: Clock;
  /** Backoff jitter; fork a dedicated stream so retries don't perturb other draws. */
  rng: Rng;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoff?: BackoffConfig;
  capabilities?: EndpointCapabilities;
  /** Wire protocol (default openai): 'anthropic' = z.ai coding-plan door. */
  protocol?: 'openai' | 'anthropic';
}

export const createZaiClient = (deps: ZaiClientDeps): ModelClient =>
  createModelClient({
    log: deps.log,
    clock: deps.clock,
    ...(deps.capabilities !== undefined ? { capabilities: deps.capabilities } : {}),
    core: chatCore({
      router: deps.router,
      ...(deps.capabilities !== undefined ? { capabilities: deps.capabilities } : {}),
      ...(deps.protocol !== undefined ? { protocol: deps.protocol } : {}),
      send: zaiTransport({
        apiKey: deps.apiKey,
        clock: deps.clock,
        rng: deps.rng,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.endpoint !== undefined ? { endpoint: deps.endpoint } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.maxRetries !== undefined ? { maxRetries: deps.maxRetries } : {}),
        ...(deps.backoff !== undefined ? { backoff: deps.backoff } : {}),
        ...(deps.protocol !== undefined ? { protocol: deps.protocol } : {}),
      }),
    }),
  });
