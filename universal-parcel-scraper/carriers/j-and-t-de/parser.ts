import type { CarrierResult } from '../../core/result/index.js';
import { normalizeJAndTNumber, parseJAndT, type JAndTNetwork } from '../j-and-t-au/official.js';
import { jAndTDeStage } from './status.js';

export const PROVIDER = 'J&T Express Germany';

// The ways of delivering the site offers, as its English page names them, which the
// delivered scan gives in brackets. A recipient's signature adds nothing to the delivery.
const DELIVERY_TYPES = new Set(['Left with neighbor', 'Front Door Porch', 'Front Desk Reception', 'Garden Yard', 'Mailbox', 'Garage']);
const DELIVERY_TYPE = /\s*The delivery type is\s*【([^】]{0,60})】\s*\.?/iu;
// The closing line of the delivered scan: "If you have any questions or complaints, please call our customer service hotline at +49 …".
const HOTLINE = /\s*If you have any questions or complaints, please call our customer service hotline(?: at)?[^.]*?(?:\.(?!\d)|$)/iu;

/**
 * The delivered scan's sentence with its delivery type out of brackets when it
 * is one of the site's ways of delivering, and without it otherwise, and
 * without the customer service line it ends with.
 */
export function jAndTDeWording(sentence: string): string {
  return sentence.replace(HOTLINE, '').replace(DELIVERY_TYPE, (_whole, type: string) => {
    const named = type.trim();
    return DELIVERY_TYPES.has(named) ? ` The delivery type is ${named}.` : '';
  });
}

export const J_AND_T_DE: JAndTNetwork = {
  id: 'j-and-t-de',
  provider: PROVIDER,
  api: 'https://official.jtexpress.eu/official/logisticsTracking/getDetailByWaybillNo',
  country: { country: 'DE' },
  // The waybill J&T Express Germany prints: JTDE and twelve digits.
  number: /^JTDE\d{12}$/,
  layout: 'J&T Express Germany waybills are JTDE and twelve digits',
  wording: jAndTDeWording,
  stage: jAndTDeStage,
};

/** A waybill for J&T Express Germany's tracker, in upper case as it prints them; anything else is not one it issues. */
export function normalizeJAndTDeNumber(raw: string): string {
  return normalizeJAndTNumber(J_AND_T_DE, raw);
}

/** The reply of `getDetailByWaybillNo` for one waybill, as `parseJAndT` reads it. */
export function parseJAndTDe(payload: unknown, raw: string): CarrierResult {
  return parseJAndT(J_AND_T_DE, payload, raw);
}
