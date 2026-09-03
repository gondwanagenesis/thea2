// M13 loop — the deliberation entry (docs/modules/M13-loop.md §Behavior spec).
// One sequence behind all three entry contexts: assemble the packet, assess on
// the main tier, zero or more mediated tool rounds, lock the DecisionObject,
// gate.checkPlan, return. Everything mechanical lives in turn.ts; this file is
// the spec's sequence, readable top to bottom.
//
// Failure posture: a turn survives its own runtime failures as VALUES — a
// forced-silent DecisionObject plus an incident event. Any throw from
// assess/mediate/repair/gate is caught here (FA.1): `incident.turn_aborted`
// names the code and the turn locks `forcedSilent(state,'failure')`. Only the
// pipeline can still see a throw, and only a structural one (a bad committee
// spec, a broken registry — LoopError rethrown on purpose), which the pipeline
// wraps into the same failure-silence value (M20's runTurn).

import { MAX_GATE_REENTRIES } from '../inhibit/index.js';
import { checkBubbleShape, SHAPE_RULE_ID } from '../inhibit/compile.js';
import { asError, newId } from '../kernel/index.js';
import {
  looseJsonParse,
  schemaJsonForPrompt,
  structuredRepairMessages,
  type ChatMsg,
  type ChatResponse,
  type ToolCall,
} from '../model/index.js';
import type { DecidedBy, DecisionObject, LoopDeps, LoopEntry, LoopPacket, LoopQuery, ModelDecision, RunLoop } from './types.js';
import { createToolRegistry, overlayRegistry } from './registry.js';
import { buildMessages } from './messages.js';
import { validateCommittee, runCommittee } from './committee.js';
import { OUTPUT_CONTRACT, decideToolDef, isDecideCall, looksJsonShaped, proseToDecision } from './decide.js';
import {
  assess,
  emit,
  mediate,
  spawnEntries,
  SPAWN_ENTRY_KINDS,
  taskClassFor,
  type TurnState,
} from './turn.js';
import { LoopError, failLoop } from './errors.js';
import {
  ASSEMBLE_FAILED_INCIDENT,
  DECISION_LOCKED_KIND,
  DECISION_PARSE_INCIDENT,
  DECISION_PROSE_FOLDED,
  DecisionObjectSchema,
  GATE_LOOP_INCIDENT,
  GateLoopPayloadSchema,
  ModelDecisionSchema,
  TURN_ABORTED_INCIDENT,
  TurnAbortedPayloadSchema,
  decisionIssue,
} from './schema.js';
import type { LoopConfig } from './config.js';

/**
 * Completeness ceiling once something was cut short this turn (a hop cap, the
 * wall clock, a truncated observation, a stopped subprocess). PROPOSED — the
 * spec requires truncation to be reflected in `completeness` but pins no value.
 */
export const TRUNCATED_COMPLETENESS_CAP = 0.5;

// ---------------------------------------------------------------------------
// Decision parsing (the model-authored subset) + the ONE cheap-tier repair
// ---------------------------------------------------------------------------

const clamp01 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : v as number);

/**
 * The model authors the six decision fields as loose JSON; the loop clamps the
 * unit fields before the schema sees them, so an off-by-a-hair confidence is a
 * transcription artifact, not a parse failure.
 */
const normalizeDecision = (raw: unknown): unknown => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  return {
    plan: r['plan'],
    bubbles: r['bubbles'],
    confidence: clamp01(r['confidence']),
    weight: clamp01(r['weight']),
    reluctance: clamp01(r['reluctance']),
    completeness: clamp01(r['completeness']),
  };
};

export type DecisionParse =
  | { ok: true; value: ModelDecision }
  | { ok: false; error: string };

export const parseDecision = (content: string): DecisionParse => {
  const parsed = looseJsonParse(content);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return parseDecisionValue(parsed.value);
};

/** A decoded value (a `decide` call's args, or parsed content) → ModelDecision. */
export const parseDecisionValue = (value: unknown): DecisionParse => {
  const check = ModelDecisionSchema.safeParse(normalizeDecision(value));
  if (!check.success) return { ok: false, error: decisionIssue(check.error) };
  return { ok: true, value: check.data };
};

type Settle =
  | { kind: 'decision'; value: ModelDecision; via: 'decide' | 'json' | 'prose' }
  | { kind: 'repair'; malformed: string; error: string }
  | { kind: 'tools'; calls: readonly ToolCall[] };

/**
 * What one assess reply settles to. Priority: a native `decide` call (the
 * contract) → other tool calls (a round) → parseable JSON content → plain prose
 * folded deterministically → the repair rung (empty or JSON-shaped-but-broken).
 * A `decide` call whose args miss the schema goes to repair with the args as
 * the malformed text — the model tried the contract; one correction is owed.
 */
const settleReply = (res: ChatResponse): Settle => {
  const calls: readonly ToolCall[] = res.toolCalls ?? [];
  const decide = calls.find(isDecideCall);
  if (decide !== undefined) {
    const parsed = parseDecisionValue(decide.args);
    if (parsed.ok) return { kind: 'decision', value: parsed.value, via: 'decide' };
    let malformed: string;
    try {
      malformed = JSON.stringify(decide.args);
    } catch {
      malformed = String(decide.args);
    }
    return { kind: 'repair', malformed, error: parsed.error };
  }
  if (calls.length > 0) return { kind: 'tools', calls };
  const content = res.content;
  const parsed = parseDecision(content);
  if (parsed.ok) return { kind: 'decision', value: parsed.value, via: 'json' };
  if (content.trim() !== '' && !looksJsonShaped(content)) {
    const folded = proseToDecision(content);
    if (folded !== null) return { kind: 'decision', value: folded, via: 'prose' };
  }
  return { kind: 'repair', malformed: content, error: parsed.error };
};

/**
 * The one-shot repair: same conversation + the malformed reply + the correction
 * instruction, no schema on the wire (M03's repair idiom). FA.4: the repair
 * runs on the SAME tier as assess — the voice door for the turn class —
 * because it is the same logical call: a `cheap` request here would make every
 * repair a tier change the router warns about (`model.routing_ignored` spam:
 * 'turn' is pinned to main, ADR-008) and downgrade her one correction to a
 * weaker door.
 */
const repairOnce = async (state: TurnState, msgs: readonly ChatMsg[], malformed: string, error: string): Promise<DecisionParse> => {
  const repairMsgs = structuredRepairMessages({
    original: msgs,
    malformed,
    schemaJson: schemaJsonForPrompt(ModelDecisionSchema),
    error,
  });
  const res = await state.model.chat(
    {
      taskClass: taskClassFor(state.kind),
      tier: 'main',
      messages: repairMsgs,
      maxTokens: state.cfg.assessMaxTokens,
      temperature: state.cfg.repairTemperature,
    },
    { turnId: state.turnId, signal: state.signal },
  );
  return parseDecision(res.content);
};

// ---------------------------------------------------------------------------
// Forced-silent outcomes (values, not exceptions)
// ---------------------------------------------------------------------------

/**
 * A silence the model did not choose. `gate` = the inhibition gate's verdict
 * after the re-entry cap (restraint by law); `failure` = the loop could not
 * produce a decision at all — recorded as such so the ledger keeps the reply
 * owed (a failure silence is never "decided-silent ⇒ clean").
 */
const forcedSilent = (state: TurnState, decidedBy: Exclude<DecidedBy, 'model'>): DecisionObject => {
  const d: DecisionObject = {
    turnId: state.turnId,
    plan: 'silent',
    decidedBy,
    bubbles: [],
    confidence: 0,
    weight: 0,
    reluctance: 1,
    completeness: state.truncated ? TRUNCATED_COMPLETENESS_CAP : 1,
    toolTrace: state.toolTrace,
    spawns: state.spawns,
    inhibitions: state.inhibitions,
  };
  const check = DecisionObjectSchema.safeParse(d);
  if (!check.success) return failLoop('loop/decision-invalid', `forced-silent stub failed its own schema: ${decisionIssue(check.error)}`);
  return d;
};

const completenessCeiling = (state: TurnState): number => (state.truncated ? TRUNCATED_COMPLETENESS_CAP : 1);

const lockDecision = (state: TurnState, decision: ModelDecision): DecisionObject => {
  const d: DecisionObject = {
    turnId: state.turnId,
    plan: decision.plan,
    decidedBy: 'model',
    bubbles: decision.bubbles,
    confidence: decision.confidence,
    weight: decision.weight,
    reluctance: decision.reluctance,
    completeness: Math.min(decision.completeness, completenessCeiling(state)),
    toolTrace: state.toolTrace,
    spawns: state.spawns,
    inhibitions: state.inhibitions,
  };
  const check = DecisionObjectSchema.safeParse(d);
  if (!check.success) {
    // A decision that cannot validate is not sent anywhere — the silent stub is.
    return forcedSilent(state, 'failure');
  }
  return d;
};

/**
 * Strictest-rule-wins: any non-'soft' rule in the final denial forces silent.
 * The bubble-shape rule (P-CADENCE CA.4) is SOFT BY LAW even before the yaml
 * section that carries it lands — `severityOf` answers undefined for it until
 * then, and a shape rejection must never hard-fail a turn — so it is exempted
 * here and resolved fail-open like any soft rule.
 */
const resolutionFor = (state: TurnState, ruleIds: readonly string[]): 'forced-silent' | 'fail-open' =>
  ruleIds.some((id) => id !== SHAPE_RULE_ID && state.gate.severityOf(id) !== 'soft') ? 'forced-silent' : 'fail-open';

const emitGateLoop = async (state: TurnState, ruleIds: readonly string[], resolution: 'forced-silent' | 'fail-open'): Promise<void> => {
  const payload = {
    turnId: state.turnId,
    ruleIds: [...ruleIds],
    reentries: state.reentries,
    resolution,
  };
  const check = GateLoopPayloadSchema.safeParse(payload);
  if (check.success) await emit(state.events, GATE_LOOP_INCIDENT, check.data, state.turnId);
};

// ---------------------------------------------------------------------------
// Committee entries
// ---------------------------------------------------------------------------

/**
 * A committee entry (ponder) executes its DAG and locks a silent decision —
 * ponder seeds future thinking, it does not speak. The artifact travels on the
 * decision.locked payload for M17 (see the docs deviation note).
 */
const runCommitteeEntry = async (entry: LoopEntry, deps: LoopDeps, state: TurnState): Promise<DecisionObject> => {
  const spec = entry.committee;
  if (spec === undefined) return failLoop('loop/bad-committee', 'committee entry without a CommitteeSpec');
  validateCommittee(spec);
  const res = await runCommittee(spec, {
    name: spec.name,
    model: deps.model,
    packet: state.packet,
    query: state.query,
    affect: deps.affect,
    turnId: state.turnId,
    signal: state.signal,
    maxTokens: deps.cfg.assessMaxTokens,
    temperature: deps.cfg.assessTemperature,
    tier: deps.cfg.spawnTier.committee,
  });
  if (!res.ok) state.truncated = true;
  const locked = lockDecision(state, {
    plan: 'silent',
    bubbles: [],
    confidence: 1,
    weight: 1,
    reluctance: 0,
    completeness: res.ok ? 1 : completenessCeiling(state),
  });
  await emit(
    deps.events,
    DECISION_LOCKED_KIND,
    {
      turnId: state.turnId,
      entry: entry.kind,
      plan: locked.plan,
      bubbles: 0,
      committee: spec.name,
      artifact: res.ok ? res.artifact : null,
      ...(res.error !== undefined ? { committeeError: res.error } : {}),
    },
    state.turnId,
  );
  return locked;
};

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export const runLoop: RunLoop = async (entry, deps) => {
  const cfg: LoopConfig = deps.cfg;
  // M20's pipeline pre-mints the id (the ledger links inbound→turn before the
  // loop runs); standalone entries get a loop-minted one.
  const turnId = entry.turnId ?? newId(deps.clock, deps.rng);
  const started = deps.clock.epochMs();
  const deadline = started + cfg.budgetMs[entry.kind];
  // One signal for the whole entry: fired at the wall-clock budget, so every
  // call this turn sees the same cut without anyone polling the clock. The
  // waiter rides its own gate so the `finally` below can CANCEL it (FA.2): a
  // turn that ends inside its budget must not leave a timer armed on the
  // clock — a long-lived process would hold one per turn, forever.
  const ac = new AbortController();
  const timerGate = new AbortController();
  void deps.clock.waitUntil(deadline, timerGate.signal).then(
    () => ac.abort(),
    () => {
      /* cancelled in finally — the turn ended inside its budget */
    },
  );
  try {
    const situation = entry.inbound !== undefined ? entry.inbound.text : (entry.goal ?? '');
    const query: LoopQuery = {
      entry: entry.kind,
      text: situation,
      goal: entry.goal,
      channels: { character: true, procedural: true },
      turnId,
    };

    const baseState: Omit<TurnState, 'tools' | 'defs' | 'packet'> = {
      model: deps.model,
      gate: deps.gate,
      events: deps.events,
      clock: deps.clock,
      rng: deps.rng,
      cfg,
      kind: entry.kind,
      turnId,
      entry,
      situation,
      query,
      affect: deps.affect,
      assemble: (q) => deps.assemble(q, deps.affect),
      window: deps.window,
      // P-LOOP (M21): the spine runner rides the deps when the config wires
      // one; absent, every assess call stays on the native model.chat path.
      ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
      deadline,
      signal: ac.signal,
      hops: 0,
      reentries: 0,
      usedObservationTokens: 0,
      inhibitions: [],
      toolTrace: [],
      spawns: [],
      truncated: false,
    };

    let packet: LoopPacket;
    try {
      packet = await deps.assemble(query, deps.affect);
    } catch (e) {
      // No context, no deliberation. A failure silence — loud (incident) and
      // recorded as failure so the reply stays owed (review 2026-09-02, P0-1f).
      await emit(deps.events, ASSEMBLE_FAILED_INCIDENT, { turnId, entry: entry.kind, error: e instanceof Error ? e.message : String(e) }, turnId);
      const failed = { ...baseState, truncated: true } as TurnState;
      return forcedSilent(failed, 'failure');
    }
    const state: TurnState = { ...baseState, packet, tools: createToolRegistry(), defs: [] };
    // FA.3 (D.6-8): under 'auto' the spawn primitives are registered only on
    // the delegation-capable entries — a user turn offers `decide` alone, and
    // an off-wire spawn attempt is answered as the unknown tool it is.
    const spawnsActive = cfg.spawns === 'always' || (cfg.spawns === 'auto' && SPAWN_ENTRY_KINDS.includes(entry.kind));
    // The spawn primitives close over this very state; the late tools binding is
    // safe because handlers read state.* at call time, never at bind time.
    state.tools = spawnsActive ? overlayRegistry(deps.tools, spawnEntries(state)) : deps.tools;
    // `decide` travels first: the contract is the most prominent thing on the wire.
    state.defs = [decideToolDef, ...state.tools.defs(entry.kind)];

    try {
      if (entry.committee !== undefined) return await runCommitteeEntry(entry, deps, state);

      const msgs: ChatMsg[] = buildMessages({
        packet,
        window: deps.window,
        turnText: situation,
        placement: cfg.inhibitionPlacement,
        outputContract: OUTPUT_CONTRACT,
      });

      /** Records how a decision arrived; a prose fold is worth knowing about. */
      const noteVia = async (via: 'decide' | 'json' | 'prose', bubbles: number): Promise<void> => {
        if (via === 'prose') await emit(state.events, DECISION_PROSE_FOLDED, { turnId: state.turnId, bubbles }, state.turnId);
      };

      /** Settle one reply with the one repair rung; null ⇒ typed failure already emitted. */
      const settleOrRepair = async (res: ChatResponse): Promise<ModelDecision | null> => {
        const s = settleReply(res);
        if (s.kind === 'decision') {
          await noteVia(s.via, s.value.bubbles.length);
          return s.value;
        }
        if (s.kind === 'tools') return failLoop('loop/decision-invalid', 'settleOrRepair called on a tool round');
        // Exactly one repair, on the same (voice) door, then the typed failure path (§5.2).
        const repaired = await repairOnce(state, msgs, s.malformed, s.error);
        if (repaired.ok) return repaired.value;
        await emit(
          state.events,
          DECISION_PARSE_INCIDENT,
          { turnId: state.turnId, schema: 'DecisionObject', rung: 'repair', error: repaired.error },
          state.turnId,
        );
        return null;
      };

      // -- assess / mediate loop ------------------------------------------------
      let decision: ModelDecision | null = null;
      let exhaustedRuleIds: string[] | null = null;
      for (;;) {
        if (state.hops >= cfg.maxToolHops || state.clock.epochMs() >= deadline) {
          state.truncated = true;
          break;
        }
        const res: ChatResponse = await assess(state, msgs, { tier: 'main', taskClass: taskClassFor(entry.kind) });
        const s = settleReply(res);
        if (s.kind === 'tools') {
          state.hops += 1;
          const med = await mediate(state, msgs, s.calls, 0);
          if (med.denied) {
            state.reentries += 1;
            if (state.reentries > MAX_GATE_REENTRIES) {
              exhaustedRuleIds = med.deniedRuleIds;
              break;
            }
          }
          continue;
        }
        decision = await settleOrRepair(res);
        break;
      }

      if (exhaustedRuleIds !== null) {
        const resolution = resolutionFor(state, exhaustedRuleIds);
        await emitGateLoop(state, exhaustedRuleIds, resolution);
        if (resolution === 'forced-silent') return forcedSilent(state, 'gate');
        // Fail-open: one final decision call with only `decide` on the wire, so
        // the blocked path cannot re-fire; the decision still passes checkPlan below.
        const res = await assess(state, msgs, { tier: 'main', taskClass: taskClassFor(entry.kind) }, [decideToolDef]);
        if ((res.toolCalls ?? []).some((c) => !isDecideCall(c))) {
          // It reached for a tool again with none offered — a refusal to decide.
          return forcedSilent(state, 'failure');
        }
        decision = await settleOrRepair(res);
        if (decision === null) return forcedSilent(state, 'failure');
      }

      if (decision === null) {
        // Parse failure (already an incident) or hop/budget exhaustion without a
        // decision on the table: nobody decided — the reply stays owed.
        return forcedSilent(state, 'failure');
      }

      // -- plan gate ------------------------------------------------------------
      for (;;) {
        // Normalize BEFORE the gate so the verdicts judge what will actually send:
        // the yaml's normalize class is character-only and idempotent, and nothing
        // downstream rewrites text (M14 stays pure).
        decision = { ...decision, bubbles: decision.bubbles.map((b) => deps.gate.normalizeText(b)) };
        const planVerdict = deps.gate.checkPlan({ plan: decision.plan, bubbles: decision.bubbles });
        state.inhibitions.push(planVerdict);
        // P-CADENCE CA.4, composed here (the W1 wiring handoff): the bubble-shape
        // rule is a SOFT gate beside checkPlan, consulted when the compiled plan
        // rules allowed. A rejection joins the existing soft re-entry ladder with
        // the one neutral reason ('split shorter') as the revise hint; only the
        // rejection is recorded (an allow is the default state — audits read the
        // rejects). At the cap it fails open (resolutionFor); it never hard-fails.
        const shapeVerdict =
          planVerdict.allow
            ? checkBubbleShape({ bubbles: decision.bubbles, weight: decision.weight })
            : null;
        if (shapeVerdict !== null && !shapeVerdict.allow) state.inhibitions.push(shapeVerdict);
        const verdict = shapeVerdict !== null && !shapeVerdict.allow ? shapeVerdict : planVerdict;
        if (verdict.allow) break;
        state.reentries += 1;
        if (state.reentries > MAX_GATE_REENTRIES) {
          const resolution = resolutionFor(state, [verdict.ruleId]);
          await emitGateLoop(state, [verdict.ruleId], resolution);
          if (resolution === 'forced-silent') return forcedSilent(state, 'gate');
          break; // fail-open: the denied draft locks as-is
        }
        // Plan-path re-entry: the denied draft and the hint go into context, and
        // she revises (no tools on a revision call — the blocked path is the plan).
        msgs.push({ role: 'assistant', content: decision.bubbles.join('\n\n') });
        msgs.push({ role: 'user', content: `${verdict.hint}\n\nRevise your decision.` });
        const res = await assess(state, msgs, { tier: 'main', taskClass: taskClassFor(entry.kind) });
        const s = settleReply(res);
        if (s.kind === 'tools') {
          // A revision call that reaches for tools is mediated like any other.
          state.hops += 1;
          await mediate(state, msgs, s.calls, 0);
          continue;
        }
        const revised = await settleOrRepair(res);
        if (revised === null) return forcedSilent(state, 'failure');
        decision = revised;
      }

      const locked = lockDecision(state, decision);
      await emit(
        deps.events,
        DECISION_LOCKED_KIND,
        { turnId, entry: entry.kind, plan: locked.plan, decidedBy: locked.decidedBy, bubbles: locked.bubbles.length, committee: entry.committee !== undefined },
        turnId,
      );
      return locked;
    } catch (e) {
      // FA.1 — a runtime throw from assess/mediate/repair/gate is a VALUE, not
      // an exception: loud (the incident names the code), then a failure
      // silence so the ledger keeps the reply owed. Structural sins (LoopError)
      // rethrow — the pipeline cannot recover from those by continuing.
      if (e instanceof LoopError) throw e;
      if (state.clock.epochMs() >= state.deadline) state.truncated = true; // the deadline cut this turn short
      const payload = { turnId: state.turnId, code: asError(e).code, stage: 'loop' as const };
      const check = TurnAbortedPayloadSchema.safeParse(payload);
      if (check.success) await emit(state.events, TURN_ABORTED_INCIDENT, check.data, state.turnId);
      return forcedSilent(state, 'failure');
    }
  } finally {
    timerGate.abort(); // FA.2: the deadline timer is cancelled when the turn ends
  }
};
