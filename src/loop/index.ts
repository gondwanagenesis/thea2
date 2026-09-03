// M13 loop — public surface. M20 composes runLoop + a ToolRegistry; M14 and M19
// consume DecisionObject (mirrored structurally from the schema here).

export { runLoop, TRUNCATED_COMPLETENESS_CAP, parseDecision } from './loop.js';
export type { DecisionParse } from './loop.js';

export {
  DECIDE_TOOL_NAME,
  OUTPUT_CONTRACT,
  PROSE_FOLD_DEFAULTS,
  decideToolDef,
  isDecideCall,
  looksJsonShaped,
  proseToDecision,
} from './decide.js';

export type {
  Vec12,
  InboundMsg,
  LoopQuery,
  LoopPacket,
  LoopEntry,
  ToolStep,
  SpawnRecord,
  DecidedBy,
  DecisionObject,
  ModelDecision,
  InhibitionMeta,
  ToolCtx,
  SpawnSink,
  ToolRegistryEntry,
  ToolRegistry,
  CommitteeNode,
  CommitteeSpec,
  CommitteeResult,
  LoopDeps,
  RunLoop,
} from './types.js';

export { LOOP_CONFIG_DEFAULTS, resolveLoopConfig } from './config.js';
export type { LoopConfig, InhibitionPlacement, SpawnsMode, TurnTransportConfig } from './config.js';

export { LoopError, loopError, failLoop } from './errors.js';
export type { LoopErrorCode } from './errors.js';

export { createToolRegistry, overlayRegistry, defOf } from './registry.js';
export { buildMessages, fitObservation } from './messages.js';
export { validateCommittee, topoOrder, runCommittee } from './committee.js';
export type { CommitteeEnv } from './committee.js';

export {
  VerdictSchema,
  ToolStepSchema,
  SpawnRecordSchema,
  ModelDecisionSchema,
  DecisionObjectSchema,
  decisionIssue,
  DelegationPayloadSchema,
  GateLoopPayloadSchema,
  TurnAbortedPayloadSchema,
  verdictRuleId,
  DELEGATION_KIND,
  DECISION_LOCKED_KIND,
  GATE_LOOP_INCIDENT,
  DECISION_PARSE_INCIDENT,
  SPAWN_REFUSED_INCIDENT,
  TOOL_TIMEOUT_INCIDENT,
  ASSEMBLE_FAILED_INCIDENT,
  TURN_ABORTED_INCIDENT,
  DECISION_PROSE_FOLDED,
  DecidedBySchema,
} from './schema.js';
