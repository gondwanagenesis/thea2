// M13 loop — the committee: a scripted DAG executed over the loop machinery.
// Ponder is one (SEED->GROUND->REVISE->ARTIFACT); M17 supplies the spec, the
// loop only executes it. Two invariants live here:
//   * nodes run in dependency order, never concurrently across an edge;
//   * a `requiresObservation` node is structurally unreachable without upstream
//     input — enforced by DAG shape (validateCommittee), never by prompt.
//
// Node calls are plain model calls (no tools): a committee's grounding arrives
// through the DAG's own edges. Tool work belongs to the deliberation that
// spawned the committee or to a fork/task subprocess.

import { isModelError } from '../model/index.js';
import type { ChatMsg, ChatResponse, ModelClient, ReasoningEffort } from '../model/index.js';
import type { LoopPacket, CommitteeSpec, CommitteeResult, Vec12, LoopQuery } from './types.js';
import { failLoop } from './errors.js';
import { decisionIssue } from './schema.js';

/** One namespaced failure mode for a spec that is not a DAG she can execute. */
export const validateCommittee = (spec: CommitteeSpec): void => {
  if (spec.nodes.length === 0) return failLoop('loop/bad-committee', `committee '${spec.name}' has no nodes`);
  const ids = new Set<string>();
  for (const n of spec.nodes) {
    if (ids.has(n.id)) return failLoop('loop/bad-committee', `committee '${spec.name}' declares node '${n.id}' twice`);
    ids.add(n.id);
  }
  for (const n of spec.nodes) {
    for (const need of n.needs) {
      if (!ids.has(need)) {
        return failLoop('loop/bad-committee', `committee '${spec.name}' node '${n.id}' needs unknown node '${need}'`);
      }
    }
    // The observation rule as a shape: a node that consumes a grounding
    // observation must have somewhere for it to come from.
    if (n.requiresObservation === true && n.needs.length === 0) {
      return failLoop(
        'loop/bad-committee',
        `committee '${spec.name}' node '${n.id}' requiresObservation but has no needs edge — a grounding observation cannot materialize from nothing`,
      );
    }
  }
  if (topoOrder(spec) === null) {
    return failLoop('loop/bad-committee', `committee '${spec.name}' has a cycle — a scripted DAG must terminate`);
  }
};

/** Kahn's algorithm over the declared order; null when the graph is cyclic. */
export const topoOrder = (spec: CommitteeSpec): string[] | null => {
  const pending = new Map<string, number>(spec.nodes.map((n) => [n.id, n.needs.length]));
  const dependents = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]));
  for (const n of spec.nodes) {
    for (const need of n.needs) dependents.get(need)?.push(n.id);
  }
  const order: string[] = [];
  let frontier = spec.nodes.filter((n) => (pending.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      order.push(id);
      for (const dep of dependents.get(id) ?? []) {
        const left = (pending.get(dep) ?? 1) - 1;
        pending.set(dep, left);
        if (left === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  return order.length === spec.nodes.length ? order : null;
};

export interface CommitteeEnv {
  name: string;
  model: ModelClient;
  packet: LoopPacket;
  query: LoopQuery;
  affect: Vec12;
  turnId: string;
  signal: AbortSignal;
  maxTokens: number;
  temperature: number;
  /** Tier for node calls (cfg.spawnTier.committee). */
  tier: 'main' | 'cheap' | 'reasoning';
  /**
   * PO.1: optional reasoning-control override for node calls. Absent, the
   * client applies the class default (REASONING_BY_CLASS['ponder-seed'] =
   * 'low'); set, it wins over that default (DR.2).
   */
  reasoning?: ReasoningEffort | undefined;
}

/**
 * Runs the DAG in dependency order. `ok:false` is a graceful outcome — the
 * committee failed, the deliberation continues with the error in context; a
 * committee never kills a turn.
 */
export const runCommittee = async (spec: CommitteeSpec, env: CommitteeEnv): Promise<CommitteeResult> => {
  validateCommittee(spec);
  const namedEnv: CommitteeEnv = { ...env, name: spec.name };
  const order = topoOrder(spec);
  if (order === null) return { ok: false, outputs: [], artifact: null, error: 'committee DAG is cyclic' };

  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const outputs = new Map<string, string>();
  const values = new Map<string, unknown>();

  for (const id of order) {
    const node = byId.get(id);
    if (node === undefined) continue;
    try {
      const res = await runNode(node, outputs, namedEnv);
      outputs.set(id, res.text);
      values.set(id, res.value);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { ok: false, outputs: [...outputs].map(([k, v]) => ({ id: k, output: v })), artifact: null, error };
    }
  }

  // The terminal node (no dependents; last in execution order if several) is the artifact.
  const hasDependent = new Set(spec.nodes.flatMap((n) => n.needs));
  const terminal = [...order].reverse().find((id) => !hasDependent.has(id));
  const terminalNode = terminal !== undefined ? byId.get(terminal) : undefined;
  if (terminalNode === undefined) {
    return { ok: false, outputs: [...outputs].map(([k, v]) => ({ id: k, output: v })), artifact: null, error: 'committee has no terminal node' };
  }
  const artifact = values.get(terminalNode.id);
  const check = spec.output.safeParse(artifact);
  if (!check.success) {
    return {
      ok: false,
      outputs: [...outputs].map(([k, v]) => ({ id: k, output: v })),
      artifact,
      error: `committee '${spec.name}' artifact failed its output schema: ${decisionIssue(check.error)}`,
    };
  }
  return { ok: true, outputs: [...outputs].map(([k, v]) => ({ id: k, output: v })), artifact: check.data };
};

interface NodeOutcome {
  text: string;
  value: unknown;
}

const runNode = async (
  node: CommitteeSpec['nodes'][number],
  upstream: ReadonlyMap<string, string>,
  env: CommitteeEnv,
): Promise<NodeOutcome> => {
  const messages: ChatMsg[] = [
    { role: 'system', content: nodeSystem(node, env) },
    { role: 'user', content: nodePrompt(node, upstream) },
  ];
  let res: ChatResponse<unknown>;
  try {
    res = await env.model.chat(
      {
        taskClass: 'ponder-seed',
        tier: env.tier,
        messages,
        maxTokens: env.maxTokens,
        temperature: env.temperature,
        // PO.1: a node that declares a schema carries it on the request — the
        // structured ladder runs (rung per capability, one-shot repair), and the
        // reply arrives as the ladder-VALIDATED value, not prose to hand-parse.
        ...(node.schema === undefined
          ? {}
          : { schema: node.schema, schemaName: `committee:${env.name}:${node.id}` }),
        ...(env.reasoning === undefined ? {} : { reasoning: env.reasoning }),
      },
      { turnId: env.turnId, signal: env.signal },
    );
  } catch (e) {
    // The typed code survives into the committee's failure value: a truncated
    // node is never mistaken for a schema miss or an empty answer.
    const code = isModelError(e) ? `${e.code}: ` : '';
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`node '${node.id}' failed: ${code}${detail}`);
  }
  if (node.schema === undefined) return { text: res.content as string, value: res.content };
  // The ladder already parsed AND validated against node.schema — content is
  // the typed value. The edge text is its JSON form (upstream prompts embed it).
  const value = res.content;
  return { text: typeof value === 'string' ? value : JSON.stringify(value), value };
};

/** Per-node channel composition — the same rule the spawn primitives follow. */
const nodeSystem = (node: CommitteeSpec['nodes'][number], env: CommitteeEnv): string => {
  const parts: string[] = [];
  if (node.channels.character) parts.push(env.packet.systemText());
  if (node.channels.procedural) {
    const proc = env.packet.proceduralText();
    if (proc !== null && proc !== '') parts.push(proc);
  }
  if (parts.length === 0) {
    parts.push(`You are executing one node of the '${env.name}' committee. Answer with the node's output only.`);
  }
  return parts.join('\n\n');
};

const nodePrompt = (node: CommitteeSpec['nodes'][number], upstream: ReadonlyMap<string, string>): string => {
  const lines =
    node.needs.length === 0
      ? 'INPUTS: none — this node starts the committee.'
      : ['INPUTS from earlier nodes:', ...node.needs.map((id) => `- ${id}: ${upstream.get(id) ?? ''}`)].join('\n');
  const format =
    node.schema === undefined ? '' : '\n\nReply with a single JSON object and nothing else. No prose, no markdown fences.';
  return `${node.prompt}\n\n${lines}${format}`;
};
