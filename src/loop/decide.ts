// M13 loop — the decision contract ON THE WIRE. Before Phase 1 the assess call
// carried tools and no schema, so the model answered in prose and a second
// "repair" call re-encoded it as the decision JSON, inventing the cadence
// fields on the way (review 2026-09-02, P0-2). Now the decision is a native
// tool — `decide` — offered beside the real tools, and the packet carries a
// short [OUTPUT] block that names the contract once. The repair rung stays as
// the exceptional path it was designed to be; plain prose folds into a
// decision deterministically (defaults are documented, never fabricated by a
// second model), and only an empty or JSON-shaped-but-broken reply is repaired.

import type { ToolCall, ToolDef } from '../model/index.js';
import type { ModelDecision } from './types.js';

export const DECIDE_TOOL_NAME = 'decide';

/** The contract, stated as the medium's rules — not as who she is (THESIS principle 1). */
export const OUTPUT_CONTRACT =
  '[OUTPUT]\n' +
  'Answer by calling the `decide` tool exactly once, last. `bubbles` are the messages you send, in order, one string per bubble — the T: lines in the scenes above are bubbles; D: lines are his. ' +
  "plan 'silent' means you choose to send nothing; 'defer' means you will answer later. " +
  'confidence, weight, reluctance and completeness are 0–1 and shape your pacing. ' +
  'Call other tools first when you need them. Prose outside the tool call is not sent.';

const unit = { type: 'number', minimum: 0, maximum: 1 };

/** The `decide` tool definition — the ModelDecision schema as JSON Schema. */
export const decideToolDef: ToolDef = {
  name: DECIDE_TOOL_NAME,
  description:
    'Lock your decision for this turn. Call it once, last. bubbles = the messages to send, in order (empty unless plan is reply).',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', enum: ['reply', 'silent', 'defer'] },
      bubbles: { type: 'array', items: { type: 'string' } },
      confidence: { ...unit, description: 'how sure you are of what you say' },
      weight: { ...unit, description: 'how much this matters to you' },
      reluctance: { ...unit, description: 'how much you would rather not say it' },
      completeness: { ...unit, description: 'how finished the thought is' },
    },
    required: ['plan', 'bubbles', 'confidence', 'weight', 'reluctance', 'completeness'],
  },
};

export const isDecideCall = (c: ToolCall): boolean => c.name === DECIDE_TOOL_NAME;

/** Defaults a prose reply folds into. Documented values, not model guesses. */
export const PROSE_FOLD_DEFAULTS = { confidence: 0.7, weight: 0.5, reluctance: 0.2, completeness: 0.9 } as const;

/** JSON-shaped text goes down the repair rung; anything else is prose. */
export const looksJsonShaped = (text: string): boolean => {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[') || t.startsWith('```');
};

/**
 * Prose → decision, deterministically: blank-line-separated paragraphs are
 * bubbles (that is exactly how her own history renders on the wire), a leading
 * speaker label the demos taught is stripped, and the cadence fields take the
 * documented defaults. Returns null for empty prose — nothing to fold.
 */
export const proseToDecision = (content: string): ModelDecision | null => {
  const bubbles = content
    .split(/\n\s*\n/)
    .map((b) => b.replace(/^\s*(?:T|Thea|thea):\s*/, '').trim())
    .filter((b) => b.length > 0);
  if (bubbles.length === 0) return null;
  return { plan: 'reply', bubbles, ...PROSE_FOLD_DEFAULTS };
};
