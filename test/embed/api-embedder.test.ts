import { describe, expect, it } from 'vitest';
import { type ApiResponse, type FetchImpl, makeApiEmbedder } from '../../src/embed/api-embedder.js';
import { DEFAULT_EMBED_DIM } from '../../src/embed/types.js';

const CONFIG = {
  baseUrl: 'https://api.example.com/v1',
  model: 'bge-small-en-v1.5',
  apiKey: 'test-key-not-a-secret',
  dim: 2,
};

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

/** Fake transport: no network, no global fetch — the seam the module is built on. */
const makeTransport = (respond: (call: Call) => Promise<ApiResponse> | ApiResponse): {
  calls: Call[];
  impl: FetchImpl;
} => {
  const calls: Call[] = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      return respond({ url, init });
    },
  };
};

const jsonResponse = (status: number, body: unknown): ApiResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'nope',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const embeddings = (...rows: number[][]): ApiResponse =>
  jsonResponse(200, { data: rows.map((embedding, index) => ({ index, embedding })) });

describe('makeApiEmbedder', () => {
  it('AC: satisfies the Embedder contract — dim, batch order preserved, L2-normalized output', async () => {
    const t = makeTransport(() => embeddings([6, 8], [3, 4]));
    const emb = makeApiEmbedder({ ...CONFIG, fetchImpl: t.impl });
    expect(emb.dim).toBe(2);
    const vs = await emb.embed(['alpha', 'beta']);
    // Float32Array output: compare at f32-attainable precision (6), not float64.
    for (const v of vs) {
      expect(v[0]).toBeCloseTo(0.6, 6);
      expect(v[1]).toBeCloseTo(0.8, 6);
    }
  });

  it('sends the exact wire shape: POST <baseUrl>/embeddings, bearer key, canonical body', async () => {
    // Two vectors: the fixture must match the two-text batch (count is validated first).
    const t = makeTransport(() => embeddings([1, 0], [0, 1]));
    const emb = makeApiEmbedder({ ...CONFIG, fetchImpl: t.impl });
    await emb.embed(['alpha', 'beta']);
    expect(t.calls).toHaveLength(1);
    const call = t.calls[0]!;
    expect(call.url).toBe('https://api.example.com/v1/embeddings');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer test-key-not-a-secret',
    });
    // canonicalJson ⇒ sorted keys, no whitespace, byte-stable.
    expect(call.init.body).toBe('{"input":["alpha","beta"],"model":"bge-small-en-v1.5"}');
  });

  it('reorders by the wire `index` field so output order matches input order', async () => {
    const t = makeTransport(() =>
      jsonResponse(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );
    const emb = makeApiEmbedder({ ...CONFIG, fetchImpl: t.impl });
    const vs = await emb.embed(['first', 'second']);
    expect(vs.map((v) => [...v!])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('without wire `index` fields, array order is taken as input order', async () => {
    const t = makeTransport(() =>
      jsonResponse(200, { data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }),
    );
    const emb = makeApiEmbedder({ ...CONFIG, fetchImpl: t.impl });
    const vs = await emb.embed(['first', 'second']);
    expect(vs[0]![0]).toBe(1);
    expect(vs[1]![1]).toBe(1);
  });

  it('empty batch returns [] and never touches the transport', async () => {
    const t = makeTransport(() => embeddings());
    const emb = makeApiEmbedder({ ...CONFIG, fetchImpl: t.impl });
    expect(await emb.embed([])).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it('identity includes host and model, so a swap is visible to index metadata', () => {
    const t = makeTransport(() => embeddings([1, 0]));
    expect(makeApiEmbedder({ ...CONFIG, fetchImpl: t.impl }).id).toBe('api:api.example.com/bge-small-en-v1.5');
    expect(
      makeApiEmbedder({ ...CONFIG, fetchImpl: t.impl, baseUrl: 'https://other.example.com/v1' }).id,
    ).toBe('api:other.example.com/bge-small-en-v1.5');
  });

  it('defaults dim to bge-small 384', () => {
    const t = makeTransport(() => jsonResponse(200, { data: [{ embedding: Array(384).fill(0.1) }] }));
    const emb = makeApiEmbedder({ baseUrl: 'https://api.example.com', model: 'm', apiKey: 'k', fetchImpl: t.impl });
    expect(emb.dim).toBe(DEFAULT_EMBED_DIM);
  });

  it('AC: error mapping — transport throw, auth, rate limit, upstream, http, shape, dim', async () => {
    const cases: Array<{
      name: string;
      respond: (call: Call) => Promise<ApiResponse> | ApiResponse;
      code: string;
    }> = [
      {
        name: 'transport throws ⇒ embed/network',
        respond: () => {
          throw new Error('ECONNREFUSED');
        },
        code: 'embed/network',
      },
      { name: '401 ⇒ embed/auth', respond: () => jsonResponse(401, { error: 'bad key' }), code: 'embed/auth' },
      { name: '403 ⇒ embed/auth', respond: () => jsonResponse(403, {}), code: 'embed/auth' },
      {
        name: '429 ⇒ embed/rate-limited',
        respond: () => jsonResponse(429, {}),
        code: 'embed/rate-limited',
      },
      { name: '503 ⇒ embed/upstream', respond: () => jsonResponse(503, {}), code: 'embed/upstream' },
      { name: '400 ⇒ embed/http', respond: () => jsonResponse(400, {}), code: 'embed/http' },
      { name: 'non-JSON body ⇒ embed/response-shape', respond: () => jsonResponse(200, { oops: true }), code: 'embed/response-shape' },
      {
        name: 'count mismatch ⇒ embed/response-shape',
        respond: () => embeddings([1, 0]),
        code: 'embed/response-shape',
      },
      {
        name: 'missing embedding array ⇒ embed/response-shape',
        respond: () => jsonResponse(200, { data: [{ index: 0 }] }),
        code: 'embed/response-shape',
      },
      {
        name: 'non-finite component ⇒ embed/response-shape',
        respond: () => jsonResponse(200, { data: [{ index: 0, embedding: [1, null] }] }),
        code: 'embed/response-shape',
      },
      {
        name: 'wrong dim ⇒ embed/dim-mismatch',
        // Two vectors (count must match) whose dim is 3 against the configured 2.
        respond: () => embeddings([1, 0, 0], [0, 1, 0]),
        code: 'embed/dim-mismatch',
      },
    ];
    for (const c of cases) {
      const t = makeTransport(c.respond);
      const emb = makeApiEmbedder({ ...CONFIG, fetchImpl: t.impl });
      // `embed` is async and fail() throws inside it — assert on the rejection.
      await expect(emb.embed(['a', 'b'])).rejects.toThrowError(
        expect.objectContaining({ code: c.code }),
      );
    }
  });

  it('config errors are typed and raised before any request is built', () => {
    const t = makeTransport(() => embeddings([1, 0]));
    const base = {
      baseUrl: 'https://api.example.com',
      model: 'm',
      apiKey: 'k',
      fetchImpl: t.impl,
      dim: 2,
    };
    expect(() => makeApiEmbedder({ ...base, baseUrl: '' })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
    expect(() => makeApiEmbedder({ ...base, baseUrl: 'not a url' })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
    expect(() => makeApiEmbedder({ ...base, model: '' })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
    expect(() => makeApiEmbedder({ ...base, apiKey: '' })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
    expect(() => makeApiEmbedder({ ...base, dim: 0 })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
    expect(t.calls).toHaveLength(0);
  });
});
