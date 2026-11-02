import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, type HualeiTenant } from '../gzyl/hualei.js';
import { byhdStage } from './status.js';

export const PROVIDER = 'BYHD';
export const BYHD_ORIGIN = 'http://www.byhd56.com:8082';
// The page finds an order by BYHD's number and shows only the delivery carrier's and the shipper's.
export const BYHD: HualeiTenant = { carrier: 'byhd', provider: PROVIDER, origin: BYHD_ORIGIN, stage: byhdStage, pageEcho: true };

export const parseByhdPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, BYHD, readAt);
