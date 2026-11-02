import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { classifyDpdUkWording } from './parser.js';
import { dpdUkWording } from './wording.js';

// Delivery notices: the notification of a coming delivery, and the day and hour or the safe place the recipient chose.
const NOTICE = new RegExp('^(?:a notification has been sent to advise you when the delivery will take place'
  + '|as requested, your parcel will now be (?:left in your selected safe place'
  + '|delivered on [a-z]{3} \\d{1,2} [a-z]+ \\d{4}(?: at (?:[01]?\\d|2[0-3]):[0-5]\\d)?))$');

/**
 * What the map says about one scan: DPD UK's scans carry no code, so their wording stages them
 * as the parser reads it, DPD UK's own wording first, then the shared rules. Wording neither
 * knows stays open, and so do the delivery notices.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => {
    const classified = classifyDpdUkWording(wording);
    return classified.source === 'none' ? undefined : classified.stage;
  },
  gaps: [],
  gapNote: (_code, wording) => (NOTICE.test(dpdUkWording(wording))
    ? 'A delivery notice, not a movement: the parcel keeps the stage it had.' : undefined),
};
