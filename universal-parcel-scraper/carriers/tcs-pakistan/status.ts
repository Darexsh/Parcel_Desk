import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The codes of TCS's delivery records, the attempts and the delivery the page
 * sums up as the current status. Checkpoints come without a code.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['OK', 'delivered'],
  ['HC', 'failed_attempt'], // The recipient's premises were closed for the weekend.
  ['UL', 'failed_attempt'], // The courier could not find the address.
  ['SD', 'in_transit'], // Waiting for the next delivery round.
]);

/** TCS's checkpoint and delivery-record wordings, lower case, without the advice to contact the local office. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['shipment picked up', 'accepted'],
  ['arrived at tcs facility', 'in_transit'],
  ['departed from tcs facility', 'in_transit'],
  ['scheduled for next delivery cycle', 'in_transit'],
  ['scheduled for the next delivery cycle', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['recipient premises closed', 'failed_attempt'],
  ['fri/sat closed', 'failed_attempt'],
  ['address information needed', 'failed_attempt'],
  ['unable to locate delivery address', 'failed_attempt'],
  ['shipment delivered', 'delivered'],
  ['delivered', 'delivered'],
  // The summary of a shipment listed without checkpoints.
  ['your shipment is in transit', 'in_transit'],
  ['your shipment is out for delivery', 'out_for_delivery'],
]);

const ADVICE = /\s*\(for additional info[^)]*\)\s*$/i;

/** The stage TCS's delivery-record codes give a record. */
export function tcsCodeStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** The stage of a TCS wording, read case-insensitively. */
export function tcsWordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording.replace(ADVICE, '').toLowerCase().trim().split(/\s+/).join(' '));
}

/** A scan's stage: its code, else its wording, else the shared wording rules, else nothing. */
export function tcsStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = (code ? tcsCodeStage(code) : undefined) ?? tcsWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? tcsCodeStage(code) : undefined) ?? tcsWordingStage(wording),
  gaps: [],
};
