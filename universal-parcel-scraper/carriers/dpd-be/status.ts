import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { statusMap as dpd } from '../dpd/status.js';

/**
 * Belgian lookups read the myDPD guest API, so DPD's codes stage their scans and the codes
 * DPD's map leaves unmapped stay so. The Swiss page's labels do not apply: Belgian lookups
 * never read that page.
 */
export const statusMap: CarrierStatusMap = {
  stage: dpd.stage,
  gaps: dpd.gaps.filter(gap => gap.code !== undefined),
};
