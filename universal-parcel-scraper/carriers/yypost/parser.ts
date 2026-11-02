import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, isoTime } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Clock, rtb56Entry, rtb56Text, rtb56Wording } from './rtb56.js';
import { yypostStage } from './status.js';

export const PROVIDER = 'YYpost';
export const YYPOST_MAX_BYTES = RTB56_MAX_BYTES;

// YY, nine digits and CN.
const NUMBER = /^YY\d{9}CN$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
const MAX_EVENTS = 100;
// The clocks of onward networks whose rows YYpost relays on them, by the
// carrier the onward number belongs to. Ecoscooting's order creation falls to
// the second of Ecoscooting's own record of it on Spain's clock.
const ONWARD_CLOCKS: Readonly<Record<string, string>> = { ecoscooting: 'Europe/Madrid' };

/** A YYpost parcel number; anything else is not one its tracker answers. */
export function normalizeYypostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'YYpost parcel numbers are YY, nine digits and CN');
  return number;
}

/**
 * The reply of the tracker's `Service.ashx` lookup for one number: `data`
 * holds an entry per number, with the scans newest first, each a wall clock
 * without a zone, a place and English and Chinese wording. A number the
 * tracker does not know gets `success` 0 and its "No query to track
 * information" message. Only the entry whose `server_hawbcode` is the whole
 * number asked is read; the merchant's order reference, the signatory and the
 * proof of delivery are never read.
 */
export function parseYypost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeYypostNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);

  const channel = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  const onward = REFERENCE.test(channel) && channel !== number ? channel : '';
  const detected = onward ? detectCarrierMatch(onward) : null;
  const onwardClock = detected?.confidence === 'high' && Object.hasOwn(ONWARD_CLOCKS, detected.carrier)
    ? ONWARD_CLOCKS[detected.carrier] : undefined;

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'YYpost returned an invalid scan');
    const { local } = rtb56Clock(row, PROVIDER);
    const { description, location } = rtb56Wording(row, PROVIDER);
    // A row without wording says nothing.
    if (!description) continue;
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = yypostStage(description);
    // A row without a code of YYpost's or a place is the onward network's, on that network's clock.
    const relayed = onwardClock && !cleanScalar(row.track_code, 40) && !location ? isoTime(local, onwardClock) : null;
    events.push({
      ...(relayed ? { time: relayed.iso } : { local_time: local }),
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  // The shipment order the line records once the parcel has left the warehouse is no step back.
  const staged = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    // The number of the network that carries the parcel on; the hand-off decides who that is.
    ...(onward ? { delivery_tracking_number: onward } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
