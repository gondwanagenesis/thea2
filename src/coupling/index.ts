// M06 coupling — barrel. The space, the strict compiler, and the capped
// modulation function are what M11 (assemble), M14 (realize), and the probe
// suite consume; the mechanics files stay importable for tests.

// ---- the 12-dim deviation space ----
export {
  AFFECT_DIMS,
  COUPLING_BASELINES,
  DIM_INDEX,
  signature,
  type AffectDim,
  type Baselines,
  type SparseVec12,
  type Vec12,
} from './space.js';

// ---- the strict compiler ----
export {
  compileCoupling,
  type CompiledCoupling,
  type CouplingConfig,
  type FormRule,
  type MatrixEntry,
} from './config.js';

// ---- the capped modulation function ----
export { modulate } from './modulate.js';

// ---- typed errors ----
export { CouplingError, isCouplingError, type CouplingErrorCode, type CouplingErrorLoc } from './errors.js';
