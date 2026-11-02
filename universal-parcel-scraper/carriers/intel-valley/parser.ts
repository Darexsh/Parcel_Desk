import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { flightBooked, intelValleyStage } from './status.js';

export const PROVIDER = 'Intel-Valley';
export const INTEL_VALLEY_MAX_BYTES = RTB56_MAX_BYTES;

// IV and twelve digits.
const NUMBER = /^IV\d{12}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
const MAX_EVENTS = 100;

/** An Intel-Valley parcel number; anything else is not one its tracker is asked about. */
export function normalizeIntelValleyNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Intel-Valley parcel numbers are IV and twelve digits');
  return number;
}

/**
 * The reply of the tracker's `Service.ashx` lookup for one number: `data`
 * holds an entry per number, with the scans newest first, each a wall clock,
 * a place and English and Chinese wording. Only the entry whose
 * `server_hawbcode` is the whole number asked is read; the merchant's order
 * reference, the signatory and the proof of delivery are never read. A
 * flight booked for a day is left out: it is still to come.
 */
export function parseIntelValley(payload: unknown, raw: string): CarrierResult {
  const number = normalizeIntelValleyNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const events = rtb56Scans(rows, PROVIDER, intelValleyStage, { offsets: false }).filter((event) => !flightBooked(event.description!));
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  // A shipment order the line records after the parcel has left the warehouse is no step back.
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
    // The number of the network that carries the parcel on; the hand-off decides who that is.
    ...(REFERENCE.test(channel) && channel !== number ? { delivery_tracking_number: channel } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
