import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { lingdongStage } from './status.js';

export const PROVIDER = 'Lingdong International';
export const LINGDONG_ORIGIN = 'http://tms.lingdong56.com:8082';
export const LINGDONG: HualeiTenant = { carrier: 'lingdong', provider: PROVIDER, origin: LINGDONG_ORIGIN, stage: lingdongStage };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseLingdongTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, LINGDONG, readAt);
export const parseLingdongPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, LINGDONG, readAt);
