---
module: M13
name: loop
syncedTo: v7-W2 P-LOOP (2026-09-03 — the spine runner seam: TurnState.runner routes assess through M21's SpineRunner when wired, StreamEvents fold into the same ChatResponse; absent runner = native path unchanged; see "As built (P-LOOP)")
stage: S4
depends: [M01-kernel, M02-events, M03-model, M09-memory, M12-inhibit]
---
# M13 — loop

## Responsibility
The single deliberation loop behind all three entry contexts (user-turn, heartbeat, ponder). It assembles the context, runs the main-tier assess call, mediates native tool calls through the inhibition gate, executes the spawn primitives, and locks a structured `DecisionObject` that downstream modules realize. It owns the message-array layout (character packet, [PROCEDURAL] beside the tool defs, window, trailing [INHIBITION]), the native function-calling invariant, the spawn caps, and the subprocess channel-composition rule. Packet assembly arrives injected (type-compatible with M11's `assemble`, wired by M20) so the S4 modules stay build-parallel.

## Interfaces (contract)
```ts
export interface LoopEntry { kind: 'user-turn' | 'heartbeat' | 'ponder'; inbound?: InboundMsg; goal?: string; committee?: CommitteeSpec; }

export interface DecisionObject {
  turnId: string;
  plan: 'reply' | 'silent' | 'defer';
  bubbles: string[];
  confidence: number; weight: number; reluctance: number; completeness: number;
  toolTrace: ToolStep[];
  spawns: SpawnRecord[];
  inhibitions: Verdict[];
}

export interface InhibitionMeta { entries?: readonly EntryKind[]; class?: string; }
// input is stated structurally (zod's safeParse shape, T = the schema's output type)
// so a concrete z.object is assignable without fighting zod Input/Output variance
// under exactOptionalPropertyTypes:
export interface ToolRegistryEntry<T = unknown> {
  def: ToolDef;
  input: { safeParse(data: unknown): { success: true; data: T; error?: never } | { success: false; data?: never; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } } };
  inhibitionMeta: InhibitionMeta;
  handler(args: T, ctx: ToolCtx): Promise<unknown>;
}
export interface ToolCtx { entry: EntryKind; turnId: string; depth: number; signal: AbortSignal; clock: Clock; rng: Rng; spawn: SpawnSink; }
export interface SpawnSink { situation: string; record(s: SpawnRecord): void; }
export interface ToolRegistry { register(e: ToolRegistryEntry): void; defs(entry: EntryKind): ToolDef[]; get(name: string): ToolRegistryEntry | undefined; names(): readonly string[]; }

export interface SpawnRecord { kind: 'fork' | 'task' | 'committee'; id: string; brief: string; channels: { character: boolean; procedural: boolean }; outcome?: string; }
export interface CommitteeSpec {
  name: string;
  nodes: Array<{ id: string; needs: string[]; channels: { character: boolean; procedural: boolean }; prompt: string; schema?: z.ZodType; requiresObservation?: boolean }>;
  output: z.ZodType;
}
export interface CommitteeResult { ok: boolean; outputs: Array<{ id: string; output: string }>; artifact: unknown; error?: string; }

export interface LoopQuery { entry?: EntryKind; text?: string; goal?: string; speaker?: unknown; register?: 'work' | 'friend' | 'play'; queryVec?: Float32Array; recentTurnIds?: string[]; channels?: { character: boolean; procedural: boolean }; }
// LoopPacket is the loop-rendered subset of M11's Packet: systemText(), proceduralText(): string|null, trailerText().

export interface LoopDeps {
  model: ModelClient;                                      // M03
  gate: InhibitionGate;                                    // M12
  assemble: (q: LoopQuery, a: Vec12) => Promise<LoopPacket>; // injected; type-compatible with M11.assemble; no compile-time M11 import
  affect: Vec12;                                           // 12-dim signature the packet is selected against (see deltas)
  window: SessionWindow;                                   // M09 rolling window
  tools: ToolRegistry;
  events: EventLog;
  clock: Clock; rng: Rng;
  cfg: LoopConfig;                                         // caps, per-entry budgets, inhibitionPlacement
  runner?: SpineTurnRunner;                                // M21 spine seam (P-LOOP); absent = native path
}

export const runLoop: (entry: LoopEntry, deps: LoopDeps) => Promise<DecisionObject>;
// LoopConfig: inhibitionPlacement 'trailing'|'merged'; budgetMs {user-turn 30s, heartbeat 60s, ponder 180s} (FA.2);
// toolTimeoutMs 10s (derived — sits inside the 30s turn budget); maxToolHops 6 (PROPOSED); maxSpawnDepth 2;
// maxSpawnConcurrency 3; assessMaxTokens 1536 (FA.2); assessTemperature 0.7; repairTemperature 0; turnTokenBudget 6000;
// spawnTier {fork cheap, task cheap, committee main}; spawns 'auto'|'always'|'off' (FA.3, default 'auto');
// turnTransport {timeoutMs 20_000 idle, maxRetries 1} (FA.2, wired into the voice door by M20). resolveLoopConfig(partial) merges defaults.
```

## Behavior spec
- Sequence: assemble packet -> assess (main-tier structured call) -> zero or more (tool call -> gate.checkTool -> execute -> observe -> reassess) -> lock DecisionObject -> gate.checkPlan -> return to the pipeline, which hands it to the realizer.
- Native function-calling invariant (owner delta): tool invocation is OpenAI-compatible function calling only. Tool defs travel in the request `tools` array; calls come back as native tool_calls; results return as tool-role messages. No custom syntax, no sentinel tokens, no prose-parsed calls, anywhere, including inside spawned subprocesses.
- Message layout (§2.7): head system message = `packet.systemText()` with `packet.proceduralText()` appended adjacent to the tool definitions ([PROCEDURAL] always travels with the tool defs, never inside [EXEMPLARS]); then the rolling window (verbatim role messages from M09); then the current user message; then `packet.trailerText()` as a trailing system message. Config fallback `inhibitionPlacement: 'merged'` folds the trailer into the head system message if the backend mishandles trailing system messages (verified once in the S5 live smoke).
- The decision is parsed through M03's structured-output ladder; a parse failure that survives the repair call yields `plan:'silent'` + incident event — never a raw-text send (§5.2).
- Spawn primitives are ordinary registry tools (owner delta): `fork`, `task`, `committee` sit in the same ToolRegistry as `web_fetch`, so every subprocess shares one uniform calling machinery.
- Subprocess channel-composition rule (lives here, owner delta): fork = character + procedural (it's her — clone of the current context branch, cheap tier); task/cast worker = procedural + brief only, no voice channel (assemble called with `channels: {character:false, procedural:true}`); committee node = per-spec via each node's `channels` field.
- Caps: spawn depth ≤ 2; spawn concurrency ≤ 3; wall-clock budget per entry kind (config; the report pins no values — suggested defaults user-turn 90 s, heartbeat 120 s, ponder 300 s). On budget exhaustion, pending tools abort and the decision locks with `completeness` reflecting the truncation.
- Gate rejection re-enters the loop with the verdict `hint` in context; after `MAX_GATE_REENTRIES` (= 2, imported from M12) `severityOf` decides the resolution — 'soft' fails open, everything else forces `plan:'silent'` — and an incident event is emitted (see Build deltas for the exact accounting).
- Every spawn emits a delegation episode event `{situation, call, args, result, outcome}` — the feedstock M08 reads to synthesize procedural exemplars.
- Tool registry v1: `web_fetch`, `web_search`, `memory_search`, `remember_thread`, `set_reminder`, plus `fork`, `task`, `committee`. Each entry carries a zod input schema and inhibition metadata; M08's procedural generator reads these defs.
- Intra-turn tool traffic is dropped at decision lock (§2.7): the rolling window keeps verbatim user/assistant messages only; tool work survives as episodes and delegation events.
- Committee: scripted DAG executed over the loop machinery, nodes in dependency order, output validated against `output` schema. Ponder is one (SEED->GROUND->REVISE->ARTIFACT). A node with `requiresObservation` (REVISE) is structurally unreachable without a grounding observation input — enforced by DAG shape, not by prompt.
- Token budgets consumed here: window ≤ 10k, current turn + this-turn tool observations ≤ 6k, response reserve 2k; main-turn total target ≤ 24k in (packet ≤ 6k enforced upstream by M11).
- A wedged tool call times out via AbortSignal without killing the loop; the observation records the timeout and deliberation continues.

## Not this module's job
- Packet content, quotas, coherence, channel rendering — M11-assemble (injected).
- Inhibition rule semantics and the [INHIBITION] text — M12-inhibit.
- Delivery pacing and sending — M14-realize (the loop never touches the Channel).
- Post-turn appraisal, episode writes, window summarization — M09-memory, invoked by the M20 pipeline.
- Heartbeat/ponder policy (whether and when to enter) — M17-life; the loop only executes their entries.
- Model retry, schema repair, tier routing — M03-model.

## Build deltas (S4 — deviations from the text above, kept here because the doc is the sync target)
- **Structural mirrors instead of imported types.** `LoopQuery` is an all-optional supertype of M11's TurnQuery and `LoopPacket` the loop-rendered subset of its Packet. Nothing in src/loop imports src/assemble (dependency-cruiser forbids the edge); M11's real `assemble` is assignable to the injected signature by structural typing. M20's adapter merges the pipeline-owned query fields (speaker, register, queryVec, recentTurnIds) before the real assembler runs.
- **`LoopDeps.affect` added.** The 2-arg assemble signature needs the affect vector from somewhere; the deps bag carries it.
- **SpawnRecord follows schemas/decision.ts, not the older shape in this doc**: `{kind, id, brief, channels, outcome?}`. There is no per-spawn `usage`/`result` on the record — spawn cost is visible through the `model.call` events each subprocess emits, and its result summary travels in `outcome` and on the delegation episode.
- **Assess carries tools and NO schema.** M03's ladder rung (b) only fires for schema-without-tools, and `schema + tools` forces rung (c), which would misparse every tool hop. So the loop's decision parse is loop-owned: the 6-field subset is read with `looseJsonParse` + a zod schema (unit fields clamped pre-parse), with exactly ONE cheap-tier repair (M03's `structuredRepairMessages` + `schemaJsonForPrompt`, no `response_format` on the wire), then `incident.parse_failed` + a forced-silent lock.
- **Gate re-entry accounting.** One counter shared by the main deliberation and every subprocess; a denial on rounds 1 and 2 re-enters (the hint is the tool-role message or a plan-path hint line), and a THIRD denial resolves the cap: `severityOf` on the final denial's rule ids (strictest wins — any non-'soft' forces silent) decides fail-open vs forced silent; `incident.gate_loop` carries `{turnId, ruleIds, reentries, resolution}` (the payload is schemas/events.ts's GateLoopPayload plus the `resolution` the cap took). Fail-open = one final decision call with NO tools on the wire (the blocked path cannot re-fire) and the decision still passes checkPlan. Tool-class rules are hard by construction, so the tool path always resolves forced-silent.
- **Hop cap `maxToolHops: 6` is PROPOSED** (the spec pins no number); so is `TRUNCATED_COMPLETENESS_CAP = 0.5` — the spec requires truncation to lower `completeness` but pins no value. Both sit in LoopConfig / one exported constant.
- **`decision.locked` payload (proposed, the kind is spec-pinned but the payload was not)**: `{turnId, entry, plan, bubbles: <count>, committee?: <spec name>, artifact?: <validated artifact>, committeeError?}`. Committee entries (ponder) lock plan 'silent' — ponder seeds future thinking and does not speak — and the terminal artifact rides the event for M17. M17 should confirm this transport when it lands.
- **Packet-assembly failure** locks a forced-silent decision (completeness 0.5). schemas/events.ts defines no incident kind for it; flagged rather than invented.
- **Subprocess answers are observations**, not decisions: they take the tool-observation path (budget-fit, delegation episode) and are NOT gated by checkPlan — checkPlan gates the one decision that can reach the channel. Their tool calls go through the same gate as everyone's.
- **committee-as-a-tool is a flat JSON surface** (`{spec: {name, nodes: [{id, needs, prompt, character?, requiresObservation?}]}}`): zod schemas cannot travel over a function call, so tool-spawned committees validate the artifact as unknown. Committee ENTRIES (M17's ponder) carry full zod node/output schemas in-process.
- **Message layout includes the `[EARLIER]` line** (M09's `window.earlier()`) between the head and the window, when one has been summarized. Everything else is as specified: head = packet + [PROCEDURAL] appended (merged mode folds the [INHIBITION] trailer into this head instead), window verbatim, current turn as the user message, trailer last.
- **Module law**: runtime failures a turn can survive are VALUES (forced-silent DecisionObject + incident), never exceptions. Exceptions are structural sins only: `loop/duplicate-tool`, `loop/bad-committee`, `loop/not-booted`, `loop/decision-invalid` (the forced-silent stub itself failing its schema — a programming error).
- **`turnId` forwarding (S5, M20's request).** `LoopEntry` and `LoopQuery` carry an optional `turnId`; the loop forwards it into the packet record's envelope so M10's credit match key is minted ONCE (by the pipeline) and never drifts between `packet.record` and the decision. When absent the loop mints one exactly as before — behavior unchanged for direct loop callers.

## Where the proofs live
`test/loop/` — `registry.test.ts` (registry + overlay), `messages.test.ts` (both placements, observation budget), `committee.test.ts` (DAG validation, order, artifact, ponder shape), `loop.test.ts` (0/1/n hops, hop cap, wedged-tool cut via TestClock, all three re-entry branches, the repair ladder, the native-calling invariant, budgets), `fast.test.ts` (P-FAST: turn-abort values, deadline timer cancellation, retry-ladder/budget fit, spawns-off-user-turns, prose fold, voice-door repair, the soft shape gate), `spawn.test.ts` (channel composition, delegation episodes, depth/concurrency caps, subprocess gate inheritance — run on ponder/heartbeat entries since FA.3). `test/app/pipeline.test.ts` carries the pipeline-side failure posture (`deadline-abort-locks-failure-silence-with-ledger-row`, `the user text enters the window on a failed turn`, the structural-escape wrap).

## Acceptance criteria
- [ ] Scripted 0/1/n tool-hop conversations produce correct DecisionObjects with full toolTrace.
- [ ] Every tool path is native function calling; no custom call markup exists in any prompt or parser (grep-clean plus MockModel call-log assertion).
- [ ] `fork`/`task`/`committee` are callable as registry tools; a task-worker context contains zero character sections; a fork context contains both channels.
- [ ] Caps enforced: depth ≤ 2, concurrency ≤ 3, per-entry wall-clock budget; truncation reflected in `completeness`.
- [ ] Gate rejection re-enters at most 2 times, then forced `plan:'silent'` + incident event.
- [ ] [PROCEDURAL] rendered adjacent to the tool defs; [INHIBITION] as trailing system message; `merged` fallback produces an equivalent single system message.
- [ ] Every spawn emits a delegation episode event with {situation, call, args, result, outcome}.
- [ ] Committee DAG runs in dependency order; REVISE-without-observation is impossible by construction.
- [ ] A wedged tool times out; the loop still locks a decision.

## Test checklist
- unit: registry behavior (schema validation, unknown tool), cap math, message-array builder for both inhibitionPlacement modes, composition rule per spawn kind, decision zod schema.
- component: scripted MockModel conversations — 0/1/n hops; malformed decision -> repair -> silent fallback; gate-rejection re-entry to the cap; committee DAG execution incl. a ponder-shaped spec; timeout injection via TestClock.
- fixtures needed: MockModel scripts (FIFO + rule-based), a stub `assemble` returning canned Packets (both channel masks), fake tools including a deliberately wedged one, CommitteeSpec fixtures with and without `requiresObservation`.

## As built (Phase 1)

- **`assessMaxTokens` 2048 → 3072** (config.ts, starvation family): a thinking model draws its invisible reasoning trace from the same max_tokens budget, and a 2048 cap let the trace burn the whole call before any visible content — starved ⇒ empty reply ⇒ parse failure ⇒ repair ⇒ often failure silence.
- **`assess` forces the decision** (turn.ts): when the offered defs are EXACTLY `[decide]`, the call carries `toolChoice:{name:'decide'}` (mapped per protocol by M03); any wider set (decide + registry tools, workers) leaves it unset. This covers the fail-open branch's final `[decideToolDef]` call in loop.ts without touching that file, and any tool-less registry's main assess.

## As built (P-FAST, v6 W1 — 2026-09-03)

- **FA.1 — the turn never throws.** The whole post-assembly body runs inside a try/catch: any runtime throw from assess/mediate/repair/gate emits `incident.turn_aborted {turnId, code, stage:'loop'}` (schema.ts `TurnAbortedPayloadSchema`) and locks `forcedSilent(state,'failure')`; if the deadline already passed when the throw lands, `truncated` is stamped so `completeness` reads 0.5. Structural sins (`LoopError`) rethrow on purpose — and M20's `runTurn` additionally wraps `runLoop`: a throw that still escapes (or is thrown around the loop) emits the same incident with `stage:'pipeline'`, writes the ledger `recordDecision({plan:'silent', decidedBy:'failure'})`, and pushes his user text into the verbatim window — a dead turn never erases the exchange or the owed reply. Tests: `a model error during assess is a failure silence not a throw`, `a gate that throws mid-plan is also a failure silence`, `a model error mid-mediation is a failure silence, not a throw`, `a structural loop error still escapes`, `deadline-abort-locks-failure-silence-with-ledger-row`, `the user text enters the window on a failed turn`, `a throw that escapes the loop still locks the failure silence (ledger row + window)`.
- **FA.2 — the budgets fit the voice door.** `budgetMs` 30s/60s/180s (user-turn/heartbeat/ponder), `assessMaxTokens` 1536 (the turn class reasons LOW since DR.2, worst anthropic thinking budget 512, so ~1k of visible answer room remains; a deployment that overrides `thinking` bigger must raise this with it). New `turnTransport: {timeoutMs 20_000 idle, maxRetries 1}` is the loop-owned dial M20's compose passes into the voice door's `zaiTransport`; one idle window plus the worst backoff (8s cap, M03) fits inside the 30s budget, so the turn's own deadline signal — never a second full attempt — bounds a user turn. The deadline waiter now rides its own `AbortController` gate and is cancelled in `finally`: a finished turn leaves NO timer armed on the clock. `toolTimeoutMs` 30s → 10s (derived, the plan pins no value): it must sit well inside the 30s turn budget or one wedged round would consume the whole turn before the loop can observe the cut and still decide. Tests: `the retry ladder fits inside the turn budget`, `the deadline timer is cleared when the turn ends`, `a turn that outlives its budget is aborted into a failure silence`.
- **FA.3 — spawns off user turns (D.6-8).** New `LoopConfig.spawns: 'auto' | 'always' | 'off'`, default `'auto'`: fork/task/committee are registered (overlaid) only on the delegation-capable entries — `SPAWN_ENTRY_KINDS = ['heartbeat','ponder']` in turn.ts, `'followup'` joining when P-CAST lands (W3). A user turn offers `decide` (plus the base registry's own tools) and nothing loop-owned besides; an off-wire spawn attempt there is answered as the unknown tool it is. Tests: `a user turn offers only decide`, `a ponder entry offers spawns`, `spawns: auto keeps them off user turns even when the base registry is full`.
- **FA.4 — repair is exceptional and stays on the voice door.** The one-shot decision repair now requests `tier:'main'` (it is the same logical call as assess; the old `cheap` request made every repair a tier change the router warns about — `model.routing_ignored` spam, since 'turn' is pinned to main, ADR-008 — and downgraded her one correction to a weaker door). The prose fold keeps reporting `decision.prose_folded {turnId, bubbles}` so the prose rate is measurable in L0. Tests: `a prose reply folds without a second call`, `the repair rung runs on the voice door (no routing_ignored spam)`.
- **Bubble-shape gate composed beside checkPlan (P-CADENCE wiring handoff).** The plan gate consults `checkBubbleShape` (M12's CA.4 pure rule, class `shape`) whenever the compiled plan rules allowed: a rejection joins the existing soft re-entry ladder with the one neutral reason (`[INHIBITION:bubble-shape] split shorter`) as the revise hint, is recorded in `inhibitions` (only rejections — an allow is the default state), and at the cap fails OPEN: `resolutionFor` exempts `SHAPE_RULE_ID` from the strictest-rule-wins check because `severityOf` answers undefined for it until the yaml section lands. It never hard-fails a turn. Tests: `a shape rejection rephrases once with the neutral reason and locks clean`, `a misshapen draft past the cap fails OPEN — the shape gate never hard-fails a turn`.
- **DR.7 request-side validators (P-DOOR handoff).** `assess` now builds `ChatRequest.toolInput` from the OFFERED registry tools' zod inputs (`toolInputFor`, turn.ts) — a call whose arguments miss the tool's schema is caught and repaired at the model layer (one re-ask, doubled budget, DR.6) instead of being rejected after the fact. `decide` is deliberately absent: the decision parse is loop-owned (Build deltas), and M03 still coerces `decide.bubbles` mechanically. The loop's own `executeCall` schema check remains as defense in depth. Tests: `tool args that miss the tool schema are repaired at the door (DR.7), then answered`. Tests: test/model/toolchoice.test.ts.

## As built (P-LOOP, v7 W2 — 2026-09-03)

- **The spine runner seam (`TurnState.runner`, P-LOOP/M21).** `LoopDeps.runner?: SpineTurnRunner` threads M20's optional `PipelineDeps.runner` into every turn's `TurnState`. When set, `assess` routes through `runner.run(entry, packet, defs, {turnId, taskClass, signal, decide?, toolInput?})` instead of `state.model.chat`; when absent, the native path serves byte-identically (rule 5). `SpineTurnRunner`/`SpineTurnEvent`/`SpineTurnUsage` are STRUCTURAL MIRRORS of M21's `SpineRunner`/`StreamEvent`/`SpineUsage` (the LoopPacket precedent — the DAG forbids a loop → spine import; src/spine imports src/loop read-only, so spine's runners satisfy the mirrors by construction).
- **StreamEvent → ChatResponse mapping (`responseOfStream`, turn.ts).** `text-delta` accumulates into `content`; `tool-call` appends to `toolCalls` (mid-turn rounds mediate exactly as native); `decide-object` appends the synthetic `{id:'spine_decide', name:'decide', args: decision}` call and pins `stopReason:'tool_use'`; the last `usage` event maps field-for-field onto `Usage`; the last `stop-reason` event wins otherwise (`'end_turn'` when the stream ended without one). The decide contract (`decideToolDef.parameters` as the S1.3 json_schema) rides only when `decide` is actually offered — never for workers. Everything downstream (`settleReply`, the repair ladder, the plan gate, realize) is transport-blind.
- **Worker spine identity.** A subprocess's assess call runs on a shallow state copy carrying `{entry: {kind, goal: brief}, packet}` — the worker's own brief and channel-composed packet ride its spine POST. The copy shares every mutable field with the parent state; the native path reads neither override (it walks `msgs`).
- **Fidelity note (accepted for M21):** the spine rebuilds each POST from the packet (S1.4), so the plan-path revision context (denied draft + hint) and tool answers do NOT ride later spine calls — the [INHIBITION] trailer re-injects the compiled rules, the gate ladder still converges, and the decide repair is the runner's own one-re-ask ladder. M22's cast work revisits if the re-entry rate says so. Tests: `test/loop/spine-seam.test.ts` (`a runner-present turn yields the decide object through the normal decision path`, `a runner-present turn passes tool defs to the spine`, `a spine tool round mediates through the gate and re-assesses`, `text-delta events fold to content prose path`, `runner-absent turns keep the native path`).
