/**
 * JD Logistics international operation codes (`operationCode`), as the
 * international feed sends them on each scan, and the domestic tracker's scan
 * states (`state`). Codes not listed here leave the scan to the steps JD relays
 * from a last-mile partner, then to the shared wording rules.
 */
import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const MOVING: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };
// JD's own warehouse holds the goods while it picks and weighs the order.
const IN_WAREHOUSE: ClassifiedStatus = { status: 'in_transit', stage: 'accepted' };

const CODES = new Map<string, ClassifiedStatus>([
  ['COSH', { status: 'pending', stage: 'registered' }],
  ['3041', IN_WAREHOUSE],
  ['3043', IN_WAREHOUSE],
  ['3052', MOVING],
  // Handed to the last-mile partner, whose first scan follows under DMPU.
  ['1060', MOVING],
  ['DMPU', MOVING],
  // A line from China: picked up from the shop, then received, weighed and consolidated at
  // JD's warehouse there, which holds it until it departs.
  ['FMPU', { status: 'in_transit', stage: 'accepted' }],
  ['ECWHRC', IN_WAREHOUSE],
  ['CXWHRC', IN_WAREHOUSE],
  ['CXWHSP', IN_WAREHOUSE],
  ['CXWHSO', MOVING],
  // At the airport: arrival, export customs released, departure; then the port of arrival.
  ['CXCCAP', MOVING],
  ['CXCCOE', MOVING],
  ['CXLHDP', MOVING],
  ['CXLHAP', MOVING],
  ['CCL', { status: 'in_transit', stage: 'customs' }],
  // Clearance completed: the parcel moves on.
  ['CXCCRS', MOVING],
  // The clearance agent collects the cleared parcel and hands it to the last-mile carrier.
  ['CXLHCP', MOVING],
  ['CXLMHL', MOVING],
  ['DMSCR', MOVING],
  ['SCVS', MOVING],
  ['VUVU', MOVING],
  // GOFO's hubs, the line haul between them and its delivery station, relayed under JD's codes.
  ['DMLMLW', MOVING],
  ['DMLMIT', MOVING],
  ['DMAPR', MOVING],
  ['DMLMOP', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['DMLMLS', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['DLV', { status: 'delivered', stage: 'delivered' }],
  // The domestic tracker's states, whose Chinese wording the shared rules do not read.
  // A courier is assigned to collect the parcel; the collection follows under 200001.
  ['200034', { status: 'pending', stage: 'registered' }],
  ['200001', { status: 'in_transit', stage: 'accepted' }],
  ['200077', MOVING],
  ['200019', MOVING],
  ['200000', MOVING],
  ['10054', MOVING],
  ['11000', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['10034', { status: 'delivered', stage: 'delivered' }],
]);

// A last-mile partner's step, read by its wording ahead of the code JD relays it under: GOFO's
// label comes under SRRF3P, a code JD has shown with that step alone, and GOFO's loading at a
// hub under DMLMLS, which is otherwise JD's courier out with the parcel. GOFO's arrival at its
// delivery station and its own out-for-delivery follow under DMAPR and DMLMOP.
const RELAYED = new Map<string, ClassifiedStatus>([
  ['shipping label created', { status: 'pending', stage: 'registered' }],
  ['loaded on vehicle', MOVING],
]);

/** The status and stage for one scan's relayed wording, or its operation code; undefined when unmapped. */
export function jdLogisticsStatus(code: string | undefined, wording: string): ClassifiedStatus | undefined {
  return RELAYED.get(wording.trim().toLowerCase()) ?? (code ? CODES.get(code) : undefined);
}

/**
 * What the map says about one scan: the wording JD relays from a last-mile partner, else its
 * operation code. A scan the shared wording rules staged stays open.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => jdLogisticsStatus(code ?? undefined, wording)?.stage,
  gaps: [],
};
