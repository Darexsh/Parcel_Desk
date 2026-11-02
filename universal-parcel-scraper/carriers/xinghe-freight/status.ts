import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { gzylStage } from '../gzyl/status.js';

/**
 * The stage a row gets, by its `normalizeStatusWording` wording: GZYL's tenant
 * writes Xinghe Freight's rows in GZYL's words, so GZYL's map reads them.
 */
export const xingheFreightStage = gzylStage;

export const statusMap: CarrierStatusMap = { stage: xingheFreightStage, gaps: [] };
