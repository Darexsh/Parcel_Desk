import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { komonStage } from './status.js';

export const PROVIDER = 'Komon Express';
export const KOMON_MAX_BYTES = RTB56_MAX_BYTES;

// KOMON, ten digits and YQ.
const NUMBER = /^KOMON\d{10}YQ$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
// The sentence the delivering network adds after its status, which repeats its clock and place.
const SENTENCE = /\s+->\s.*$/s;
const MAX_EVENTS = 100;

/** A Komon Express parcel number; anything else is not one its tracker is asked about. */
export function normalizeKomonNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Komon Express parcel numbers are KOMON, ten digits and YQ');
  return number;
}

/**
 * A scan with its wording alone: the delivering network's scans open with
 * their place, postcode and all, and close with a sentence after an arrow.
 */
function ownWording(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const place = rtb56Text(row, 'track_location', PROVIDER, 120);
  const wording = (key: string) => {
    const text = rtb56Text(row, key, PROVIDER, 1000);
    return (place && text.startsWith(`${place}, `) ? text.slice(place.length + 2) : text).replace(SENTENCE, '');
  };
  return { ...row, track_description_en: wording('track_description_en'), track_description: wording('track_description') };
}

/**
 * The reply of the tracker's `Service.ashx` lookup for one number: `data`
 * holds an entry per number, with the scans newest first, each a wall clock,
 * a place, a code and English wording. Only the entry whose `server_hawbcode`
 * is the whole number asked is read; the merchant's order reference, the
 * signatory and the proof of delivery are never read.
 */
export function parseKomon(payload: unknown, raw: string): CarrierResult {
  const number = normalizeKomonNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const events = rtb56Scans(rows.map(ownWording), PROVIDER, komonStage, { offsets: false, codes: true });
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
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
    // The delivering network's number; nothing in the reply names the network.
    ...(REFERENCE.test(channel) && channel !== number ? { delivery_tracking_number: channel } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
