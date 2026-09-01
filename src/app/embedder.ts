// M20 app — the embedder seam. One config branch, one place. 'fastembed' is a
// loud S9 failure, not a silent hash fallback (finding B of the S5 survey): an
// identity swap via a silently-different embedding space is the worst failure
// mode this system has, so the absence is typed and names its stage.

import { fail } from '../kernel/index.js';
import { makeApiEmbedder, makeHashEmbedder, type Embedder } from '../embed/index.js';

export interface EmbedderConfig {
  kind: 'hash' | 'api' | 'fastembed';
  model?: string | undefined;
}

export const makeEmbedder = (
  cfg: EmbedderConfig,
  deps: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch | undefined },
): Embedder => {
  if (cfg.kind === 'hash') return makeHashEmbedder();
  if (cfg.kind === 'api') {
    if (cfg.model === undefined || cfg.model.trim() === '') {
      return fail('app/config-invalid', "embedder kind 'api' requires embedder.model");
    }
    if (deps.apiKey === '') return fail('app/config-invalid', "embedder kind 'api' requires a model API key");
    return makeApiEmbedder({
      baseUrl: deps.baseUrl,
      model: cfg.model,
      apiKey: deps.apiKey,
      // The transport is injected everywhere; composition is the one place the
      // global is legal to name (api-embedder's own contract note).
      fetchImpl: deps.fetchImpl ?? fetch,
    });
  }
  // Not built yet (S9: the bge-small local runtime). Naming the stage is the
  // contract — a prod boot with kind:'fastembed' must die HERE, loudly.
  return fail('app/not-built', "embedder kind 'fastembed' is not built yet (stage S9) — use kind 'hash' until then");
};
