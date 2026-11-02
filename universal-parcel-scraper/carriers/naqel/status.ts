import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The English wording of the scans on Naqel's tracking page, which carry no
 * code. Archived captures of the former page word some steps differently;
 * both are kept. Only wording seen on the tracker is mapped; other wording
 * falls to the shared rules.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  // The retailer created the waybill; Naqel has not received the parcel yet.
  'Waybill created. Shipment has not been received from the retailer': 'registered',
  'Picked up by Naqel': 'accepted',
  'Shipment Picked Up by Naqel': 'accepted',
  'Picked Up': 'accepted',
  'Arrived at Naqel Facility': 'in_transit',
  // At the facility that clears imports, before the clearance.
  'Arrived at Naqel Clearance Facility': 'customs',
  'Customs Clearance Completed': 'in_transit',
  'Arrived at : Delivery Facility': 'in_transit',
  // Sorted for a courier's round at the delivery station.
  'Prepared for delivery': 'in_transit',
  'Out For Delivery with Courier': 'out_for_delivery',
  // Put in the parcel locker the recipient chose, to collect.
  'Loaded to Parcel Locker': 'ready_for_pickup',
  'Delivery attempted – Consignee not answered': 'failed_attempt',
  // Back at the delivery station after a failed attempt, not a return to the sender.
  'Shipment Returned to Warehouse': 'in_transit',
  'Delivered': 'delivered',
  // The former page's delivery, once the signer's name after it is removed.
  'Shipment Delivered': 'delivered',
};

/** Wording a place, trip code, reason or signer follows, as "Departed to EXAMPLE". */
const PREFIXES: readonly (readonly [string, Stage])[] = [
  ['departed to', 'in_transit'],
  ['arrived at :', 'in_transit'],
  ['load to trip :', 'in_transit'],
  ['on hold :', 'exception'],
  ['shipment delivered – signed by', 'delivered'],
];

/** A delivery option the system records: no movement, so the parcel keeps its stage. */
const NOTICES = ['Parcel Locker Request Created'];

/** The page's current status, read only when it says the journey ended. */
const SUMMARIES: Readonly<Record<string, Stage>> = { 'Delivered': 'delivered' };

const SCAN_KEYS = new Map(Object.entries(SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const NOTICE_KEYS = new Set(NOTICES.map(normalizeStatusWording));
const SUMMARY_KEYS = new Map(Object.entries(SUMMARIES).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage Naqel's wording gives a scan, if any. */
export function naqelMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return SCAN_KEYS.get(key) ?? PREFIXES.find(([prefix]) => key === prefix || key.startsWith(`${prefix} `))?.[1];
}

/** The stage the page's current status settles, when the parcel's journey ended. */
export function naqelSummaryStage(wording: string): Stage | undefined {
  return SUMMARY_KEYS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function naqelStage(wording: string): ClassifiedWording | null {
  const mapped = naqelMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICE_KEYS.has(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? naqelMappedStage(wording) : undefined),
  gaps: [...NOTICE_KEYS].map((wording) => ({
    wording, note: 'A parcel-locker delivery option the system records, not a movement: the parcel keeps the stage it had.',
  })),
};
