// test/model — shared doubles. No network anywhere: chatCore tests inject a
// Transport, transport tests inject fetchImpl, and events land in a memory log.

import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import type { ChatRequest } from '../../src/model/index.js';

export const memoryLog = (): { log: EventLog; events: EventEnvelope[] } => {
  const events: EventEnvelope[] = [];
  return {
    events,
    log: {
      emit: async (kind, payload, turnId) => {
        events.push({
          seq: events.length + 1,
          ts: 0,
          kind,
          ...(turnId !== undefined ? { turnId } : {}),
          payload,
        });
      },
      async *replay(filter) {
        for (const e of events) {
          if (filter?.kinds !== undefined && !filter.kinds.includes(e.kind)) continue;
          if (filter?.sinceTs !== undefined && e.ts < filter.sinceTs) continue;
          yield e;
        }
      },
    },
  };
};

/** Tier table that makes routing visible in ids: model-main / model-cheap / model-reasoning. */
export const TEST_TIERS = {
  main: 'model-main',
  cheap: 'model-cheap',
  reasoning: 'model-reasoning',
} as const;

export const baseReq = (): ChatRequest => ({
  taskClass: 'summarize',
  tier: 'main',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  temperature: 0.7,
});

/** OpenAI-compatible success body (what zaiTransport's JSON.parse would hand back). */
export interface FakeWireResponse {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  promptTokens?: number;
  completionTokens?: number;
}

export const wireOk = (over: FakeWireResponse = {}): Record<string, unknown> => ({
  choices: [
    {
      message: {
        role: 'assistant',
        ...(over.content !== undefined ? { content: over.content } : {}),
        ...(over.toolCalls !== undefined
          ? {
              tool_calls: over.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      },
    },
  ],
  usage: {
    prompt_tokens: over.promptTokens ?? 11,
    completion_tokens: over.completionTokens ?? 7,
  },
});

export const wireError = (status: number): { ok: boolean; status: number; text: () => Promise<string> } => ({
  ok: false,
  status,
  text: async () => `HTTP ${status} body`,
});
