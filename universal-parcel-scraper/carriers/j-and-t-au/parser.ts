import type { CarrierResult } from '../../core/result/index.js';
import { J_AND_T_MAX_BYTES, jAndTWording, normalizeJAndTNumber, parseJAndT, type JAndTNetwork } from './official.js';
import { jAndTAuStage } from './status.js';

export const PROVIDER = 'J&T Express Australia';
export const J_AND_T_AU_MAX_BYTES = J_AND_T_MAX_BYTES;

export const J_AND_T_AU: JAndTNetwork = {
  id: 'j-and-t-au',
  provider: PROVIDER,
  api: 'https://official.jtaunz.com/official/logisticsTracking/getDetailByWaybillNo?countryCode=AU',
  country: { countryCode: 'AU' },
  // The waybill J&T Express Australia prints: JTAU and twelve digits.
  number: /^JTAU\d{12}$/,
  layout: 'J&T Express Australia waybills are JTAU and twelve digits',
  stage: jAndTAuStage,
};

/** A waybill for J&T Express Australia's tracker, in upper case as it prints them; anything else is not one it issues. */
export function normalizeJAndTAuNumber(raw: string): string {
  return normalizeJAndTNumber(J_AND_T_AU, raw);
}

/** A scan's sentence without the people and phones it can name. */
export const jAndTAuWording = jAndTWording;

/** The reply of `getDetailByWaybillNo` for one waybill, as `parseJAndT` reads it. */
export function parseJAndTAu(payload: unknown, raw: string): CarrierResult {
  return parseJAndT(J_AND_T_AU, payload, raw);
}
