import { SPX_CODES, spxStatusMap } from '../spx-id/codes.js';

/**
 * SPX Malaysia's tracker gives SPX's codes their shared stages. Its delay
 * notice reads "Exception" while the parcel moves on, so it stages nothing.
 */
export const statusMap = spxStatusMap(SPX_CODES, [
  { code: 'F418', note: 'A delay notice worded "Exception"; the parcel moves on, so it stages nothing.' },
]);
export const spxMyStage = statusMap.classify;
