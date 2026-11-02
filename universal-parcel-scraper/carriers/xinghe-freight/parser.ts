import type { HualeiTenant } from '../gzyl/hualei.js';
import { GZYL_ORIGIN, splitGzylRow } from '../gzyl/parser.js';
import { xingheFreightStage } from './status.js';

export const PROVIDER = 'Xinghe Freight';
/**
 * Xinghe Freight's site sends its tracking form to GZYL's tenant of the Hualei
 * platform, which writes its rows in GZYL's words: the host and the row
 * splitting are GZYL's.
 */
export const XINGHE_FREIGHT: HualeiTenant = {
  carrier: 'xinghe-freight', provider: PROVIDER, origin: GZYL_ORIGIN, stage: xingheFreightStage, split: splitGzylRow,
};
