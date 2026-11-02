import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Tracking codes of the order endpoint. Codes not listed fall back to the
// shared wording classifier. Export clearance is a transit milestone, and a
// failed pickup leaves the parcel with its seller.
const CODES: Readonly<Record<string, Stage>> = {
  A000: 'registered', F000: 'registered', F001: 'registered', F004: 'registered',
  F096: 'accepted', F098: 'accepted', F100: 'accepted', F106: 'accepted',
  F110: 'in_transit', F199: 'in_transit', F200: 'in_transit', F206: 'in_transit', F230: 'in_transit',
  F239: 'in_transit', F299: 'in_transit', F300: 'in_transit', F339: 'in_transit', F341: 'in_transit',
  F360: 'in_transit', A103: 'in_transit', F430: 'in_transit', F440: 'in_transit', F441: 'in_transit',
  F445: 'in_transit', F450: 'in_transit', F510: 'in_transit', F515: 'in_transit', F540: 'in_transit',
  F541: 'in_transit', F550: 'in_transit', F580: 'in_transit', F598: 'in_transit', F599: 'in_transit',
  F600: 'out_for_delivery', F650: 'failed_attempt', F980: 'delivered',
};

// Status codes of the legacy feed. An on-hold row names its reason only in prose.
const LEGACY: Readonly<Record<string, Stage>> = {
  Created: 'registered', DOP_Received: 'accepted', FMHub_Pickup_Done: 'accepted', SOC_Pickup_Done: 'accepted',
  SP_Pickup_Pending_Handover: 'accepted', SP_Pickup_Handover_to_Station: 'in_transit',
  FMHub_Received: 'in_transit', FMHub_LHTransporting: 'in_transit', SOC_Received: 'in_transit',
  SOC_LHTransporting: 'in_transit', LMHub_Received: 'in_transit', Delivering: 'out_for_delivery',
  OnHold: 'exception', Delivered: 'delivered',
};

// Scans at SPX's own facilities, ports and service points. Seller pickups
// carry the seller's own location, which is never projected.
const FACILITY_CODES = new Set(['F098', 'F199', 'F200', 'F206', 'F230', 'F239', 'F299', 'F300', 'F339',
  'F341', 'F360', 'F430', 'F440', 'F441', 'F445', 'F450', 'F510', 'F515', 'F540', 'F541', 'F580', 'F599']);

export function spxPhStage(code: string, legacy = false): Stage | undefined {
  const map = legacy ? LEGACY : CODES;
  return Object.hasOwn(map, code) ? map[code] : undefined;
}

export function isSpxPhFacilityCode(code: string): boolean {
  return FACILITY_CODES.has(code);
}

/**
 * What the map says about one scan: its tracking code, or a legacy row's status name; the two
 * never share a value. A code neither lists took the shared wording rules, so it stays open.
 */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? spxPhStage(code) ?? spxPhStage(code, true) : undefined), gaps: [] };
