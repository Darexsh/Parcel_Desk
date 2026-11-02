import type { Stage } from '../../core/status/index.js';
import { SPX_CODES, spxStatusMap } from '../spx-id/codes.js';

/**
 * SPX Thailand's tracker gives SPX's codes their shared stages, except the
 * arrival from abroad: its line says the parcel is at Thai customs for
 * inspection.
 */
export const statusMap = spxStatusMap(new Map<string, Stage>([...SPX_CODES, ['F360', 'customs']]));
export const spxThStage = statusMap.classify;
