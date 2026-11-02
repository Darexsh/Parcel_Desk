import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Pitney Bowes's scans, which carry no code: its hubs' own
 * lines, and the lines it relays from the partner that takes the parcel on.
 * Export paperwork and labels are written at the hub, not at customs; a
 * dimension scan is the hub measuring the parcel. Other relayed wording falls
 * to the shared rules.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  'Tracking Details Uploaded': 'registered',
  'Label Created': 'registered',
  // The label exists but no hub or first-mile carrier has scanned the parcel.
  'Package not received by Hub or First Mile Carrier yet': 'registered',
  'In Transit': 'in_transit',
  'Item processed at Interpost': 'in_transit',
  'Arrived at the Global Shipping Center': 'in_transit',
  'Processing at the Global Shipping Center': 'in_transit',
  'Processing at Shipping Center': 'in_transit',
  'First Dimension Event': 'in_transit',
  'Second Dimension Event': 'in_transit',
  'Customs Documentation and Labeling': 'in_transit',
  'Parcel Documentation and Labeling': 'in_transit',
  'Container Assignment': 'in_transit',
  'Container Closed': 'in_transit',
  'Interpost handed item over to postal company': 'in_transit',
  'Shipped from the Global Shipping Center to International Destination': 'in_transit',
  'Shipped from Global Shipping Center to Destination': 'in_transit',
  'Shipped from Shipping Center to International Destination': 'in_transit',
  'Departed for Destination': 'in_transit',
  'International Carrier': 'in_transit',
  'Customs Cleared': 'in_transit',
  'Cleared customs': 'in_transit',
  'Customs Clearance': 'customs',
  // Interpost's clearance status 4 in its own tracker's words (`interpostClearance`).
  'Customs import cleared': 'in_transit',
  'Departed carrier facility': 'in_transit',
  'Processed by Carrier': 'in_transit',
  'Item in transit by postal company': 'in_transit',
  'Parcel is out for delivery': 'out_for_delivery',
  'Item is waiting for addressee at local post office': 'ready_for_pickup',
  'Delivered by Consignee Pickup': 'delivered',
  'Item has been delivered': 'delivered',
};

const GAPS = [
  {
    wording: 'Package is created in the system',
    note: 'The onward carrier opening its record after Pitney Bowes hands the parcel over; it moves nothing.',
  },
];

/**
 * Interpost's import clearance, which Pitney Bowes relays as its code alone:
 * `B2C ClearanceStatus` and a status number. Interpost's own tracker captions
 * status 4 "Customs Import cleared"; what the other numbers mean is not known.
 */
const CLEARANCE = /^B2C ClearanceStatus(\d{1,3})$/i;
const CLEARANCES: Readonly<Record<string, string>> = { 4: 'Customs import cleared' };

/** The words a clearance status code is shown in, and the code, kept as the provider code. */
export function interpostClearance(wording: string): { wording: string; code: string } | null {
  const code = wording.trim();
  const status = CLEARANCE.exec(code)?.[1];
  return status === undefined ? null : { wording: CLEARANCES[Number(status)] ?? 'Customs clearance update', code };
}

const SCAN_KEYS = new Map(Object.entries(SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const GAP_KEYS = new Set(GAPS.map((gap) => normalizeStatusWording(gap.wording)));

/** The stage Pitney Bowes's own wording gives a scan, if any. A clearance code stored as the wording reads as its words. */
export function pitneyBowesMappedStage(wording: string): Stage | undefined {
  return SCAN_KEYS.get(normalizeStatusWording(interpostClearance(wording)?.wording ?? wording));
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function pitneyBowesStage(wording: string): ClassifiedWording | null {
  const mapped = pitneyBowesMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAP_KEYS.has(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(interpostClearance(wording)?.wording ?? wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The tracker's summary statuses for an outbound parcel. `Delivered` settles
 * the parcel's stage whatever its newest scan says; the others only stand in
 * when no scan has a stage. A summary has marked a parcel its addressee
 * collected as a delivery problem, so `DeliveryException` never overrides a
 * scan.
 */
const SUMMARIES: ReadonlyMap<string, Stage> = new Map([
  ['Preparing', 'registered'],
  ['InTransit', 'in_transit'],
  ['OutForDelivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['DeliveryException', 'exception'],
]);

export function pitneyBowesSummaryStage(status: string): Stage | undefined {
  return SUMMARIES.get(status);
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => pitneyBowesMappedStage(wording),
  gaps: GAPS.map((gap) => ({ ...gap, wording: normalizeStatusWording(gap.wording) })),
};
