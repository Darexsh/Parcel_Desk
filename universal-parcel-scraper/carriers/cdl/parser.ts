import { DateTime } from 'luxon';
import { IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cdlRequestNumber } from './number.js';
import { cdlStage, DELIVERY_COMPLETE } from './status.js';

export const PROVIDER = 'CDL Last Mile';
// Delivery scans carry their proof-of-delivery photos inline, about half a
// megabyte each, so a delivered parcel's reply runs to a megabyte or more.
export const CDL_MAX_BYTES = 8_000_000;
// The clocks are CDL's Eastern wall clocks; its former tracker labelled them ET.
export const CDL_ZONE = 'America/New_York';

// "2026-03-25T06:55:56.32": no offset, up to seven decimals.
const CLOCK = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/;
// The label's scan is placed where the label was made; the page leaves that place out.
const LABEL_CREATED = 'label has been created';
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** A scan's clock as an instant in CDL's zone, or null when it is not a valid wall clock. */
function instantOf(value: unknown): { iso: string; timestamp: number } | null {
  const stamp = clean(value, 40);
  if (!CLOCK.test(stamp)) return null;
  const parsed = firstOccurrence(DateTime.fromISO(stamp, { zone: CDL_ZONE }));
  const iso = parsed.isValid ? parsed.toISO({ suppressMilliseconds: true }) : null;
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

interface Scan { event: CarrierEvent; timestamp: number }

function scanOf(row: unknown): Scan {
  if (!isRecord(row) || typeof row.trackingEvent !== 'string' || typeof row.trackingEventTimestamp !== 'string') {
    throw new SchemaError(PROVIDER, 'CDL returned a scan without its wording or clock');
  }
  for (const field of ['eventCity', 'eventState'] as const) {
    if (row[field] != null && typeof row[field] !== 'string') throw new SchemaError(PROVIDER, 'CDL returned a scan with an invalid place');
  }
  if (row.isException != null && typeof row.isException !== 'boolean') throw new SchemaError(PROVIDER, 'CDL returned a scan with an invalid flag');
  const description = clean(row.trackingEvent, 300);
  const clock = instantOf(row.trackingEventTimestamp);
  if (!description || !clock) throw new SchemaError(PROVIDER, 'CDL returned a scan without its wording or clock');
  const place = description.toLocaleLowerCase('en-US') === LABEL_CREATED ? ''
    : [clean(row.eventCity, 100), clean(row.eventState, 20)].filter(Boolean).join(', ');
  const event: CarrierEvent = { time: clock.iso, description, ...(place ? { location: place } : {}) };
  const stage = cdlStage(description, row.isException === true);
  if (stage) Object.assign(event, { stage: stage.stage, stage_source: stage.source });
  return { event, timestamp: clock.timestamp };
}

/**
 * The completed delivery is stamped on its whole minute, so it can read a few
 * seconds before the scan at the door that preceded it. Within that minute it
 * is the newest scan.
 */
function orderOf(scan: Scan): number {
  const whole = scan.event.description === DELIVERY_COMPLETE && scan.timestamp % 60_000 === 0;
  return whole ? scan.timestamp + 59_999 : scan.timestamp;
}

/**
 * The reply of `Tracking/details` for one number. It names the parcel's
 * package reference, which must be the whole requested number, and lists its
 * scans. Proof-of-delivery photos, the driver, where the parcel was left, the
 * destination and the map position are never read.
 */
export function parseCdl(payload: unknown, raw: string): CarrierResult {
  const number = cdlRequestNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.trackingInformation) || !Array.isArray(payload.trackingEvents)) {
    throw new SchemaError(PROVIDER, 'CDL returned an unexpected reply');
  }
  const reference = payload.trackingInformation.referenceNumber;
  if (typeof reference !== 'string') throw new SchemaError(PROVIDER, 'CDL returned a parcel without its package reference');
  // The service also matches other fields; a parcel under another reference is no answer for this number.
  if (clean(reference, 80).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'CDL answered for a parcel under another package reference');
  }
  const rows = payload.trackingEvents as unknown[];
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'CDL returned too many scans');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'CDL lists the parcel without scans');

  const seen = new Set<string>();
  const scans = rows.map(scanOf).filter(({ event }) => {
    // A delivery can be listed once per photo.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => orderOf(b) - orderOf(a));
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: newest.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
