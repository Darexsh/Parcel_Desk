import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The specific scan code takes precedence over its broader state label: an
// unsuccessful delivery can still carry the state DOR (in delivery).
const CODES: Record<string, ClassifiedStatus> = {
  P_REJ_KN1: { status: 'pending', stage: 'registered' },
  P_NAD: { status: 'in_transit', stage: 'accepted' },
  P_PZL: { status: 'in_transit', stage: 'in_transit' },
  P_WZL: { status: 'in_transit', stage: 'in_transit' },
  P_WEOC: { status: 'in_transit', stage: 'in_transit' },
  P_WYPL: { status: 'in_transit', stage: 'in_transit' },
  P_WEPL: { status: 'in_transit', stage: 'in_transit' },
  P_WYOC: { status: 'in_transit', stage: 'in_transit' },
  P_ZWC: { status: 'in_transit', stage: 'customs' },
  P_ZWOLDDOR: { status: 'in_transit', stage: 'customs' },
  P_WPUCPP: { status: 'in_transit', stage: 'customs' },
  P_WD: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  // The Polish answer can give the scan of an item in delivery under this code where the English gives P_WD.
  P_WDML: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  P_A: { status: 'exception', stage: 'failed_attempt' },
  P_PA: { status: 'exception', stage: 'failed_attempt' },
  P_KWD: { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  P_NDZ: { status: 'exception', stage: 'returned' },
  P_D: { status: 'delivered', stage: 'delivered' },
  // Collected by the recipient at the office: its state reads "picked up at the point".
  P_OWU: { status: 'delivered', stage: 'delivered' },
};
const FAILED_DELIVERY = new Set(['P_ND', 'P_NDZK', 'P_NDPD', 'P_R',
  'P_NDZAP', 'P_NDZKON', 'P_ZDUN', 'P_CZDKN', 'P_NDPJ']);

export function classifyPocztaPolskaStatus(code: string): ClassifiedStatus | undefined {
  if (Object.hasOwn(CODES, code)) return CODES[code];
  if (FAILED_DELIVERY.has(code)) return { status: 'exception', stage: 'exception' };
  return undefined;
}

/**
 * What the map says about one scan: its code, as the adapter reads it. On the way back to the
 * sender the adapter reads a delivery as the return, which the code alone does not show.
 */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? classifyPocztaPolskaStatus(code)?.stage : undefined), gaps: [] };

/**
 * A scan that sends the item back to its sender: the return code, or any scan
 * in the returned state (ZW). Everything after it travels back.
 */
export function startsPocztaPolskaReturn(code: string, state: string): boolean {
  return code === 'P_NDZ' || state === 'ZW';
}

/**
 * A customs settlement books the duty collected at delivery, days after the
 * item has gone. It moves nothing, so it never decides the current status.
 */
export function settlesPocztaPolskaDuty(code: string): boolean {
  return code === 'P_ROZL_CEL';
}
