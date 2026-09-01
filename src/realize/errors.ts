// M14 realize — typed errors. Every failure mode of the delivery door has one
// code, so the pipeline (M20) branches without string matching. Deliberately
// small: the realizer's job is to never fail on bad cadence inputs — those
// clamp — so the only loud failures are structural.

import { KernelErrorImpl } from '../kernel/index.js';

/** Error codes emitted by this module. */
export type RealizeErrorCode =
  | 'realize/vec-length' // the affect vector was not the 12-dim deviation space
  | 'realize/unsplittable-bubble'; // a bubble exceeds maxMsgChars with no paragraph/sentence boundary to split on

/** Throwing variant used by planDelivery/shape. Extends the kernel error so `asError` keeps the code. */
export class RealizeError extends KernelErrorImpl {
  constructor(code: RealizeErrorCode | string, message: string, cause?: unknown) {
    super(code, message, cause);
    this.name = 'RealizeError';
  }
}

export const isRealizeError = (e: unknown): e is RealizeError => e instanceof RealizeError;
