// M04 embed — ApiEmbedder: OpenAI-compatible POST /embeddings.
//
// The config swap for the day multilingual-e5-small is warranted (Spanish share
// of traffic) — a config change + re-embed, no code. Two laws shape it:
//
// 1. The transport is INJECTED. Module code never touches global fetch and never
//    reads process.env — baseUrl/model/apiKey/fetchImpl all arrive in cfg from
//    composition (M20). Tests inject a fake, which is why the seam exists
//    (eslint forbids fetch in tests outright).
// 2. Failures are typed KernelErrors, mapped from the transport outcome, so the
//    caller can distinguish "key wrong" from "upstream down" without parsing prose.

import { canonicalJson, fail } from '../kernel/index.js';
import type { Embedder } from './types.js';
import { DEFAULT_EMBED_DIM } from './types.js';
import { l2Normalize } from './l2.js';

/** The slice of a fetch Response this module consumes. Structurally satisfied by
 * the global fetch, so composition can pass `fetch` directly once it decides to. */
export interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface ApiRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type FetchImpl = (url: string, init: ApiRequestInit) => Promise<ApiResponse>;

export interface ApiEmbedderConfig {
  baseUrl: string;
  model: string;
  /** Injected from resolved config — never read from the environment here. */
  apiKey: string;
  fetchImpl: FetchImpl;
  dim?: number;
}

interface ApiEmbeddingItem {
  index?: unknown;
  embedding?: unknown;
}

const httpCode = (status: number): string => {
  if (status === 401 || status === 403) return 'embed/auth';
  if (status === 429) return 'embed/rate-limited';
  if (status >= 500) return 'embed/upstream';
  return 'embed/http';
};

export const makeApiEmbedder = (cfg: ApiEmbedderConfig): Embedder => {
  const dim = cfg.dim ?? DEFAULT_EMBED_DIM;
  if (!Number.isInteger(dim) || dim <= 0) {
    fail('embed/config', `ApiEmbedder dim must be a positive integer, got ${dim}`);
  }
  if (cfg.baseUrl.trim() === '') fail('embed/config', 'ApiEmbedder baseUrl is required');
  if (cfg.model.trim() === '') fail('embed/config', 'ApiEmbedder model is required');
  if (cfg.apiKey === '') fail('embed/config', 'ApiEmbedder apiKey is required — inject it from config, never the environment');

  let base: URL;
  try {
    base = new URL(cfg.baseUrl);
  } catch (e) {
    return fail('embed/config', `ApiEmbedder baseUrl is not a URL: '${cfg.baseUrl}'`, e);
  }
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/embeddings`;
  // Identity includes the host: the same model name on two deployments is not
  // the same embedding space, and index metadata must be able to see that.
  const id = `api:${base.host}/${cfg.model}`;

  return {
    id,
    dim,
    embed: async (texts: string[]): Promise<Float32Array[]> => {
      // Empty batch: nothing to embed, and no reason to spend a network call.
      if (texts.length === 0) return [];

      let res: ApiResponse;
      try {
        res = await cfg.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          // canonicalJson: byte-stable request bodies, golden-testable.
          body: canonicalJson({ model: cfg.model, input: texts }),
        });
      } catch (e) {
        return fail(
          'embed/network',
          `embedding request to ${endpoint} failed: ${e instanceof Error ? e.message : String(e)}`,
          e,
        );
      }

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        return fail(
          httpCode(res.status),
          `embedding request to ${endpoint} returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
        );
      }

      const parsed: unknown = await res
        .json()
        .catch((e: unknown) =>
          fail('embed/response-shape', `embedding response from ${endpoint} is not JSON`, e),
        );
      const data = (parsed as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        fail('embed/response-shape', `embedding response from ${endpoint} has no data[] array`);
      }
      const items = data as ApiEmbeddingItem[];
      // Honor the wire contract's `index` field when present; otherwise take the
      // array order. Either way, output order must match input order exactly.
      const indexed = items.every((it) => typeof it.index === 'number');
      const ordered = indexed ? [...items].sort((a, b) => (a.index as number) - (b.index as number)) : items;
      if (ordered.length !== texts.length) {
        fail(
          'embed/response-shape',
          `embedding response from ${endpoint} has ${ordered.length} vectors for ${texts.length} texts`,
        );
      }
      return ordered.map((it, i): Float32Array => {
        // `return fail(...)` (not statement-position): the typed throw must also
        // narrow, and TS only narrows through an exiting branch here.
        if (!Array.isArray(it.embedding)) {
          return fail('embed/response-shape', `embedding response item ${i} lacks an embedding array`);
        }
        const raw = it.embedding as unknown[];
        if (raw.length !== dim) {
          return fail(
            'embed/dim-mismatch',
            `upstream returned ${raw.length}-d vectors but ApiEmbedder '${id}' expects ${dim}-d`,
          );
        }
        const vec = new Float32Array(dim);
        for (let d = 0; d < dim; d++) {
          const x = raw[d];
          if (typeof x !== 'number' || !Number.isFinite(x)) {
            return fail('embed/response-shape', `embedding response item ${i} component ${d} is not a finite number`);
          }
          vec[d] = x;
        }
        // bge/e5 endpoints ship normalized vectors, but the module contract is
        // "every embedder returns L2-normalized vectors" — enforce it here rather
        // than trust the endpoint.
        return l2Normalize(vec);
      });
    },
  };
};
