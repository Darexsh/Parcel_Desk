import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { huayaStage } from './status.js';

export const PROVIDER = 'Huaya Express';
export const HUAYA_ORIGIN = 'http://193.112.176.17:8082';
export const HUAYA: HualeiTenant = { carrier: 'huaya-express', provider: PROVIDER, origin: HUAYA_ORIGIN, stage: huayaStage };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseHuayaTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, HUAYA, readAt);
export const parseHuayaPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, HUAYA, readAt);
