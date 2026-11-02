import { SPX_CODES, spxStatusMap } from './codes.js';

/** SPX Indonesia's tracker gives SPX's codes their shared stages. */
export const statusMap = spxStatusMap(SPX_CODES);
export const spxIdStage = statusMap.classify;
