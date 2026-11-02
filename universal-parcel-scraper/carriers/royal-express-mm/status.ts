import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Royal Express's scan codes: the leg the page heads a scan with and its step,
 * as `delivery-completed`. The Burmese sentence under it names the office, and
 * one sentence can serve several codes, so the code is the key. Only codes seen
 * in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['pickup-completed', 'accepted'], // An office collected the parcel from the sender.
  ['transit-outbound collected', 'accepted'], // The sending office took the parcel in, after a pickup or at its counter.
  ['transit-outbound received', 'in_transit'], // A hub took the parcel in on its way out.
  ['transit-inbound received', 'in_transit'], // A sorting centre or the delivering office took the parcel in.
  ['delivery-accepted', 'in_transit'], // The delivering office is preparing the parcel's delivery.
  ['delivery-ongoing', 'out_for_delivery'],
  ['delivery-completed', 'delivered'],
  ['delivery-rejected', 'failed_attempt'], // Held after a delivery that did not succeed.
  ['delivery-reattempted', 'in_transit'], // Set for another delivery after a failed one.
]);

/** The stage Royal Express's codes give a scan code. */
export function royalExpressMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toLowerCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function royalExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = royalExpressMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? royalExpressMappedStage(code) : undefined),
  gaps: [],
};
