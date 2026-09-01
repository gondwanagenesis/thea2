// M12 inhibit — public surface. M13 imports { compileGate } plus the types it
// needs (Verdict, EntryKind, MAX_GATE_REENTRIES); M20 imports
// gate.renderPromptBlock(). Everything else is module-internal.

export { compileGate } from './compile.js';
export {
  InhibitError,
  isInhibitError,
  type InhibitErrorCode,
  type InhibitErrorLocation,
} from './errors.js';
export { PROMPT_BUDGET_TOKENS, renderPromptBlock } from './prompt.js';
export { parseInhibitionsDoc } from './schema.js';
export {
  ENTRY_KINDS,
  MAX_GATE_REENTRIES,
  VERDICT_CODES,
  type EntryKind,
  type GateConfig,
  type InhibitionGate,
  type PlanView,
  type RuleInfo,
  type Verdict,
  type VerdictCode,
} from './types.js';
