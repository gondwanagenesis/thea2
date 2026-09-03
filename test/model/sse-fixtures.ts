// test/model — recorded SSE shapes from the z.ai anthropic door (glm-5.3-flash,
// stream:true). Each fixture is the byte stream one streamed reply produced,
// trimmed to the events that matter. They pin the Phase-1 robustness rules:
// an `error` event is a typed failure, `stop_reason` rides through, and a
// max_tokens cut with nothing visible is a truncation — never an empty answer.

const lines = (...l: string[]): string => l.join('\n') + '\n';

/** A normal reply: thinking, then text, end_turn. */
export const SSE_END_TURN = lines(
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"glm-5.3-flash","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"he said hi."}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hey. "}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"you\'re up late."}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":812,"output_tokens":41}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
);

/** The starvation family: thinking ate the whole budget, no visible text, max_tokens. */
export const SSE_MAX_TOKENS_EMPTY = lines(
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"model":"glm-5.3-flash","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"okay so first let me consider what the packet says about"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the affect line and then the inhibition block and"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"input_tokens":2210,"output_tokens":2048}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
);

/** A max_tokens cut that still produced visible text: returned, stopReason set. */
export const SSE_MAX_TOKENS_WITH_CONTENT = lines(
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_3","type":"message","role":"assistant","content":[],"model":"glm-5.3-flash","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the thing about sea glass is that it takes about"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"input_tokens":640,"output_tokens":100}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
);

/** The door pushed an `error` event mid-stream (overloaded) and closed. */
export const SSE_ERROR_OVERLOADED = lines(
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_4","type":"message","role":"assistant","content":[],"model":"glm-5.3-flash","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"so"}}',
  '',
  'event: error',
  'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  '',
);

/** An `error` event whose type is the caller's fault: not worth a retry. */
export const SSE_ERROR_INVALID_REQUEST = lines(
  'event: error',
  'data: {"type":"error","error":{"type":"invalid_request_error","message":"messages: final assistant content cannot end with trailing whitespace"}}',
  '',
);

/** Builds a fetch Response whose body streams `sse` in one chunk (test double). */
export const sseResponse = (sse: string): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    text: async () => sse,
  } as unknown as Response;
};
