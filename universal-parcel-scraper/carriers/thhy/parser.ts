import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { thhyEnglish, thhyStage } from './status.js';

export const PROVIDER = 'Tianhui Hengyuan';
export const THHY_ORIGIN = 'http://134.175.221.174:8082';
export const THHY: HualeiTenant = { carrier: 'thhy', provider: PROVIDER, origin: THHY_ORIGIN, stage: thhyStage, english: thhyEnglish };

export const normalizeThhyNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parseThhyTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, THHY, readAt);
export const parseThhyPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, THHY, readAt);
