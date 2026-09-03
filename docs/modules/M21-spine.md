---
module: M21
name: spine
syncedTo: W2 as-built (2026-09-03 — P-SPINE-1 landed: SpineRunner seam, OpenCodeRunner + FakeRunner, SSE bridge, gating wiring; compose wiring lands with the coordinator's diff)
stage: W2
depends: [M01-kernel, M02-events, M03-model, M12-inhibit, M13-loop]
---
# M21 — spine

## Responsibility
Thea's loop drives OpenCode as a supervised child; her packet, gates, and events stay exactly ours (plan v7, Diego 2026-09-03). This module owns the ONE determinism seam — `SpineRunner` — and its two implementations: `OpenCodeRunner` (live: spawns/supervises the pinned `opencode serve`, drives sessions and per-turn messages, bridges SSE to StreamEvents) and `FakeRunner` (tests: replays scripted StreamEvent sequences from JSON fixtures). It also compiles `inhibitions.yaml` into the spine's two gate surfaces (static permission config + the repo-tracked `tool.execute.before` plugin). The person-layer — corpus, assemble, affect, coupling, inhibit semantics, memory, cadence/realize, bridge, sched, probes — is NOT here and never will be (review v3 §4).

## Interfaces (contract)
```ts
// The seam (plan v7 PART 0.5, binding):
export interface SpineRunner {
  run(entry: LoopEntry, packet: LoopPacket, tools: readonly ToolDef[], opts: SpineRunOpts): AsyncIterable<StreamEvent>;
}
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'decide-object'; decision: ModelDecision }   // validated through M13's ModelDecisionSchema
  | { type: 'usage'; usage: SpineUsage }                 // DR.4 semantics: attempts fold retries+repair
  | { type: 'stop-reason'; stopReason: StopReason };     // DR.4 vocabulary (end_turn/max_tokens/tool_use/...)

export interface SpineRunOpts {
  turnId: string;
  taskClass?: TaskClass;                 // selects the per-call model (config byClass, else model)
  signal?: AbortSignal;                  // the caller's wall-clock cut (FA.1 mirror)
  decide?: { schema: unknown };          // S1.3: structured-output contract on this turn
  toolInput?: Readonly<Record<string, ZodType>>;  // DR.7 parity on tool-call events
}

// Live side:
export class OpenCodeRunner implements SpineRunner {
  constructor(cfg: ResolvedSpineConfig, deps: { clock; events; spawnProc?; fetchImpl? });
  start(): Promise<void>;   // spawn pinned child + health check (spine.boot)
  stop(): Promise<void>;    // reaps the child — no orphaned harness
  state: 'stopped' | 'booting' | 'ready' | 'abandoned';
}
export const buildTurnRequest(input: TurnRequestInput): SpineTurnRequest;   // S1.4, byte-stable with M13's layout
export const validateDecideObject(raw: unknown): DecisionParse;             // S1.3, M13's parse + DR.7 coercion
export const prepareStreamToolCall(call, validators?);                      // DR.7 parity on tool-call events
export const spineServeCommand(cfg): { cmd: 'opencode'; args; env };

// Test side (the ONLY runner in CI — D.7-3):
export class FakeRunner implements SpineRunner {
  constructor(scripts: StreamEventFixture[][]);   // validated through M13's schema AT CONSTRUCTION
  static fromFixture(json: unknown): FakeRunner;
  readonly requests: FakeTurnRequest[];
}

// Session lifecycle (S1.2):
export class SpineSessions { ensure(conversationId, nowMs, create): Promise<SessionEnsureResult>; }

// SSE bridge (S1.2):
export class SseTurnBridge { feed(frame: SseFrame): SseFeedResult; }
export const parseSse(body): AsyncGenerator<SseFrame>;
export const mapFinishToStopReason(finish): StopReason;
export const emitModelCall(events, payload, turnId?): Promise<void>;  // DR.4 field names

// Gating wiring (S1.5):
export const compileSpineGate(yamlText, opts): { permission; rules; loopSideOnlyRuleIds };
export const writeSpineGateFiles(dir, yamlText, opts): Promise<{ rulesPath; rules }>;

// Config (M.6 block; self-contained so compose wiring is a three-line diff):
export const loadSpineConfig(yamlPath, env, model?: ModelRef): ResolvedSpineConfig;
export const resolveSpineConfig(over: SpineConfigInput, env): ResolvedSpineConfig;
```

## Behavior spec
- **S1.1 The seam.** Everything above the spine drives it through `SpineRunner.run`. The native loop (M13 + MockModel) remains a second implementation behind the same interface for tests; `native-loop-and-fake-runner-agree-on-decide-shape` proves both parse the decision through M13's own `ModelDecisionSchema` — one contract, two transports.
- **S1.2 Supervision.** `start()` spawns the pinned `opencode serve --hostname 127.0.0.1 --port <spine.port>` (auth token from `spine.authTokenEnv`, injected into the child env and sent as `Authorization: Bearer` on every request), health-checks `GET /app` (poll every `healthPollMs` up to `bootTimeoutMs`), and emits `spine.boot {version, port, pid, attempt}`. A child exit while supervised emits `spine.restart {attempt, exitCode, signal}` and respawns after `restartBackoffBaseMs * 2^(attempt-1)` capped at `restartBackoffMaxMs`. A wedge (health never green) cuts the child and retries; exhausting `maxBootAttempts` emits `incident.spine_failed {reason: 'boot-timeout'|'restart-cap', attempts, port, version}` and ABANDONS: the process keeps running, and every later `run()` refuses loudly (`spine/abandoned`). `stop()` kills the child — thead never orphans a harness (G3, ADR-002 amendment).
- **S1.2 Sessions.** One spine session per conversation (`tg:<chatId>`, or the entry kind's singleton for heartbeat/ponder). Our 4h session-break (SPINE_SESSION_BREAK_MS, the window's break) drives a NEW session: `ensure()` creates on first turn and re-creates when `now - lastTurnMs >= 4h`, counting forks. OpenCode's fork endpoint is the M22 upgrade path; M21 forks by creating new, which loses nothing — recall is ours, the spine session is only the live window. The child itself has NO cross-session memory (verified 2026-09-03) — exactly our posture.
- **S1.2 Per-turn.** `POST /session/{id}/message` with `agent: 'thea'`, per-call `model` = the door for the task class (from P-DOOR's doors, passed at the wiring site; `byClass` overrides), `system` = the assembled packet (S1.4), `parts` = the turn text + the [INHIBITION] trailer LAST, `tools` = the offered defs as an on/off map, and `format` when the turn carries the decide contract. SSE `GET /event` (one connection per turn, opened BEFORE the POST) is bridged: `message.part.updated` text parts → `text-delta` (buffered in decide mode), tool parts → `tool-call`; `message.updated` → `usage` + `stop-reason` and one `model.call` L0 event with DR.4 field names (`usage.inputTokens/usage.outputTokens/usage.costUsd`, top-level `stopReason`, `door`, `tier: 'main'`, `model: '<providerID>/<modelID>'`); `session.idle` ends the turn; `session.error` → `incident.spine_failed` + the stream ends with `stop-reason: 'error'` — turn-abort semantics per FA.1 (the loop side locks its failure silence; that half lands with P-LOOP). An idle/watchdog cut (`turnIdleTimeoutMs` silence, or the caller's `signal`) ends the turn the same loud way.
- **S1.3 Decide over structured output.** A decide turn carries `format: {type:'json_schema', schema: decideToolDef.parameters, retryCount: 1}` — forced structured output on the primary agent. The returned object is zod-validated on OUR side through src/loop's own parse (`parseDecisionValue`, same normalize/clamp ladder as the native client) AFTER the DR.7 coercion (`decide.bubbles` as a bare string becomes its newline-split bubble list). A failed validation triggers exactly ONE re-ask (same door; the malformed reply + schema + parse error ride as a `repair` part); a second failure emits `incident.parse_failed {schema:'DecisionObject', rung:'json_schema'}` (M13's own incident kind) and ends with `stop-reason: 'error'`. The whole logical call reports ONE usage with `attempts` folded (DR.4). Tool-call StreamEvents get the same DR.7 treatment (`prepareStreamToolCall`): coercion always, zod validation when `opts.toolInput` is handed; a validator failure is dropped loudly (`model.parse_failed {schema:'tool-input', rung:'tool_call'}`), never yielded.
- **S1.4 Packet injection.** Assemble stays ours. `buildTurnRequest` renders the packet byte-identically to the loop's message layout (src/loop/messages.ts): `system` = `packet.systemText()` with `packet.proceduralText()` appended ([PROCEDURAL] beside the tool defs) and the [OUTPUT] contract appended on decide turns; the [INHIBITION] trailer is the LAST part (trailing placement — recency wins) or folded into `system` (merged fallback). The golden test replays `probes/fixtures/door-smoke-packet.txt` (a real rendered packet, recorded in BOTH layouts) and asserts byte-stability in both placements.
- **S1.5 Gating.** `compileSpineGate` consumes the SAME `inhibitions.yaml` text M12 compiles (read-only import of `parseInhibitionsDoc`) and emits: (a) the static permission config JSON — `'*': 'deny'` (unknown tool denies; the registry rule) plus explicit `'allow'` for every tool the file itself acknowledges — deny-by-default posture preserved; (b) rules for the repo-tracked plugin `spine/plugin/gate-plugin.ts`: `owner-arg` chat locks (owner chat id injected at compile, same startup failure when absent as compileGate's), `secret-args` scans (secret VALUES ride the child's env `THEA2_SPINE_SECRETS`, colon-separated — never the repo), explicit `deny` rules, and `failOpenRuleIds` (every soft plan rule). The plugin hooks `tool.execute.before` (fires before EVERY tool execution — built-ins, MCP, task; source-verified), vetoes by throwing `[INHIBITION:<ruleId>] ...`, and emits a `gate.rejected` event for EVERY veto AND every fail-open via a loopback POST to thead's event endpoint (URL in env `THEA2_SPINE_EVENT_URL`, path `/spine/gate-events`; thead's serving side lands elsewhere). Rules the spine layer cannot express (`allow_args`, `spend_cap`, `path_fence`, `allow_entry`) are surfaced in `loopSideOnlyRuleIds` and stay enforced by M12's compiled gate on the loop side — never silently dropped. Plan-class text rules stay loop-side: the spine's decide object is re-checked by the compiled gate on every locked decision, exactly as today. Fail-open rules stay fail-open everywhere.
- **Events:** `spine.boot`, `spine.restart`, `incident.spine_failed`, `model.call` (DR.4 parity), `incident.parse_failed` (decide ladder), `model.parse_failed` (tool-input), `gate.rejected` (posted by the plugin, written by thead's bridge).
- **Single-tenant note:** one pinned spine child, one active turn (ADR-002 amendment), so SSE frames are not filtered by session id; M22's cast fan-out adds the filter with the roster.

## Constants
- `SPINE_SESSION_BREAK_MS` = 4h — spec-pinned (the window's 4h session-break).
- `SPINE_DECIDE_RETRY_COUNT` = 1 (wire `format.retryCount`) and `SPINE_DECIDE_REPAIRS` = 1 (our-side re-ask) — spec-pinned by S1.3.
- `SPINE_DEFAULT_PORT` = 4096 — PROPOSED (OpenCode's documented default serve port).
- `SPINE_TURN_IDLE_TIMEOUT_MS` = 60 000 — PROPOSED (mirrors M03's per-call timeout).
- `SPINE_BOOT_TIMEOUT_MS` = 10 000, `SPINE_HEALTH_POLL_MS` = 250 — PROPOSED.
- `SPINE_RESTART_BACKOFF_BASE_MS` = 500, `SPINE_RESTART_BACKOFF_MAX_MS` = 10 000 — PROPOSED (same family as M03's DEFAULT_BACKOFF 500/8000).
- `SPINE_MAX_BOOT_ATTEMPTS` = 3 — PROPOSED.
- Version pin (`1.18.3` PROPOSED until M.6 records the provisioned build) lives in `thea2.config.yaml` `spine.version`; upgrades are explicit M-items gated on the probe suite (D.7-2).

## Not this module's job
- The deliberation loop, decision locking, gate semantics, [INHIBITION] text — M12/M13 (the spine is their transport).
- The subagent roster (thea/fork/task/scout agent files, Task tool, casts) — M22/P-SPINE-2.
- Skills + MCP policy (deny-by-default rosters) — M23/P-SPINE-3.
- Provider/agent config generation from the doors (P-DOOR's port) — the wiring site's M-item; this module consumes ModelRef values.
- Thea2 serving `/spine/gate-events` (the plugin only POSTs; thead's endpoint lands elsewhere).
- Telegram, realize/pacing, memory, corpus — unchanged modules.

## Where the proofs live
`test/spine/` — `fake-runner.test.ts` (`fake-runner-replays-golden-turn`, `native-loop-and-fake-runner-agree-on-decide-shape`), `runner.test.ts` (`runner-supervises-and-restarts-a-dead-spine` incl. wedge→abandon, `session-break-forks-a-new-session`, `sse-events-map-to-l0-model-call-events`, POST body shape), `decide.test.ts` (`decide-arrives-as-validated-object-or-repairs-once`, `a string bubbles field becomes a one-element array`, format-on-first-POST, failure-path), `packet.test.ts` (`packet-render-golden-unchanged-through-spine`, `inhibition-is-the-trailing-message`, [PROCEDURAL] placement), `gates.test.ts` (`gate-veto-blocks-a-tool-call-in-replay`, `every-veto-emits-a-gate-event`, permission compile, fail-open), `config.test.ts` (M.6 block). Hermeticity: every runner test runs against a local `node:http` stub on 127.0.0.1 (ephemeral port) speaking the documented v1.18.x shape from recorded fixtures (`test/spine/fixtures/`), with the spawn seam injected so the real `opencode` binary is never launched, downloaded, or required (D.7-3). 27 tests, all green.

## As built (W2, P-SPINE-1)
- **Compose wiring NOT in this change** (src/app was frozen mid-flight): the runner + config are self-contained so the seam lands as a three-line diff — see the P-SPINE-1 report for the exact `compose.ts` and `thea2.config.yaml` diffs held for the coordinator. Until it lands, prod still runs the native loop; nothing here changes runtime behavior.
- **`loadSpineConfig` takes the model from the wiring site** (`opts.model`): the M.6 block pins version/port/authTokenEnv only, and her door comes from P-DOOR's `doors.voice` — a resolved config without a model fails loud (`spine.model is required`).
- **The SSE bridge does not filter by session id** (single pinned child, single active turn). The fixtures pin this shape; M22 adds the filter with casts.
- **Decide usage folds attempts** (1 + re-asks) into ONE `model.call` with summed tokens/cost — mirrors DR.4's attempts semantics rather than emitting per-attempt events.
- **`gate.rules.json` is generated at compose time** by `writeSpineGateFiles` into the plugin's directory; the plugin file itself (`spine/plugin/gate-plugin.ts`) is repo-tracked and self-contained (node builtins only — it runs under the spine's Bun runtime, outside thea2's vitest/tsconfig umbrella; the injectable `makeGateHook` core is what tests drive).
- **Unknown-tool deny is enforced twice**: statically (`'*': 'deny'` in the permission config) and in the plugin (allowlist miss vetoes with `unknown-tool-deny`) — defense in depth, one rule id.

## Acceptance criteria
- [x] `run(entry, packet, tools, opts) → AsyncIterable<StreamEvent>` with the five event shapes; FakeRunner replays JSON fixtures (`fake-runner-replays-golden-turn`).
- [x] Native loop and FakeRunner produce decisions that validate identically through M13's schema (`native-loop-and-fake-runner-agree-on-decide-shape`).
- [x] Supervision: spawn pinned child, health check, restart with backoff, wedge → abandon + `incident.spine_failed` (`runner-supervises-and-restarts-a-dead-spine`).
- [x] 4h session-break forks a new session (`session-break-forks-a-new-session`).
- [x] SSE → StreamEvents with DR.4 cost/tokens/stop-reason parity (`sse-events-map-to-l0-model-call-events`).
- [x] Decide as validated object or ONE repair (`decide-arrives-as-validated-object-or-repairs-once`); string bubbles → array (`a string bubbles field becomes a one-element array`).
- [x] Packet byte-stability through the spine, both placements (`packet-render-golden-unchanged-through-spine`, `inhibition-is-the-trailing-message`).
- [x] Gate veto blocks a tool call in replay (`gate-veto-blocks-a-tool-call-in-replay`); every veto emits a gate event (`every-veto-emits-a-gate-event`); fail-open rules stay fail-open; unknown tools deny.
- [x] No test requires a live spine or network beyond the loopback stub (hermetic law, D.7-3).
