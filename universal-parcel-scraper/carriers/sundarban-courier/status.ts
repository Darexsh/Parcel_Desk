import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The statuses a domestic CN goes through, as the tracking service words them.
 * The page prints each as a Bengali sentence naming the branch; the two
 * sentences without a branch are mapped too.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(Object.entries({
  'Booking Complete': 'accepted',
  // Sent on from a branch or hub towards the next one.
  'Out for Destination': 'in_transit',
  // Received at the next hub or at the delivering branch.
  'Received by Dest.': 'in_transit',
  'Out for Delivery': 'out_for_delivery',
  // Ready for collection at the branch counter.
  'Ready for C/D': 'ready_for_pickup',
  'Delivered': 'delivered',
  // Returned to the sender.
  'Return': 'returned',
  'Return at office': 'returned',
  // The return has reached the sender.
  'Return & Delivered': 'returned',
  'Damage': 'exception',
  'পণ্যটি ডেলিভারি সম্পন্ন হয়েছে।': 'delivered',
  'আপনার পণ্যটি প্রেরকের কাছে রিটার্ন করা হয়েছে।': 'returned',
} satisfies Record<string, Stage>).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/**
 * The codes the service gives an international shipment's statuses, with the
 * label the page shows for each.
 */
export const SUNDARBAN_CODES: Readonly<Record<string, { label: string; stage: Stage }>> = {
  export_processing: { label: 'Export Processing', stage: 'in_transit' },
  export_customs_processing: { label: 'Export Customs Processing', stage: 'customs' },
  shipment_in_transit: { label: 'Shipment In Transit', stage: 'in_transit' },
  shipment_off_loaded: { label: 'Shipment Offloaded', stage: 'in_transit' },
  shipment_delayed_in_transit: { label: 'Shipment Delayed In Transit', stage: 'in_transit' },
  shipment_arrived_at_dest: { label: 'Shipment Arrived At Destination', stage: 'in_transit' },
  customs_clearance_at_dest: { label: 'Customs Clearance At Destination', stage: 'customs' },
  customs_clearance_delay: { label: 'Customs Clearance Delay', stage: 'customs' },
  shipment_ready_for_delivery: { label: 'Shipment Ready For Delivery', stage: 'in_transit' },
  shipment_delivered: { label: 'Shipment Delivered', stage: 'delivered' },
  delivery_missed_rcpt_unavailable: { label: 'Delivery Missed Due To Recipient Unavailable', stage: 'failed_attempt' },
};

/** The stage the map gives a domestic status, if it knows the wording. */
export function sundarbanWordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** The stage the map gives an international status code, if it knows it. */
export function sundarbanCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(SUNDARBAN_CODES, code) ? SUNDARBAN_CODES[code]!.stage : undefined;
}

/** A status's stage: its code or wording, else the shared wording rules, else nothing. */
export function sundarbanStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = code ? sundarbanCodeStage(code) : sundarbanWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** International statuses carry their code, domestic ones only their wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? sundarbanCodeStage(code) : sundarbanWordingStage(wording)),
  gaps: [],
};
