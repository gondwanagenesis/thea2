// M11 assemble — barrel. The contract types, the entry points, and the pieces
// M07's corpusNominator / M09's nominators / M10's credit updater need
// (gravityMultiplier, CREDIT_GAMMA). The internals stay importable for tests.

// ---- contract ----
export type {
  AssembleConfig,
  AssembleDeps,
  BudgetConfig,
  Candidate,
  CandidateTier,
  CharacterSection,
  CoherenceConfig,
  Nominator,
  Packet,
  PacketChannel,
  PacketRecord,
  PacketRecordSlot,
  QuotaConfig,
  Section,
  SpeakerRef,
  TurnQuery,
} from './types.js';
export { assembleConfigFromControls, CHARACTER_SECTIONS, DEFAULT_ASSEMBLE_CONFIG } from './types.js';

// ---- entry points ----
export { assemble } from './assemble.js';
export { proceduralQuota, TOOL_SUGGESTIVE_STEMS } from './quota.js';

// ---- laws other modules consume ----
export { CREDIT_GAMMA, gravityMultiplier, scoreOf, modulationOf } from './score.js';
export { MEMORY_TRIM_TARGET, packetTokens } from './budget.js';
export { COHERENCE_LAYERS, runCoherence, type CoherenceLayer } from './coherence.js';

// ---- errors ----
export { AssembleError, isAssembleError, type AssembleErrorCode } from './errors.js';
