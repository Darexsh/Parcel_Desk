import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Precision's scan codes. Amazon parcels carry Amazon's codes, built on the
 * EDI shipment statuses (X4 at the terminal, OD out for delivery, D1
 * delivered) and a reason. The codes seen in replies are mapped, with the
 * delivery and out-for-delivery codes the tracking page's own table files
 * under those steps; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // Manifest Scan: the shipper's manifest, before any physical scan.
  ['INBOUND_RCVD', 'accepted'], // First Mile Inbound: received from the shipping platform.
  ['X4NS1', 'accepted'], // Received at Terminal.
  ['AMZ_INBOUND_X4_NS', 'accepted'], // Received at Terminal, for an Amazon parcel.
  ['AMNS1', 'out_for_delivery'],
  ['AMZ_OUTBOUND_OD_NS', 'out_for_delivery'],
  ['D1NS1', 'delivered'],
  ['D1NS2', 'delivered'], // Delivered - Mailroom/Mailbox.
  ['D1NS4', 'delivered'],
  ['D1NS5', 'delivered'],
  ['D1NS6', 'delivered'],
  ['AMZ_DELIVERY_D1_CX', 'delivered'],
  ['AMZ_DELIVERY_D1_DP', 'delivered'],
  ['AMZ_DELIVERY_D1_FP', 'delivered'],
  ['AMZ_DELIVERY_D1_LX', 'delivered'], // Delivered - Mailroom/Mailbox.
  ['AMZ_DELIVERY_D1_NE', 'delivered'],
  ['AMZ_DELIVERY_D1_RN', 'delivered'],
  ['AMZ_DELIVERY_D1_SI', 'delivered'],
  ['AMZ_DELIVERY_D1_SP', 'delivered'], // Delivered - Safe location.
]);

/** The stage Precision's codes give a scan code. */
export function precisionMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim().toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function precisionStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = precisionMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? precisionMappedStage(code) : undefined),
  gaps: [],
};
