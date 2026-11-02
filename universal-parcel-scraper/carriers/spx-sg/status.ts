import { SPX_CODES, spxStatusMap } from '../spx-id/codes.js';

/** SPX Singapore's tracker gives SPX's codes their shared stages. */
export const statusMap = spxStatusMap(SPX_CODES);
export const spxSgStage = statusMap.classify;
