// M21 spine — the `spine:` config block (thea2.config.yaml, M.6) and the
// load-bearing constants. The block is SELF-CONTAINED: loadSpineConfig reads
// the yaml and resolves only this block, so wiring the runner into compose is a
// three-line change and src/app/config.ts needs no schema edit for spine to
// load (the coordinator lands the schema passthrough together with the wiring —
// see the M21 report).
//
// Constants marked PROPOSED are proposals (the spec pins no number): they sit
// in the resolved config, overridable from the yaml, never edited here.

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { fail } from '../kernel/index.js';
import { TASK_CLASSES, type TaskClass } from '../model/index.js';
import { SpineError, type ModelRef } from './types.js';

/**
 * The 4h session break (ARCHITECTURE: "4h silence = session break"). Spec-pinned
 * by S1.2: our break drives the spine session fork/new.
 */
export const SPINE_SESSION_BREAK_MS = 4 * 60 * 60 * 1000;

/** OpenCode's documented default serve port. PROPOSED as the pinned default. */
export const SPINE_DEFAULT_PORT = 4096;

/** One turn's silence cut. PROPOSED — mirrors M03's DEFAULT_TIMEOUT_MS. */
export const SPINE_TURN_IDLE_TIMEOUT_MS = 60_000;

/** Boot health-check window. PROPOSED. */
export const SPINE_BOOT_TIMEOUT_MS = 10_000;

/** Health poll interval inside the boot window. PROPOSED. */
export const SPINE_HEALTH_POLL_MS = 250;

/** Restart backoff family. PROPOSED — same shape as M03's DEFAULT_BACKOFF. */
export const SPINE_RESTART_BACKOFF_BASE_MS = 500;
export const SPINE_RESTART_BACKOFF_MAX_MS = 10_000;

/** Boot attempts before abandon. PROPOSED. */
export const SPINE_MAX_BOOT_ATTEMPTS = 3;

/**
 * The structured-output retryCount on the wire format (S1.3, spec-pinned:
 * "retryCount:1") and OUR-side re-asks after a failed zod validation
 * (spec-pinned: "one re-ask on failure"). Separate numbers on purpose: the
 * server may retry within a call; the ladder allows one more POST.
 */
export const SPINE_DECIDE_RETRY_COUNT = 1;
export const SPINE_DECIDE_REPAIRS = 1;

/** The spine agent (the primary; the roster is M22). */
export const SPINE_AGENT = 'thea';

const modelRefSchema = z.strictObject({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  door: z.enum(['voice', 'mind', 'judge', 'voiceFallback']).optional(),
});

const spineBlockSchema = z.strictObject({
  /** The pinned opencode version (D.7-2: upgrades are explicit M-items). */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be an exact x.y.z pin'),
  port: z.number().int().min(1).max(65535).default(SPINE_DEFAULT_PORT),
  /** The ENV VARIABLE NAME the spine auth token arrives under — never the token. */
  authTokenEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, 'authTokenEnv must name an env variable (UPPER_SNAKE_CASE)')
    .default('THEA2_SPINE_TOKEN'),
  /** Her turns' model — the P-DOOR door for the primary agent (doors.voice). */
  model: modelRefSchema.optional(),
  /** Per-task-class overrides (workers ride other doors from M22 on). */
  byClass: z.record(z.string(), modelRefSchema).optional(),
  sessionBreakMs: z.number().int().positive().default(SPINE_SESSION_BREAK_MS),
  turnIdleTimeoutMs: z.number().int().positive().default(SPINE_TURN_IDLE_TIMEOUT_MS),
  bootTimeoutMs: z.number().int().positive().default(SPINE_BOOT_TIMEOUT_MS),
  healthPollMs: z.number().int().positive().default(SPINE_HEALTH_POLL_MS),
  restartBackoffBaseMs: z.number().int().positive().default(SPINE_RESTART_BACKOFF_BASE_MS),
  restartBackoffMaxMs: z.number().int().positive().default(SPINE_RESTART_BACKOFF_MAX_MS),
  maxBootAttempts: z.number().int().positive().default(SPINE_MAX_BOOT_ATTEMPTS),
  inhibitionPlacement: z.enum(['trailing', 'merged']).default('trailing'),
  agent: z.string().min(1).default(SPINE_AGENT),
});

/**
 * Exported for the M20 config passthrough: `configSchema` gains
 * `spine: spineBlockSchema.optional()` when the wiring lands, so the strict
 * yaml schema admits the M.6 block without spine owning any other block.
 */
export { spineBlockSchema };

export type SpineConfigInput = z.input<typeof spineBlockSchema>;
export type SpineBlockYaml = z.infer<typeof spineBlockSchema>;

/** The fully resolved config — everything the runner needs, nothing lazy. */
export interface ResolvedSpineConfig {
  version: string;
  port: number;
  authTokenEnv: string;
  /** Loopback, always. */
  host: '127.0.0.1';
  authToken: string;
  model: ModelRef;
  byClass: Partial<Record<TaskClass, ModelRef>>;
  sessionBreakMs: number;
  turnIdleTimeoutMs: number;
  bootTimeoutMs: number;
  healthPollMs: number;
  restartBackoffBaseMs: number;
  restartBackoffMaxMs: number;
  maxBootAttempts: number;
  inhibitionPlacement: 'trailing' | 'merged';
  agent: string;
  decideRetryCount: number;
  decideRepairs: number;
}

/**
 * Resolves the block over its defaults. `env` carries the resolved auth token
 * (never the yaml). `model` is REQUIRED in the resolved shape: a spine without
 * her door must never boot — that is config's say, not a silent default.
 */
export const resolveSpineConfig = (
  over: SpineConfigInput,
  env: Record<string, string | undefined>,
): ResolvedSpineConfig => {
  const parsed = spineBlockSchema.safeParse(over);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
    throw new SpineError('spine/config-invalid', `spine config is invalid: ${detail}`);
  }
  const block = parsed.data;
  if (block.model === undefined) {
    throw new SpineError(
      'spine/config-invalid',
      'spine.model is required — pass her door (P-DOOR doors.voice) at the wiring site; a spine without its primary model never boots',
    );
  }
  const authToken = env[block.authTokenEnv];
  if (authToken === undefined || authToken === '') {
    throw new SpineError('spine/config-invalid', `${block.authTokenEnv} missing from env — the spine child answers only authenticated calls`);
  }
  const byClass: Partial<Record<TaskClass, ModelRef>> = {};
  if (block.byClass !== undefined) {
    for (const [cls, ref] of Object.entries(block.byClass)) {
      if ((TASK_CLASSES as readonly string[]).includes(cls)) byClass[cls as TaskClass] = ref;
    }
  }
  return {
    version: block.version,
    port: block.port,
    authTokenEnv: block.authTokenEnv,
    host: '127.0.0.1',
    authToken,
    model: block.model,
    byClass,
    sessionBreakMs: block.sessionBreakMs,
    turnIdleTimeoutMs: block.turnIdleTimeoutMs,
    bootTimeoutMs: block.bootTimeoutMs,
    healthPollMs: block.healthPollMs,
    restartBackoffBaseMs: block.restartBackoffBaseMs,
    restartBackoffMaxMs: block.restartBackoffMaxMs,
    maxBootAttempts: block.maxBootAttempts,
    inhibitionPlacement: block.inhibitionPlacement,
    agent: block.agent,
    decideRetryCount: SPINE_DECIDE_RETRY_COUNT,
    decideRepairs: SPINE_DECIDE_REPAIRS,
  };
};

/**
 * Reads `thea2.config.yaml`, extracts ONLY the `spine:` block, and resolves it.
 * Self-contained by design: no other block is validated here, so the spine
 * wiring lands without touching src/app/config.ts (whose strict schema gains
 * the passthrough with the coordinator's compose diff).
 *
 * `model` comes from the wiring site (P-DOOR's doors — read-only), not from
 * this block: the primary model is cfg.models.doors.voice, so compose passes
 * it in and a spine without her door still never boots.
 */
export const loadSpineConfig = (
  yamlPath: string,
  env: Record<string, string | undefined>,
  model?: ModelRef,
): ResolvedSpineConfig => {
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(yamlPath, 'utf8'));
  } catch (e) {
    throw new SpineError('spine/config-invalid', `cannot read ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  if (raw === null || typeof raw !== 'object' || !('spine' in raw) || raw['spine'] === undefined) {
    fail('spine/config-absent', `no spine: block in ${yamlPath} — the spine wiring requires the M.6 config (version, port, authTokenEnv)`);
  }
  return resolveSpineConfig({ ...(raw as { spine: SpineConfigInput }).spine, ...(model !== undefined ? { model } : {}) }, env);
};

/** The `opencode serve` command for the pinned child. Loopback, always. */
export const spineServeCommand = (
  cfg: Pick<ResolvedSpineConfig, 'host' | 'port' | 'authTokenEnv' | 'authToken'>,
): { cmd: string; args: string[]; env: Record<string, string> } => ({
  cmd: 'opencode',
  args: ['serve', '--hostname', cfg.host, '--port', String(cfg.port)],
  env: { [cfg.authTokenEnv]: cfg.authToken },
});
