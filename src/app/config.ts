import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { Door, DoorName } from '../model/index.js';

/**
 * A resolved door: the yaml registry shape plus the key RESOLVED FROM ENV
 * (P-DOOR DR.1). Only `keyEnv` names — never key values — live in the yaml;
 * the resolved `apiKey` exists in memory only, like models.apiKey before it.
 */
export interface ResolvedDoor extends Door {
  endpoint: string;
  keyEnv: string;
  apiKey: string;
}

export interface DoorsConfig {
  voice: ResolvedDoor;
  mind: ResolvedDoor;
  judge: ResolvedDoor;
  voiceFallback?: ResolvedDoor | undefined;
}

/** M20 owns config. Secrets NEVER live in the yaml — env only (AGENTS rule 7). */
export interface Thea2Config {
  models: {
    /**
     * Flattened voice-door view — the embedder and derive CLI ride the voice
     * door. Equals `doors.voice.{endpoint,apiKey,protocol}` in door mode and
     * the legacy single endpoint in legacy mode.
     */
    endpoint: string;
    apiKey: string; // resolved from env — never the yaml
    protocol: 'openai' | 'anthropic';
    /** main/cheap = voice/mind models; reasoning = judge's (legacy: tiers.reasoning ?? main). */
    tiers: { main: string; cheap: string; reasoning?: string | undefined };
    /** The door registry (DR.1) — always present (synthesized from the legacy shape when needed). */
    doors: DoorsConfig;
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

// ——— P-DOOR DR.1: the door registry ———————————————————————————————————

const EFFORTS = ['none', 'minimal', 'low', 'high', 'max'] as const;

const doorYamlSchema = z.strictObject({
  endpoint: z.string().min(1),
  protocol: z.enum(['openai', 'anthropic']),
  /** The ENV VARIABLE NAME the key arrives under — never the key itself. */
  keyEnv: z
    .string()
    .min(1)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'keyEnv must name an env variable (UPPER_SNAKE_CASE)'),
  model: z.string().min(1),
  effort: z.enum(EFFORTS).optional(),
  /** Anthropic-door thinking budget; outranks the effort→budget table (ADR-010). */
  thinkingBudget: z.number().int().positive().optional(),
  forcing: z.enum(['tool_choice', 'none']),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  pricing: z
    .strictObject({ inputPerM: z.number().min(0), outputPerM: z.number().min(0) })
    .optional(),
});

type DoorYaml = z.infer<typeof doorYamlSchema>;

const modelsYamlSchema = z
  .strictObject({
    // Legacy single-door shape (endpoint/protocol/tiers) — still loads (DR.1).
    endpoint: z.string().min(1).optional(),
    protocol: z.enum(['openai', 'anthropic']).default('openai'),
    tiers: z
      .strictObject({
        main: z.string().min(1),
        cheap: z.string().min(1),
        reasoning: z.string().min(1).optional(),
      })
      .optional(),
    // Door registry shape (DR.1): exactly the three tier doors + the optional swap-in.
    doors: z
      .strictObject({
        voice: doorYamlSchema,
        mind: doorYamlSchema,
        judge: doorYamlSchema,
        voiceFallback: doorYamlSchema.optional(),
      })
      .optional(),
  })
  .refine(
    (m) => m.doors !== undefined || (m.endpoint !== undefined && m.tiers !== undefined),
    { message: 'models needs either doors.{voice,mind,judge} or the legacy endpoint/protocol/tiers' },
  );

const configSchema = z.strictObject({
  models: modelsYamlSchema,
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
  const envIssues: ConfigIssue[] = [];
  if (botToken === undefined || botToken === '') {
    envIssues.push({ path: ['bridge', 'botToken'], message: 'THEA2_BOT_TOKEN missing from env' });
  }

  // ——— door resolution (DR.1): registry shape, or synthesized from the legacy shape ———
  const mkDoor = (name: DoorName, d: DoorYaml, apiKey: string): ResolvedDoor => ({
    name,
    endpoint: d.endpoint,
    protocol: d.protocol,
    keyEnv: d.keyEnv,
    apiKey,
    model: d.model,
    forcing: d.forcing,
    ...(d.effort !== undefined ? { effort: d.effort } : {}),
    ...(d.thinkingBudget !== undefined ? { thinkingBudget: d.thinkingBudget } : {}),
    ...(d.temperature !== undefined ? { temperature: d.temperature } : {}),
    ...(d.topP !== undefined ? { topP: d.topP } : {}),
    ...(d.pricing !== undefined ? { pricing: d.pricing } : {}),
  });

  const y = parsed.data as YamlConfig;
  const doorKey = (name: DoorName, d: DoorYaml): string => {
    const key = env[d.keyEnv];
    if (key === undefined || key === '') {
      envIssues.push({
        path: ['models', 'doors', name, 'keyEnv'],
        message: `${d.keyEnv} missing from env`,
      });
      return '';
    }
    return key;
  };

  let doors: DoorsConfig;
  let tiers: { main: string; cheap: string; reasoning?: string | undefined };
  if (y.models.doors !== undefined) {
    const d = y.models.doors;
    doors = {
      voice: mkDoor('voice', d.voice, doorKey('voice', d.voice)),
      mind: mkDoor('mind', d.mind, doorKey('mind', d.mind)),
      judge: mkDoor('judge', d.judge, doorKey('judge', d.judge)),
      ...(d.voiceFallback !== undefined
        ? { voiceFallback: mkDoor('voiceFallback', d.voiceFallback, doorKey('voiceFallback', d.voiceFallback)) }
        : {}),
    };
    tiers = { main: d.voice.model, cheap: d.mind.model, reasoning: d.judge.model };
  } else {
    // Legacy shape still boots (DR.1): endpoint/protocol/tiers synthesize the
    // three tier doors over the ONE legacy key; voice=main, mind=cheap,
    // judge=reasoning (falling back to main when only two tiers are configured).
    // Forcing stays 'none' — the legacy client never added a door-level force.
    const legacyKey = env['THEA2_MODEL_API_KEY'] ?? env['ZAI_API_KEY'];
    if (legacyKey === undefined || legacyKey === '') {
      envIssues.push({
        path: ['models', 'apiKey'],
        message: 'THEA2_MODEL_API_KEY (or ZAI_API_KEY) missing from env',
      });
    }
    const legacyDoor = (name: DoorName, model: string): DoorYaml & { keyEnv: string } => ({
      endpoint: y.models.endpoint!,
      protocol: y.models.protocol,
      keyEnv: env['THEA2_MODEL_API_KEY'] !== undefined && env['THEA2_MODEL_API_KEY'] !== '' ? 'THEA2_MODEL_API_KEY' : 'ZAI_API_KEY',
      model,
      forcing: 'none',
    });
    doors = {
      voice: mkDoor('voice', legacyDoor('voice', y.models.tiers!.main), legacyKey ?? ''),
      mind: mkDoor('mind', legacyDoor('mind', y.models.tiers!.cheap), legacyKey ?? ''),
      judge: mkDoor('judge', legacyDoor('judge', y.models.tiers!.reasoning ?? y.models.tiers!.main), legacyKey ?? ''),
    };
    tiers = y.models.tiers!;
  }

  if (envIssues.length > 0) throw new ConfigError('app/config-invalid', envIssues, yamlPath);

  return {
    models: {
      // Flattened voice-door view: the embedder + derive CLI ride the voice door.
      endpoint: doors.voice.endpoint,
      apiKey: doors.voice.apiKey,
      protocol: doors.voice.protocol,
      tiers,
      doors,
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
