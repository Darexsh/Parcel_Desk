import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { mesoGlobalEnglish, mesoGlobalStage } from './status.js';

export const PROVIDER = 'Meso-global';
export const MESO_GLOBAL_ORIGIN = 'http://www.mesoglobal.cc:8082';
export const MESO_GLOBAL: HualeiTenant = {
  carrier: 'meso-global', provider: PROVIDER, origin: MESO_GLOBAL_ORIGIN, stage: mesoGlobalStage, english: mesoGlobalEnglish,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseMesoGlobalTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, MESO_GLOBAL, readAt);
export const parseMesoGlobalPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, MESO_GLOBAL, readAt);
