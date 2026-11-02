import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { eweStage } from './status.js';
import { newestFirst, parseTrace, scanRows, scanWording, summarize, textField } from './trace.js';

export const PROVIDER = 'EWE';
// Letters and digits with at least one digit. The trace tracker reads a lower-case number as unknown.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;

/** A number for EWE's trackers, in upper case; anything else is not one it issues. */
export function normalizeEweNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'EWE numbers are eight or more letters and digits');
  return number;
}

const text = (row: Record<string, unknown>, key: string, maxLength?: number) => textField(PROVIDER, row, key, maxLength);

/** A scan's wording without the driver's name or a phone number. */
export const eweWording = scanWording;

// The main lookup's clock: the scanning site's wall clock, to the minute.
const DATE_STRING = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/;
// Its answer for a number it does not know.
const UNKNOWN = /\bcouldn['’]?t find\b|\bcould not find\b|\bnot in our system\b/i;

/**
 * A scan's clock in the main lookup. `DateString` names no zone, and EWE's
 * sites are in more than one Australian time zone, so the clock stays local.
 */
function wallClock(value: string): string {
  const match = DATE_STRING.exec(value);
  const local = match ? `${match[1]}T${match[2]}:${match[3] ?? '00'}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'EWE returned an invalid scan time');
  }
  return local;
}

function lookupEvent(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'EWE returned an invalid scan');
  const description = eweWording(text(row, 'Message'));
  if (!description) throw new SchemaError(PROVIDER, 'EWE returned a scan without wording');
  const local = wallClock(text(row, 'DateString', 32));
  const location = text(row, 'Place', 120);
  const staged = eweStage('', description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, description, location]), event };
}

/** The consignment the reply holds for the number: its own, else the one that lists it among its articles. */
function consignmentFor(rows: unknown[], number: string): Record<string, unknown> {
  const entries = rows.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'EWE returned an invalid consignment');
    if (typeof row.ConsignmentNo !== 'string') throw new SchemaError(PROVIDER, 'EWE returned a consignment without its number');
    return row;
  });
  const own = entries.find((row) => clean(row.ConsignmentNo, 64).toUpperCase() === number);
  const listing = entries.filter((row) => text(row, 'ArticleNos', 20_000).toUpperCase().split(/[\s,]+/).includes(number));
  const entry = own ?? (listing.length === 1 ? listing[0] : undefined);
  if (!entry) throw new IndeterminateError(PROVIDER, 'EWE answered for another shipment');
  return entry;
}

/**
 * The reply of the lookup EWE's tracking page makes, which answers eMetro
 * consignments and the parcels of EWE's delivery system alike. It answers a
 * number it does not know with HTTP 200, no scans and a `Status` saying so.
 */
export function parseEweLookup(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEweNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.Payload)) throw new SchemaError(PROVIDER, 'EWE returned an invalid envelope');
  if (text(payload, 'Error') || !payload.Payload.length) throw new IndeterminateError(PROVIDER, 'EWE did not complete the lookup');
  const entry = consignmentFor(payload.Payload, number);
  const rows = scanRows(entry.Details, PROVIDER);
  if (!rows.length) {
    if (UNKNOWN.test(text(entry, 'Status'))) throw new NotFoundError(PROVIDER);
    throw new NoHistoryError(PROVIDER);
  }
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = lookupEvent(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  // The reply lists eMetro's scans newest first and the delivery system's oldest first.
  return summarize(newestFirst(events, (event) => DateTime.fromISO(event.local_time as string, { zone: 'UTC' }).toMillis()), PROVIDER);
}

/** The reply of EWE's trace tracker, which knows the parcels of EWE's delivery system only. */
export function parseEweTrace(payload: unknown, raw: string): CarrierResult {
  return parseTrace(payload, normalizeEweNumber(raw), { provider: PROVIDER, stage: eweStage });
}
