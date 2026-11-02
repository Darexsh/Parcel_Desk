import type { CarrierResult } from '../../core/result/index.js';
import { normalizeJAndTNumber, parseJAndT, type JAndTNetwork } from '../j-and-t-au/official.js';
import { jAndTUkStage } from './status.js';

export const PROVIDER = 'J&T Express UK';

export const J_AND_T_UK: JAndTNetwork = {
  id: 'j-and-t-uk',
  provider: PROVIDER,
  api: 'https://official.jtexpress.uk/official/logisticsTracking/getDetailByWaybillNo',
  // The page names its English site's language as the country.
  country: { country: 'EN' },
  // The waybill J&T Express UK prints: JTUK and twelve digits.
  number: /^JTUK\d{12}$/,
  layout: 'J&T Express UK waybills are JTUK and twelve digits',
  stage: jAndTUkStage,
};

/** A waybill for J&T Express UK's tracker, in upper case as it prints them; anything else is not one it issues. */
export function normalizeJAndTUkNumber(raw: string): string {
  return normalizeJAndTNumber(J_AND_T_UK, raw);
}

/** The reply of `getDetailByWaybillNo` for one waybill, as `parseJAndT` reads it. */
export function parseJAndTUk(payload: unknown, raw: string): CarrierResult {
  return parseJAndT(J_AND_T_UK, payload, raw);
}
