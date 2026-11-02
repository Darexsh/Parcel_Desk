import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Event codes observed in the official anonymous tracking service. The
// website's lifecycle rail combines these into much broader presentation states.
const codes: Record<string, ClassifiedStatus> = {
  '3000': { status: 'pending', stage: 'registered' },
  '3010': { status: 'pending', stage: 'registered' },
  '2300': { status: 'in_transit', stage: 'accepted' },
  '2380': { status: 'in_transit', stage: 'accepted' },
  // The driver's collection at the shipper's site, before the terminal records the pickup (2380).
  '2385': { status: 'in_transit', stage: 'accepted' },
  '0200': { status: 'in_transit', stage: 'in_transit' },
  '0300': { status: 'in_transit', stage: 'in_transit' },
  // Delays from a missed connection or a late train; the parcel keeps moving.
  '0500': { status: 'in_transit', stage: 'in_transit' },
  '0510': { status: 'in_transit', stage: 'in_transit' },
  '1300': { status: 'in_transit', stage: 'in_transit' },
  '1310': { status: 'in_transit', stage: 'in_transit' },
  '4020': { status: 'in_transit', stage: 'in_transit' },
  '4060': { status: 'in_transit', stage: 'in_transit' },
  '7220': { status: 'in_transit', stage: 'in_transit' },
  '7520': { status: 'in_transit', stage: 'in_transit' },
  '7525': { status: 'in_transit', stage: 'in_transit' },
  '7810': { status: 'in_transit', stage: 'in_transit' },
  '4200': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  // An address that needs correcting stops the parcel; once corrected it is
  // scheduled again, and a parcel the counter will hold is on its way there.
  '6500': { status: 'exception', stage: 'exception' },
  '6720': { status: 'in_transit', stage: 'in_transit' },
  '6550': { status: 'in_transit', stage: 'in_transit' },
  '9100': { status: 'in_transit', stage: 'in_transit' },
  '9230': { status: 'exception', stage: 'failed_attempt' },
  '9250': { status: 'exception', stage: 'failed_attempt' },
  '9260': { status: 'exception', stage: 'failed_attempt' },
  '9550': { status: 'in_transit', stage: 'ready_for_pickup' },
  // 9000 is the delivery to the address or to the counter that then holds the
  // parcel; 9500 is the collection there.
  '9000': { status: 'delivered', stage: 'delivered' },
  '9500': { status: 'delivered', stage: 'delivered' },
};

export function classifyPurolatorStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}

/** What the map says about one scan: its code, as the parser stores it. */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? classifyPurolatorStatus(code)?.stage : undefined), gaps: [] };
