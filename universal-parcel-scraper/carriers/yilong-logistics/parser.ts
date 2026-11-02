import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { yilongStage } from './status.js';

export const PROVIDER = 'Yilong Logistics';
export const YILONG_ORIGIN = 'http://www.yxhlexpress.com:8082';
export const YILONG: HualeiTenant = { carrier: 'yilong-logistics', provider: PROVIDER, origin: YILONG_ORIGIN, stage: yilongStage };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseYilongTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, YILONG, readAt);
export const parseYilongPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, YILONG, readAt);
