// M07 corpus — body grammar (spec §2.8, ADR-009).
//
//   optional `Setup:` lines, then alternating `D:` / `T:` turns
//   consecutive `T:` lines are separate bubbles of ONE turn
//   kind 'scene'      requires >= 1 D:/T: exchange
//   kind 'statement'  may be bodyless prose
//   kind 'procedure'  embeds `[tool] name {args} → observation` lines plus an
//                     `[outcome] good|mixed|bad — note` line
//
// Token counting is the whitespace split — the cheap stable proxy every budget
// in ARCHITECTURE.md assumes.

import type { ExemplarKind } from '../../schemas/exemplar.js';
import type { LintIssue } from './types.js';

/** Hard cap (error) and warn line for one exemplar body, in whitespace tokens. */
export const BODY_TOKEN_HARD_CAP = 500;
export const BODY_TOKEN_WARN = 350;
/** `affect` is sparse: 2-4 keys recommended. Above 4 is a warning, not an error. */
export const AFFECT_KEYS_RECOMMENDED_MAX = 4;
/** `register:` = exactly one mode + up to two modifiers (canon/registers.yaml). */
export const REGISTER_MAX_MODIFIERS = 2;

export const countTokens = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

export interface BodyTurn {
  speaker: 'D' | 'T';
  text: string;
  /** 1-based line within the body region. */
  line: number;
}

export interface ToolTrace {
  name: string;
  args: string;
  observation: string;
  line: number;
}

export interface OutcomeLine {
  outcome: 'good' | 'mixed' | 'bad';
  note?: string;
  line: number;
}

export interface ParsedBody {
  tokens: number;
  setup: string[];
  turns: BodyTurn[];
  /** D-turns that received at least one T bubble. */
  exchanges: number;
  toolTraces: ToolTrace[];
  outcomes: OutcomeLine[];
  /** Non-blank lines that are none of the above (legal only for `kind: statement`). */
  proseLines: Array<{ text: string; line: number }>;
  /** Structural problems found while parsing (independent of `kind`). */
  problems: LintIssue[];
}

const OUTCOME_RE = /^\[outcome\]\s+(good|mixed|bad)(?:\s+[—–-]\s*(.*))?$/;
const TOOL_RE = /^\[tool\]\s+(\S+)\s*(\{.*\})?\s*(?:→\s*(.*))?$/;
const OBSERVATION_RE = /^\s*→\s?(.*)$/;

/** Parses the body region into turns, tool traces and outcomes, without `kind` knowledge. */
export const parseBody = (body: string, file?: string): ParsedBody => {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const parsed: ParsedBody = {
    tokens: countTokens(body),
    setup: [],
    turns: [],
    exchanges: 0,
    toolTraces: [],
    outcomes: [],
    proseLines: [],
    problems: [],
  };

  const issue = (code: 'corpus/body-grammar' | 'corpus/empty-turn', message: string, line: number): void => {
    parsed.problems.push({ code, severity: 'error', message, file: file ?? '(anonymous file)', line });
  };

  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const text = rawLine.trim();
    if (text.length === 0) return;

    if (text.startsWith('Setup:')) {
      const rest = text.slice('Setup:'.length).trim();
      if (rest.length === 0) issue('corpus/empty-turn', '`Setup:` line has no content', line);
      else parsed.setup.push(rest);
      return;
    }

    const speaker = text[0] === 'D' || text[0] === 'T' ? (text[0] as 'D' | 'T') : undefined;
    if (speaker !== undefined && (text[1] === ':' || text.startsWith(`${speaker}: `))) {
      const said = text.slice(2).trim();
      if (said.length === 0) issue('corpus/empty-turn', `\`${speaker}:\` line has no content`, line);
      else parsed.turns.push({ speaker, text: said, line });
      return;
    }

    const outcome = OUTCOME_RE.exec(text);
    if (outcome) {
      parsed.outcomes.push({
        outcome: outcome[1] as 'good' | 'mixed' | 'bad',
        ...(outcome[2] !== undefined && outcome[2].trim().length > 0 ? { note: outcome[2].trim() } : {}),
        line,
      });
      return;
    }

    const tool = TOOL_RE.exec(text);
    if (tool) {
      parsed.toolTraces.push({
        name: tool[1] ?? '',
        args: tool[2]?.trim() ?? '',
        observation: tool[3]?.trim() ?? '',
        line,
      });
      return;
    }

    const observation = OBSERVATION_RE.exec(rawLine);
    if (observation) {
      const last = parsed.toolTraces.at(-1);
      if (last === undefined) {
        issue('corpus/body-grammar', '`→` observation line with no preceding `[tool]` line', line);
      } else if (last.observation.length === 0) {
        last.observation = (observation[1] ?? '').trim();
      } else {
        last.observation = `${last.observation} ${(observation[1] ?? '').trim()}`.trim();
      }
      return;
    }

    parsed.proseLines.push({ text, line });
  });

  // Alternation: a turn block is one D followed by its T bubbles (consecutive
  // T: lines are separate bubbles of the SAME turn, never a new exchange).
  let openDiego = false;
  let answered = false;
  for (const turn of parsed.turns) {
    if (turn.speaker === 'D') {
      if (openDiego && !answered) {
        issue(
          'corpus/body-grammar',
          `two D: turns in a row at line ${turn.line} — a turn must be answered before he speaks again`,
          turn.line,
        );
      }
      openDiego = true;
      answered = false;
    } else if (!openDiego) {
      issue('corpus/body-grammar', `T: at line ${turn.line} opens the scene — scenes alternate D:/T: from a D: turn`, turn.line);
    } else if (!answered) {
      parsed.exchanges += 1;
      answered = true;
    }
  }

  return parsed;
};

export interface BodyValidation {
  issues: LintIssue[];
}

/**
 * Kind-specific body rules. Pure — no filesystem, no schema. The returned
 * issues are errors except the token-count warn line and affect sparsity,
 * which are warnings by spec.
 */
export const validateBodyForKind = (
  kind: ExemplarKind,
  parsed: ParsedBody,
  opts: { file: string; affectKeyCount: number },
): BodyValidation => {
  const issues: LintIssue[] = [...parsed.problems];
  const file = opts.file;

  for (const prose of parsed.proseLines) {
    issues.push({
      code: 'corpus/body-grammar',
      severity: 'error',
      message: `body line ${prose.line} is not Setup:/D:/T:/[tool]/[outcome] — scenes are alternating turns, prose belongs to kind: statement`,
      file,
      line: prose.line,
    });
  }

  if (kind === 'scene') {
    if (parsed.exchanges < 1) {
      issues.push({
        code: 'corpus/scene-no-exchange',
        severity: 'error',
        message: `kind: scene requires at least one D:/T: exchange (found ${parsed.exchanges})`,
        file,
        field: 'kind',
      });
    }
  } else if (kind === 'procedure') {
    if (parsed.toolTraces.length < 1) {
      issues.push({
        code: 'corpus/procedure-incomplete',
        severity: 'error',
        message: 'kind: procedure requires at least one `[tool] name {args} → observation` line',
        file,
        field: 'kind',
      });
    }
    if (parsed.outcomes.length < 1) {
      issues.push({
        code: 'corpus/procedure-incomplete',
        severity: 'error',
        message: 'kind: procedure requires an `[outcome] good|mixed|bad — note` line',
        file,
        field: 'kind',
      });
    }
    if (parsed.exchanges < 1) {
      issues.push({
        code: 'corpus/scene-no-exchange',
        severity: 'error',
        message: 'kind: procedure still converses — at least one D:/T: exchange is required around the trace',
        file,
        field: 'kind',
      });
    }
  }
  // kind 'statement': bodyless prose is the point; no structural rules.

  if (parsed.tokens > BODY_TOKEN_HARD_CAP) {
    issues.push({
      code: 'corpus/body-too-long',
      severity: 'error',
      message: `body is ${parsed.tokens} tokens (whitespace split) — hard cap is ${BODY_TOKEN_HARD_CAP}`,
      file,
      field: 'body',
    });
  } else if (parsed.tokens > BODY_TOKEN_WARN) {
    issues.push({
      code: 'corpus/body-too-long',
      severity: 'warning',
      message: `body is ${parsed.tokens} tokens — above the ${BODY_TOKEN_WARN}-token warn line (budget protection)`,
      file,
      field: 'body',
    });
  }

  if (opts.affectKeyCount > AFFECT_KEYS_RECOMMENDED_MAX) {
    issues.push({
      code: 'corpus/affect-too-dense',
      severity: 'warning',
      message: `affect tags ${opts.affectKeyCount} dims — sparse 2-4 is the convention; tag the room, not every flicker`,
      file,
      field: 'affect',
    });
  }

  return { issues };
};
