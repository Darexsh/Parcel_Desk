import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The tracker's scan wording in English, mapped whole. */
export const EGYPT_POST_SCANS: Readonly<Record<string, Stage>> = {
  // A pickup the sender booked, before the item is collected.
  'REQUEST PICKUP CREATED': 'registered',
  'Shipment is collected from sender': 'accepted',
  'Shipment was collected': 'accepted',
  'Shipment is collected': 'accepted',
  'Shipment Arrived at office': 'in_transit',
  'Current Office Changed on Demand': 'in_transit',
  // At the international office of exchange of Egypt or of the country abroad.
  'Shipment Arrived at Office Of Exchange': 'in_transit',
  'Shipment Dispatched from Inward Office Of Exchange': 'in_transit',
  'Shipment dispatched to international transporter': 'in_transit',
  'Shipment is Out for Delivery': 'out_for_delivery',
  // The courier brought the item back to the office: a failed attempt, not a round still under way.
  'Shipment Out for Delivery and Return to Office': 'failed_attempt',
  'Shipment Delivered': 'delivered',
};

/**
 * The step summary each scan comes with. The page does not show it; it stages
 * a scan whose own wording neither the map nor the shared rules know.
 */
export const EGYPT_POST_SUMMARIES: Readonly<Record<string, Stage>> = {
  'In PICKING': 'registered',
  Collected: 'accepted',
  'In Process': 'in_transit',
  'In international Process': 'in_transit',
  'Out for Delivery': 'out_for_delivery',
  'Attempt of Delivery': 'failed_attempt',
  Delivered: 'delivered',
};

const keyed = (map: Readonly<Record<string, Stage>>) => new Map(Object.entries(map).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const SCANS = keyed(EGYPT_POST_SCANS);
const SUMMARIES = keyed(EGYPT_POST_SUMMARIES);

/** The stage Egypt Post's own scan wording gives a scan, if the map knows it. */
export function egyptPostScanStage(wording: string): Stage | undefined {
  return SCANS.get(normalizeStatusWording(wording));
}

/** The stage a step summary gives, if the map knows it. */
export function egyptPostSummaryStage(summary: string): Stage | undefined {
  return SUMMARIES.get(normalizeStatusWording(summary));
}

/**
 * A scan's stage from its wording, else the shared wording rules, else its
 * step summary. A scan none of them stages stays visible for review.
 */
export function egyptPostStage(wording: string, summary: string): ClassifiedWording | null {
  const mapped = wording ? egyptPostScanStage(wording) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (wording) {
    const worded = classifyWording(wording, 'in_transit');
    if (worded.source !== 'none') return worded;
  }
  const summed = summary ? egyptPostSummaryStage(summary) : undefined;
  return summed ? { stage: summed, source: 'carrier_map' } : null;
}

/** The scans carry wording only; a scan without its own wording shows its step summary. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : egyptPostScanStage(wording) ?? egyptPostSummaryStage(wording)),
  gaps: [],
};
