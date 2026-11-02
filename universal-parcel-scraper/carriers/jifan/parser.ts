import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseTrackingByNos, type TrackingByNosCarrier } from '../cttyex/parser.js';
import { JIFAN_NOT_FOUND, jifanMappedStage, jifanStage } from './status.js';

export const PROVIDER = 'Jifan';
// One parcel's reply is about a kilobyte.
export const JIFAN_MAX_BYTES = 256 * 1024;
// JFGJ, the company's initials, nine digits and CN.
const NUMBER = /^JFGJ\d{9}CN$/;

/** A Jifan waybill number, in capitals; anything else is not one it issues. */
export function normalizeJifanNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Jifan waybills are JFGJ, nine digits and CN');
  return number;
}

const JIFAN: TrackingByNosCarrier = { provider: PROVIDER, normalize: normalizeJifanNumber, stage: jifanStage,
  summaryStage: jifanMappedStage, notFound: JIFAN_NOT_FOUND };

/** Jifan's reply for one number, which its tracker, CTTYEX's system, gives in CTTYEX's form. */
export const parseJifan = (payload: unknown, raw: string): CarrierResult => parseTrackingByNos(payload, raw, JIFAN);
