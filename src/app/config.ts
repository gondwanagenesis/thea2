import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';

/** M20 owns config. Secrets NEVER live in the yaml — env only (AGENTS rule 7). */
export interface Thea2Config {
  models: {
    endpoint: string;
    apiKey: string; // from env (THEA2_MODEL_API_KEY, legacy ZAI_API_KEY) — never the yaml
    tiers: { main: string; cheap: string; reasoning?: string | undefined };
    /** Wire protocol: 'anthropic' = z.ai coding-plan door (streaming SSE); default openai. */
    protocol: 'openai' | 'anthropic';
  };
  bridge: { botToken: string; allowedChatIds: number[] }; // botToken from env only
  /** IANA zone Diego lives in (quiet hours, daily caps, the [EARLIER] clock). Default 'UTC'. */
  timezone: string;
  affect: {
    statePath: string;
    quietHours: [number, number];
    /** ADR-004a: the dominance resting home. Absent ⇒ 0.0 (Thea1's default, zero change); Diego decides the real value. */
    dominanceBaseline?: number | undefined;
  };
  /**
   * The people registry, keyed by speaker person id (`tg:<chatId>`). What v1
   * social awareness is: her [INTERLOCUTOR] line carries a NAME, not a raw id.
   * Per-person hours stay global (timezone) — the registry notes language for
   * the corpus/multilingual work, nothing reads it yet.
   */
  people: Record<string, { name: string; language?: string | undefined }>;
  sched: { statePath: string };
  budgets: { packetTokens: number; windowTokens: number; turnTokens: number };
  inhibitionPlacement: 'trailing' | 'merged';
  gravity: { seedWeight: number }; // g, default 0.7
  reconcile: { lostReplyWindowMin: number };
  embedder: { kind: 'fastembed' | 'api' | 'hash'; model?: string | undefined };
}

export interface ConfigIssue {
  path: (string | number)[];
  message: string;
}

export type ConfigErrorCode =
  | 'app/config-invalid'
  | 'app/config-unknown-key'
  | 'app/config-secret-in-yaml'
  | 'app/config-unreadable';

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    readonly issues: ConfigIssue[],
    readonly yamlPath: string,
  ) {
    super(
      `${code} in ${yamlPath}: ` +
        issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
    this.name = 'ConfigError';
  }
}

// ——— secret detection ————————————————————————————————————————————————

const TELEGRAM_TOKEN_RE = /^\d{8,10}:[A-Za-z0-9_-]{30,}$/;
const SK_KEY_RE = /^sk-[A-Za-z0-9_-]{16,}$/;
const HIGH_ENTROPY_BLOB_RE = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;
const PLACEHOLDER_RE = /^(PLACEHOLDER|CHANGEME|your-[a-z-]+|xxx+)$/i;

/**
 * True for strings that look like live credential material. Deliberately
 * conservative: ordinary config values (paths, model names, URLs) never trip
 * it; anything token-shaped, key-prefixed, or a 32+ char credential-class
 * blob does.
 */
export const secretShaped = (value: string): boolean => {
  if (PLACEHOLDER_RE.test(value)) return false;
  return TELEGRAM_TOKEN_RE.test(value) || SK_KEY_RE.test(value) || HIGH_ENTROPY_BLOB_RE.test(value);
};

const SECRETISH_KEY_RE = /token|secret|password|apikey|api_key|credential/i;

/** Walk a parsed yaml value; collect string-leaf paths that carry secret-shaped text. */
const findSecrets = (node: unknown, path: (string | number)[] = []): ConfigIssue[] => {
  if (typeof node === 'string') {
    const key = path[path.length - 1];
    const keySuspicious = typeof key === 'string' && SECRETISH_KEY_RE.test(key);
    if ((keySuspicious && !PLACEHOLDER_RE.test(node)) || secretShaped(node)) {
      return [{ path, message: 'looks like a secret — secrets enter via env, never the yaml' }];
    }
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => findSecrets(v, [...path, i]));
  }
  if (node !== null && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      findSecrets(v, [...path, k]),
    );
  }
  return [];
};

// ——— schema ————————————————————————————————————————————————————————

// A [start, end) window of LOCAL hours; `start > end` wraps midnight (23 → 8).
// Equal endpoints would be "no window" or "all day" — ambiguous, rejected.
const quietHoursSchema = z
  .tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)])
  .refine(([a, b]) => a !== b, { message: 'quietHours start and end must differ ([start, end), wrapping past midnight allowed)' });

/** An IANA zone the runtime can actually resolve — a typo here would silently become UTC. */
const timezoneSchema = z
  .string()
  .min(1)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'timezone must be an IANA zone this runtime knows (e.g. Europe/Madrid)' },
  )
  .default('UTC');

const configSchema = z.strictObject({
  models: z.strictObject({
    endpoint: z.string().min(1),
    protocol: z.enum(['openai', 'anthropic']).default('openai'),
    tiers: z.strictObject({
      main: z.string().min(1),
      cheap: z.string().min(1),
      reasoning: z.string().min(1).optional(),
    }),
  }),
  bridge: z.strictObject({
    // botToken deliberately absent — env only; its presence here is a secret-in-yaml hit
    allowedChatIds: z.array(z.number().int()).min(1),
  }),
  timezone: timezoneSchema,
  affect: z.strictObject({
    statePath: z.string().min(1),
    quietHours: quietHoursSchema,
    dominanceBaseline: z.number().min(0).max(1).optional(),
  }),
  people: z
    .record(
      z.string().min(1),
      z.strictObject({
        name: z.string().min(1),
        language: z.string().min(1).optional(),
      }),
    )
    .default({}),
  sched: z.strictObject({ statePath: z.string().min(1) }),
  budgets: z.strictObject({
    packetTokens: z.number().int().positive(),
    windowTokens: z.number().int().positive(),
    turnTokens: z.number().int().positive(),
  }),
  inhibitionPlacement: z.enum(['trailing', 'merged']),
  gravity: z
    .strictObject({
      seedWeight: z.number().min(0).max(1),
    })
    .default({ seedWeight: 0.7 }),
  reconcile: z.strictObject({
    lostReplyWindowMin: z.number().int().positive(),
  }),
  embedder: z.strictObject({
    kind: z.enum(['fastembed', 'api', 'hash']),
    model: z.string().min(1).optional(),
  }),
});

type YamlConfig = z.infer<typeof configSchema>;

// ——— load ————————————————————————————————————————————————————————

export const loadConfig = (
  yamlPath: string,
  env: Record<string, string | undefined>,
): Thea2Config => {
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(yamlPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(
      'app/config-unreadable',
      [{ path: [], message: e instanceof Error ? e.message : String(e) }],
      yamlPath,
    );
  }

  const secretHits = findSecrets(raw);
  if (secretHits.length > 0) {
    throw new ConfigError('app/config-secret-in-yaml', secretHits, yamlPath);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    // zod v4 paths are PropertyKey[]; our issue paths are (string|number)[]
    const toPath = (p: readonly PropertyKey[]): (string | number)[] => p.map((k) => (typeof k === 'number' ? k : String(k)));
    const unknown = parsed.error.issues.filter((i) => i.code === 'unrecognized_keys');
    if (unknown.length > 0) {
      throw new ConfigError(
        'app/config-unknown-key',
        unknown.map((i) => ({ path: toPath(i.path), message: i.message })),
        yamlPath,
      );
    }
    throw new ConfigError(
      'app/config-invalid',
      parsed.error.issues.map((i) => ({ path: toPath(i.path), message: i.message })),
      yamlPath,
    );
  }

  const botToken = env['THEA2_BOT_TOKEN'];
  const apiKey = env['THEA2_MODEL_API_KEY'] ?? env['ZAI_API_KEY'];
  const envIssues: ConfigIssue[] = [];
  if (botToken === undefined || botToken === '') {
    envIssues.push({ path: ['bridge', 'botToken'], message: 'THEA2_BOT_TOKEN missing from env' });
  }
  if (apiKey === undefined || apiKey === '') {
    envIssues.push({
      path: ['models', 'apiKey'],
      message: 'THEA2_MODEL_API_KEY (or ZAI_API_KEY) missing from env',
    });
  }
  if (envIssues.length > 0) throw new ConfigError('app/config-invalid', envIssues, yamlPath);

  const y = parsed.data as YamlConfig;
  return {
    models: {
      endpoint: y.models.endpoint,
      apiKey: apiKey as string,
      tiers: y.models.tiers,
      protocol: y.models.protocol,
    },
    bridge: { botToken: botToken as string, allowedChatIds: y.bridge.allowedChatIds },
    timezone: y.timezone,
    affect: {
      statePath: y.affect.statePath,
      quietHours: y.affect.quietHours,
      ...(y.affect.dominanceBaseline !== undefined ? { dominanceBaseline: y.affect.dominanceBaseline } : {}),
    },
    people: y.people,
    sched: { statePath: y.sched.statePath },
    budgets: y.budgets,
    inhibitionPlacement: y.inhibitionPlacement,
    gravity: { seedWeight: y.gravity.seedWeight },
    reconcile: y.reconcile,
    embedder: y.embedder,
  };
};
