import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status of a hub or branch scan. Both seen live move the parcel between
 * centres; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['IN', 'in_transit'], // Received at a centre.
  ['OUT', 'in_transit'], // Sent on to another centre.
]);

/** The lines without a code: the booking and the delivery run sheet outcomes. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // Booked at the counter of the booking centre.
  ['booked', 'accepted'],
  // A run sheet the parcel went out on, before its outcome; the page's own title for one.
  ['out for delivery', 'out_for_delivery'],
  // A run sheet's outcome.
  ['delivered', 'delivered'],
]);

/** The stage Shree Anjani's scan statuses give a code. */
export function shreeAnjaniMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** The stage a line without a code has, in lower case. */
export function shreeAnjaniWordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording.toLowerCase().trim().split(/\s+/).join(' '));
}

const unless = (worded: ClassifiedWording) => (worded.source === 'none' ? null : worded);

/** A scan's stage: its status, else the shared wording rules, else nothing. */
export function shreeAnjaniScanStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = shreeAnjaniMappedStage(code);
  return mapped ? { stage: mapped, source: 'carrier_map' } : unless(classifyWording(wording, 'in_transit'));
}

/** A run sheet outcome's stage: its own wording, else the shared wording rules, else nothing. */
export function shreeAnjaniDeliveryStage(wording: string): ClassifiedWording | null {
  const mapped = shreeAnjaniWordingStage(wording);
  return mapped ? { stage: mapped, source: 'carrier_map' } : unless(classifyWording(wording, 'out_for_delivery'));
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? shreeAnjaniMappedStage(code) : shreeAnjaniWordingStage(wording)),
  gaps: [],
};
