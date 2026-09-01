// M13 loop — the deliberation entry (docs/modules/M13-loop.md §Behavior spec).
// One sequence behind all three entry contexts: assemble the packet, assess on
// the main tier, zero or more mediated tool rounds, lock the DecisionObject,
// gate.checkPlan, return. Everything mechanical lives in turn.ts; this file is
// the spec's sequence, readable top to bottom.
//
// Failure posture: a turn survives its own runtime failures as VALUES — a
// forced-silent DecisionObject plus an incident event. Exceptions are for
// structural sins (a bad committee spec, a broken registry), which the
// pipeline cannot recover from by continuing.

import { MAX_GATE_REENTRIES } from '../inhibit/index.js';
import { newId } from '../kernel/index.js';
import {
  looseJsonParse,
  schemaJsonForPrompt,
  structuredRepairMessages,
  type ChatMsg,
  type ChatResponse,
  type ToolCall,
} from '../model/index.js';
import type { DecisionObject, LoopDeps, LoopEntry, LoopPacket, LoopQuery, ModelDecision, RunLoop } from './types.js';
import { createToolRegistry, overlayRegistry } from './registry.js';
import { buildMessages } from './messages.js';
import { validateCommittee, runCommittee } from './committee.js';
import {
  assess,
  emit,
  mediate,
  spawnEntries,
  taskClassFor,
  type TurnState,
} from './turn.js';
import { failLoop } from './errors.js';
import {
  DECISION_LOCKED_KIND,
  DECISION_PARSE_INCIDENT,
  DecisionObjectSchema,
  GATE_LOOP_INCIDENT,
  GateLoopPayloadSchema,
  ModelDecisionSchema,
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
  const check = ModelDecisionSchema.safeParse(normalizeDecision(parsed.value));
  if (!check.success) return { ok: false, error: decisionIssue(check.error) };
  return { ok: true, value: check.data };
};

/** The one-shot repair: same conversation + the malformed reply + the correction
 * instruction, on the cheap tier, no schema on the wire (M03's repair idiom). */
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
      tier: 'cheap',
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

const forcedSilent = (state: TurnState): DecisionObject => {
  const d: DecisionObject = {
    turnId: state.turnId,
    plan: 'silent',
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
    return forcedSilent(state);
  }
  return d;
};

/** Strictest-rule-wins: any non-'soft' rule in the final denial forces silent. */
const resolutionFor = (state: TurnState, ruleIds: readonly string[]): 'forced-silent' | 'fail-open' =>
  ruleIds.some((id) => state.gate.severityOf(id) !== 'soft') ? 'forced-silent' : 'fail-open';

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
  const turnId = newId(deps.clock, deps.rng);
  const started = deps.clock.epochMs();
  const deadline = started + cfg.budgetMs[entry.kind];
  // One signal for the whole entry: fired at the wall-clock budget, so every
  // call this turn sees the same cut without anyone polling the clock.
  const ac = new AbortController();
  void deps.clock.waitUntil(deadline).then(
    () => ac.abort(),
    () => ac.abort(),
  );

  const situation = entry.inbound !== undefined ? entry.inbound.text : (entry.goal ?? '');
  const query: LoopQuery = {
    entry: entry.kind,
    text: situation,
    goal: entry.goal,
    channels: { character: true, procedural: true },
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
    situation,
    query,
    affect: deps.affect,
    assemble: (q) => deps.assemble(q, deps.affect),
    window: deps.window,
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
  } catch {
    // No context, no deliberation. Lock silent; schemas/events.ts defines no
    // incident kind for an assembly failure (see the docs deviation note).
    const failed = { ...baseState, truncated: true } as TurnState;
    return forcedSilent(failed);
  }
  const state: TurnState = { ...baseState, packet, tools: createToolRegistry(), defs: [] };
  // The spawn primitives close over this very state; the late tools binding is
  // safe because handlers read state.* at call time, never at bind time.
  state.tools = overlayRegistry(deps.tools, spawnEntries(state));
  state.defs = state.tools.defs(entry.kind);

  if (entry.committee !== undefined) return runCommitteeEntry(entry, deps, state);

  const msgs: ChatMsg[] = buildMessages({
    packet,
    window: deps.window,
    turnText: situation,
    placement: cfg.inhibitionPlacement,
  });

  // -- assess / mediate loop ------------------------------------------------
  let decision: ModelDecision | null = null;
  let exhaustedRuleIds: string[] | null = null;
  for (;;) {
    if (state.hops >= cfg.maxToolHops || state.clock.epochMs() >= deadline) {
      state.truncated = true;
      break;
    }
    const res: ChatResponse = await assess(state, msgs, { tier: 'main', taskClass: taskClassFor(entry.kind) });
    const calls: readonly ToolCall[] = res.toolCalls ?? [];
    if (calls.length > 0) {
      state.hops += 1;
      const med = await mediate(state, msgs, calls, 0);
      if (med.denied) {
        state.reentries += 1;
        if (state.reentries > MAX_GATE_REENTRIES) {
          exhaustedRuleIds = med.deniedRuleIds;
          break;
        }
      }
      continue;
    }
    const parsed = parseDecision(res.content);
    if (parsed.ok) {
      decision = parsed.value;
      break;
    }
    // Exactly one cheap-tier repair, then the typed failure path (§5.2).
    const repaired = await repairOnce(state, msgs, res.content, parsed.error);
    if (repaired.ok) {
      decision = repaired.value;
      break;
    }
    await emit(
      state.events,
      DECISION_PARSE_INCIDENT,
      { turnId: state.turnId, schema: 'DecisionObject', rung: 'repair', error: repaired.error },
      state.turnId,
    );
    break;
  }

  if (exhaustedRuleIds !== null) {
    const resolution = resolutionFor(state, exhaustedRuleIds);
    await emitGateLoop(state, exhaustedRuleIds, resolution);
    if (resolution === 'forced-silent') return forcedSilent(state);
    // Fail-open: one final decision call with no tools on the wire, so the
    // blocked path cannot re-fire; the decision still passes checkPlan below.
    const res = await assess(state, msgs, { tier: 'main', taskClass: taskClassFor(entry.kind) });
    const parsed = parseDecision(res.content);
    if (parsed.ok) {
      decision = parsed.value;
    } else {
      const repaired = await repairOnce(state, msgs, res.content, parsed.error);
      if (repaired.ok) decision = repaired.value;
      else {
        await emit(
          state.events,
          DECISION_PARSE_INCIDENT,
          { turnId: state.turnId, schema: 'DecisionObject', rung: 'repair', error: repaired.error },
          state.turnId,
        );
        return forcedSilent(state);
      }
    }
  }

  if (decision === null) {
    // Hop/budget exhaustion without a decision on the table.
    return forcedSilent(state);
  }

  // -- plan gate ------------------------------------------------------------
  for (;;) {
    const verdict = deps.gate.checkPlan({ plan: decision.plan, bubbles: decision.bubbles });
    state.inhibitions.push(verdict);
    if (verdict.allow) break;
    state.reentries += 1;
    if (state.reentries > MAX_GATE_REENTRIES) {
      const resolution = resolutionFor(state, [verdict.ruleId]);
      await emitGateLoop(state, [verdict.ruleId], resolution);
      if (resolution === 'forced-silent') return forcedSilent(state);
      break; // fail-open: the denied draft locks as-is
    }
    // Plan-path re-entry: the denied draft and the hint go into context, and
    // she revises (no tools on a revision call — the blocked path is the plan).
    msgs.push({ role: 'assistant', content: decision.bubbles.join('\n\n') });
    msgs.push({ role: 'user', content: `${verdict.hint}\n\nRevise your decision.` });
    const res = await assess(state, msgs, { tier: 'main', taskClass: taskClassFor(entry.kind) });
    const calls: readonly ToolCall[] = res.toolCalls ?? [];
    if (calls.length > 0) {
      // A revision call that reaches for tools is mediated like any other.
      state.hops += 1;
      await mediate(state, msgs, calls, 0);
      continue;
    }
    const parsed = parseDecision(res.content);
    if (parsed.ok) {
      decision = parsed.value;
      continue;
    }
    const repaired = await repairOnce(state, msgs, res.content, parsed.error);
    if (repaired.ok) {
      decision = repaired.value;
      continue;
    }
    await emit(
      state.events,
      DECISION_PARSE_INCIDENT,
      { turnId: state.turnId, schema: 'DecisionObject', rung: 'repair', error: repaired.error },
      state.turnId,
    );
    return forcedSilent(state);
  }

  const locked = lockDecision(state, decision);
  await emit(
    deps.events,
    DECISION_LOCKED_KIND,
    { turnId, entry: entry.kind, plan: locked.plan, bubbles: locked.bubbles.length, committee: entry.committee !== undefined },
    turnId,
  );
  return locked;
};
