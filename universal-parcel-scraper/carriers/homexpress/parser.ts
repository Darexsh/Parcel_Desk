import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseTrace } from '../ewe/trace.js';
import { homexpressStage } from './status.js';

export const PROVIDER = 'HOMEXPRESS';
// The tracking page sends whatever is typed. The delivery system reads a lower-case number as unknown.
const NUMBER = /^[A-Z0-9]{4,40}$/;

/** A number for HOMEXPRESS's tracker, in upper case; anything else is not one it issues. */
export function normalizeHomexpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HOMEXPRESS numbers are four to forty letters and digits');
  return number;
}

/** The reply of HOMEXPRESS's tracker, the trace tracker of EWE's delivery system on its own host. */
export function parseHomexpressTrace(payload: unknown, raw: string): CarrierResult {
  return parseTrace(payload, normalizeHomexpressNumber(raw), { provider: PROVIDER, stage: homexpressStage });
}
