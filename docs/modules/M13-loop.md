---
module: M13
name: loop
syncedTo: spec-v1 (no code yet)
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

export interface ToolRegistryEntry { def: ToolDef; input: z.ZodType; inhibitionMeta: unknown; handler(args: unknown, ctx: ToolCtx): Promise<unknown>; }
export interface ToolRegistry { register(e: ToolRegistryEntry): void; defs(entry: EntryKind): ToolDef[]; get(name: string): ToolRegistryEntry | undefined; }

export interface SpawnRecord { kind: 'fork' | 'task' | 'committee'; id: string; brief: string; result?: unknown; usage: Usage; }
export interface CommitteeSpec {
  name: string;
  nodes: Array<{ id: string; needs: string[]; channels: { character: boolean; procedural: boolean }; prompt: string; schema?: z.ZodType; requiresObservation?: boolean }>;
  output: z.ZodType;
}

export interface LoopDeps {
  model: ModelClient;                                      // M03
  gate: InhibitionGate;                                    // M12
  assemble: (q: TurnQuery, a: Vec12) => Promise<Packet>;   // injected; matches M11.assemble; no compile-time M11 import
  window: SessionWindow;                                   // M09 rolling window
  tools: ToolRegistry;
  events: EventLog;
  clock: Clock; rng: Rng;
  cfg: LoopConfig;                                         // caps, per-entry budgets, inhibitionPlacement
}

export const runLoop: (entry: LoopEntry, deps: LoopDeps) => Promise<DecisionObject>;
```

## Behavior spec
- Sequence: assemble packet -> assess (main-tier structured call) -> zero or more (tool call -> gate.checkTool -> execute -> observe -> reassess) -> lock DecisionObject -> gate.checkPlan -> return to the pipeline, which hands it to the realizer.
- Native function-calling invariant (owner delta): tool invocation is OpenAI-compatible function calling only. Tool defs travel in the request `tools` array; calls come back as native tool_calls; results return as tool-role messages. No custom syntax, no sentinel tokens, no prose-parsed calls, anywhere, including inside spawned subprocesses.
- Message layout (§2.7): head system message = `packet.systemText()` with `packet.proceduralText()` appended adjacent to the tool definitions ([PROCEDURAL] always travels with the tool defs, never inside [EXEMPLARS]); then the rolling window (verbatim role messages from M09); then the current user message; then `packet.trailerText()` as a trailing system message. Config fallback `inhibitionPlacement: 'merged'` folds the trailer into the head system message if the backend mishandles trailing system messages (verified once in the S5 live smoke).
- The decision is parsed through M03's structured-output ladder; a parse failure that survives the repair call yields `plan:'silent'` + incident event — never a raw-text send (§5.2).
- Spawn primitives are ordinary registry tools (owner delta): `fork`, `task`, `committee` sit in the same ToolRegistry as `web_fetch`, so every subprocess shares one uniform calling machinery.
- Subprocess channel-composition rule (lives here, owner delta): fork = character + procedural (it's her — clone of the current context branch, cheap tier); task/cast worker = procedural + brief only, no voice channel (assemble called with `channels: {character:false, procedural:true}`); committee node = per-spec via each node's `channels` field.
- Caps: spawn depth ≤ 2; spawn concurrency ≤ 3; wall-clock budget per entry kind (config; the report pins no values — suggested defaults user-turn 90 s, heartbeat 120 s, ponder 300 s). On budget exhaustion, pending tools abort and the decision locks with `completeness` reflecting the truncation.
- Gate rejection re-enters the loop with the verdict `hint` in context; after `MAX_GATE_REENTRIES` (= 2, imported from M12) the loop forces `plan:'silent'` and emits an incident event.
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
