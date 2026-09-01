// M03 model — deterministic JSON salvage + repair-prompt construction.
// Pure functions: no clock, no rng, no I/O. Goldens pin every prompt byte.

import type { ChatMsg, ToolCall } from './types.js';

export type LooseParse =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * JSON.parse with a small, conservative salvage ladder for the two malformations
 * models actually produce: markdown fences and trailing commas. Anything else is
 * reported as a failure — silent guessing here would launder garbage into typed
 * domain objects.
 */
export const looseJsonParse = (text: string): LooseParse => {
  const attempts: string[] = [text];
  const trimmed = text.trim();
  if (trimmed !== text) attempts.push(trimmed);
  const unfenced = stripCodeFence(trimmed);
  if (unfenced !== trimmed) attempts.push(unfenced);
  const noTrailing = removeTrailingCommas(unfenced);
  if (noTrailing !== unfenced) attempts.push(noTrailing);

  let lastError = 'empty input';
  for (const candidate of attempts) {
    if (candidate === '') continue;
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
};

const stripCodeFence = (text: string): string => {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  return m?.[1] ?? text;
};

const removeTrailingCommas = (text: string): string => text.replace(/,(\s*[}\]])/g, '$1');

// ---------------------------------------------------------------------------
// Repair prompts (the one-shot cheap-tier re-ask). Goldens in test/model pin
// these byte-for-byte — a prompt change is a behavior change.
// ---------------------------------------------------------------------------

export interface StructuredRepairInput {
  original: readonly ChatMsg[];
  malformed: string;
  schemaJson: string;
  error: string;
}

/** Original conversation + the malformed reply + one correction instruction. */
export const structuredRepairMessages = (input: StructuredRepairInput): ChatMsg[] => [
  ...input.original,
  { role: 'assistant', content: input.malformed },
  {
    role: 'user',
    content:
      `Your previous reply could not be parsed against the required schema.\n\n` +
      `Parse error:\n${input.error}\n\n` +
      `Required JSON Schema (draft 2020-12):\n${input.schemaJson}\n\n` +
      `Your previous reply was:\n${input.malformed}\n\n` +
      `Reply with ONLY the corrected JSON object. No prose, no markdown fences.`,
  },
];

export interface ToolArgsRepairInput {
  original: readonly ChatMsg[];
  malformed: readonly ToolCall[];
  rawArguments: ReadonlyMap<string, string>;
  error: string;
}

/**
 * Ask for the arguments again as one JSON object keyed by tool-call id — a
 * single, mechanically parseable shape that cannot reorder the calls.
 */
export const toolArgsRepairMessages = (input: ToolArgsRepairInput): ChatMsg[] => {
  const listing = input.malformed
    .map((c) => `- id: ${c.id}\n  name: ${c.name}\n  arguments: ${input.rawArguments.get(c.id) ?? '<missing>'}`)
    .join('\n');
  return [
    ...input.original,
    {
      role: 'user',
      content:
        `Your tool call arguments were not valid JSON.\n\n` +
        `Parse error:\n${input.error}\n\n` +
        `Malformed tool calls:\n${listing}\n\n` +
        `Reply with ONLY a JSON object mapping each tool-call id to its corrected arguments object, ` +
        `for example {"${input.malformed[0]?.id ?? '<id>'}": {"arg": "value"}}. ` +
        `No prose, no markdown fences.`,
    },
  ];
};

/** Rung-(c) trailing system message: prompted JSON without response_format. */
export const promptedJsonInstruction = (schemaJson: string): string =>
  `[OUTPUT FORMAT]\n` +
  `Reply with a single JSON object and nothing else. It must validate against this ` +
  `JSON Schema (draft 2020-12):\n${schemaJson}\n` +
  `No prose, no markdown fences, no comments.`;

/** Rung (b) forces the schema through this single synthetic function. */
export const EMIT_TOOL_NAME = 'emit';

// ---------------------------------------------------------------------------
// Token estimate for doubles (MockModel usage when a script does not pin it).
// Deterministic: ~4 chars/token, no entropy.
// ---------------------------------------------------------------------------

export const estimateTokens = (parts: readonly string[]): number => {
  let chars = 0;
  for (const p of parts) chars += p.length;
  return Math.max(1, Math.ceil(chars / 4));
};
