/**
 * PostLogistics status vocabulary.
 *
 * Every history entry carries a three-letter `Status` code next to its
 * free-text `Description`. Confirmed codes classify each scan and the newest
 * scan's summary. Unknown codes leave the stage to the wording classifier.
 * An announcement must not become movement when its wording is unrecognized.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../generated/catalog.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Codes that mean the parcel reached its recipient. */
export const POSTLOGISTICS_DELIVERED_CODES = ['DEL', 'DLV', 'POD', 'SIG'] as const;

/** The code that means the shipment is announced but not yet moving. */
export const POSTLOGISTICS_NOTIFIED_CODE = 'NTF';

/** The code of an entry that records a picture, not a movement. */
export const POSTLOGISTICS_IMAGE_CODE = 'IMG';

/** The milestone of a scan whose code has a confirmed meaning. */
export function postlogisticsStage(code: string): Stage | undefined {
  if ((POSTLOGISTICS_DELIVERED_CODES as readonly string[]).includes(code)) return 'delivered';
  if (code === POSTLOGISTICS_NOTIFIED_CODE) return 'registered';
  if (code === 'RFS') return 'accepted';
  if (code === 'SCA') return 'out_for_delivery';
  return undefined;
}

/** The shipment status the newest history code implies. */
export function postlogisticsStatus(code: string): CarrierStatus {
  const stage = postlogisticsStage(code);
  if (stage === 'delivered' || stage === 'out_for_delivery') return stage;
  if (stage === 'registered') return 'pending';
  return 'in_transit';
}

/** What the map says about one scan, by its code. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? postlogisticsStage(code) : undefined),
  gaps: [{ code: POSTLOGISTICS_IMAGE_CODE, note: 'A picture taken with a scan, not a movement of the parcel.' }],
};
