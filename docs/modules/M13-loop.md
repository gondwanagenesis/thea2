---
module: M13
name: loop
syncedTo: src/loop @ S4 (code landed; see Build deltas)
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
}

export const runLoop: (entry: LoopEntry, deps: LoopDeps) => Promise<DecisionObject>;
// LoopConfig: inhibitionPlacement 'trailing'|'merged'; budgetMs {user-turn 90s, heartbeat 120s, ponder 300s};
// toolTimeoutMs 30s; maxToolHops 6 (PROPOSED); maxSpawnDepth 2; maxSpawnConcurrency 3;
// assessMaxTokens 2048; assessTemperature 0.7; repairTemperature 0; turnTokenBudget 6000;
// spawnTier {fork cheap, task cheap, committee main}. resolveLoopConfig(partial) merges defaults.
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
`test/loop/` — `registry.test.ts` (registry + overlay), `messages.test.ts` (both placements, observation budget), `committee.test.ts` (DAG validation, order, artifact, ponder shape), `loop.test.ts` (0/1/n hops, hop cap, wedged-tool cut via TestClock, all three re-entry branches, the repair ladder, the native-calling invariant, budgets), `spawn.test.ts` (channel composition, delegation episodes, depth/concurrency caps, subprocess gate inheritance). `npm run verify` = 206/206.

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
