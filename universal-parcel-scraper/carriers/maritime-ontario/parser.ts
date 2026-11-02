import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseTM4WebBill, readTM4WebTrace, type TM4WebSite } from './tm4web.js';
import { maritimeOntarioStage } from './status.js';

export const PROVIDER = 'Maritime-Ontario';
export const MARITIME_ONTARIO_ORIGIN = 'https://cp.m-o.com';
// The freight bill, which M-O's Track and Trace guide shows as a capital F and seven digits.
const NUMBER = /^F\d{7}$/;

/** An M-O freight bill number, or an `InvalidInputError`. */
export function normalizeMaritimeOntarioNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Maritime-Ontario tracks its freight bills, an F and seven digits');
  return number;
}

/**
 * M-O's trace: its freight bill, `~PTLORDER`. The form's other fields, the
 * customer's trace number, bill of lading, purchase order and booking, go
 * empty: they are shippers' references.
 */
export const MARITIME_ONTARIO: TM4WebSite = {
  carrier: 'maritime-ontario',
  provider: PROVIDER,
  name: 'M-O',
  origin: MARITIME_ONTARIO_ORIGIN,
  traceType: '~PTLORDER',
  traceTypes: ['~PTLORDER', '%PTLORDER', 'BPTRACE', 'PPTRACE', 'KPTRACE'],
  normalize: normalizeMaritimeOntarioNumber,
  stage: maritimeOntarioStage,
};

/** The bill's id in the trace's reply, or the error its answer means. */
export function readMaritimeOntarioTrace(reply: unknown, number: string): string {
  return readTM4WebTrace(reply, number, MARITIME_ONTARIO);
}

/** A bill's details, bound to the whole freight bill number. */
export function parseMaritimeOntarioBill(reply: unknown, number: string): CarrierResult {
  return parseTM4WebBill(reply, number, MARITIME_ONTARIO);
}
