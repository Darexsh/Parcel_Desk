import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { ydhStage } from './status.js';

export const PROVIDER = 'YDH';
export const YDH_MAX_BYTES = RTB56_MAX_BYTES;

// YDH, ten digits and two letters.
const NUMBER = /^YDH\d{10}[A-Z]{2}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
const MAX_EVENTS = 100;

/** A YDH parcel number; anything else is not one it issues. */
export function normalizeYdhNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'YDH parcel numbers are YDH, ten digits and two letters');
  return number;
}

/**
 * The reply of the tracker's `Service.ashx` lookup for one number: `data`
 * holds an entry per number, with the scans newest first, each a wall clock,
 * a place, a code and wording: YDH's own in Chinese or English, then those
 * of the partner that delivers abroad, relayed in its language. Only the
 * entry whose `server_hawbcode` is the whole number asked is read; the
 * merchant's order reference and the signatory are never read.
 */
export function parseYdh(payload: unknown, raw: string): CarrierResult {
  const number = normalizeYdhNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const events = rtb56Scans(rows, PROVIDER, ydhStage, { offsets: false, codes: true });
  const newest = events[0]!;
  // A label or electronic information recorded after the parcel moved is no step back.
  const staged = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  const channel = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    // The partner's own number for the parcel; the hand-off decides who that is.
    ...(REFERENCE.test(channel) && channel !== number ? { delivery_tracking_number: channel } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
