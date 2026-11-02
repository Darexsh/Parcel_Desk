import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { wiioStage } from './status.js';

export const PROVIDER = 'Wiio';
export const WIIO_ORIGIN = 'http://www.hzpdex.com:8082';

/**
 * How a row's clock reads. The rows PD Express copies from the airline and the
 * delivery carrier come to the minute on their own clocks, such as a delivery
 * in the United Kingdom at 13:20; its own rows keep their seconds and follow
 * the platform's Beijing clock.
 */
export const wiioClock = (row: HualeiRow): 'platform' | 'wall' => (row.clock.endsWith(':00') ? 'wall' : 'platform');

// The record's tracking number is the delivery carrier's once it has one.
export const WIIO: HualeiTenant = { carrier: 'wiio', provider: PROVIDER, origin: WIIO_ORIGIN, stage: wiioStage, clock: wiioClock,
  ownNumber: /^ZLX[A-Z]{2}\d{10}[A-Z]{2}$/ };

export const normalizeWiioNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parseWiioTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, WIIO, readAt);
export const parseWiioPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, WIIO, readAt);
