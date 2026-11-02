import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** A wording's key: lower case, single spaces, a hyphen read as a space. */
function key(wording: string): string {
  return normalizeStatusWording(wording.replace(/-/g, ' '));
}

/**
 * UDS's status wordings, which carry no code: the page's status heading, the
 * titles of its four steps and the sentence above them. "Received" is the
 * scan into a UDS terminal, which takes the parcel over from the shipper. The
 * tracking help adds a delay, which is an exception, Will-Call, which waits
 * at a UDS terminal for collection, and a return to the shipper.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['shipment notification', 'registered'],
  ['shipment notification has been received.', 'registered'],
  ['received', 'accepted'],
  ['package has been received by uds.', 'accepted'],
  ['out for delivery', 'out_for_delivery'],
  ['package is loaded and out for delivery.', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['package has been delivered.', 'delivered'],
  ['delayed', 'exception'],
  ['will call', 'ready_for_pickup'],
  ['returned', 'returned'],
  ['the shipment information has been sent to uds. the status will update when uds receives the package.', 'registered'],
  ['this shipment has not been received by uds. please check back at a later time.', 'registered'],
  ['the package has been received by uds.', 'accepted'],
  ['the package is delivered.', 'delivered'],
  // The rows of the former page's table.
  ['shipment request received', 'registered'],
  ['package received', 'accepted'],
]);

/** The stage the map gives a wording, if it knows it. */
export function udsMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** A wording's stage: the map, else the shared wording rules, else nothing. */
export function udsStage(wording: string): ClassifiedWording | null {
  const mapped = udsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = wording ? classifyWording(wording, 'in_transit') : null;
  return worded && worded.source !== 'none' ? worded : null;
}

/** The page's wordings carry no code; every wording it was seen to use is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : udsMappedStage(wording)),
  gaps: [],
};
