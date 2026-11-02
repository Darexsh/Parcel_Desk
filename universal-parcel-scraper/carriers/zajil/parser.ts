import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { zajilMappedStage, zajilStage } from './status.js';

export const PROVIDER = 'Zajil Express';
export const CARRIER = 'zajil';
// A reply is under two kilobytes.
export const ZAJIL_MAX_BYTES = 256 * 1024;
// Eleven-digit shipment numbers, twelve-digit house waybills and the older Z references.
const NUMBER = /^(?:\d{11,12}|Z\d{7})$/;
// A wall clock to the second, with milliseconds after it.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{1,6})?$/;
const CODE = /^[A-Za-z_]{1,40}$/;
// What the reply puts in a field it has no value for.
const PLACEHOLDER = /^(?:not found|string|-+|false|none|null)$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

type Row = Record<string, unknown>;

/** A number for Zajil's tracker, in upper case; anything else is not one Zajil issues. */
export function normalizeZajilNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Zajil numbers are eleven or twelve digits, or Z and seven digits');
  return number;
}

/** An optional text field, without the reply's placeholders; `false` is one of them, anything else is a changed reply. */
function text(row: Row, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined || value === false) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Zajil returned an invalid ${key}`);
  const cleaned = clean(value, maxLength);
  return PLACEHOLDER.test(cleaned) ? '' : cleaned;
}

/**
 * A status's clock. `date` is a wall clock without a zone, which the page
 * shows as it comes; no offset was verified, so it stays local.
 */
function wallClock(row: Row): string {
  const local = CLOCK.exec(text(row, 'date', 40))?.[1] ?? '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Zajil returned an invalid status time');
  }
  return local;
}

/** The status's wording: the Arabic line the page shows, else its `website_update` value in words. */
function wording(row: Row, code: string): string {
  return text(row, 'arabic_update') || clean(code.replace(/_/g, ' '), 40);
}

function projectRow(row: Row): { key: string; event: CarrierEvent } {
  const code = cleanScalar(row.website_update, 40);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'Zajil returned a status without its update');
  const description = wording(row, code);
  const local = wallClock(row);
  // The branch or hub, in English; the city when the reply names no place.
  const location = text(row, 'location_name') || text(row, 'location_city');
  const staged = zajilStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/** The tracker's answer for a number it does not know: a list holding its one `shipment_not_found` error. */
export function isZajilNotFound(payload: unknown): boolean {
  return Array.isArray(payload) && payload.length === 1 && isRecord(payload[0]) && payload[0].code === 'shipment_not_found';
}

/**
 * The reply of `mobileapi.zajil-express.org/track?shipment=`, the lookup
 * Zajil's tracking page makes. A shipment carries its current status in
 * `current_update` and `history`, which has held only that status so far; the
 * page shows the status, the route and the status's time. A number the lookup
 * does not know is the `shipment_not_found` list. The shipment must name the
 * number asked. Amounts to collect, branch codes and the feedback field are
 * never read.
 */
export function parseZajil(payload: unknown, raw: string): CarrierResult {
  const number = normalizeZajilNumber(raw);
  if (isZajilNotFound(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Zajil returned an invalid envelope');
  const echoed = cleanScalar(payload.shipment, 64).toUpperCase();
  if (!echoed) throw new SchemaError(PROVIDER, 'Zajil returned a shipment without its number');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'Zajil answered for another shipment');
  const listed: unknown = payload.history ?? [];
  if (!Array.isArray(listed)) throw new SchemaError(PROVIDER, 'Zajil returned a shipment with an invalid history');
  const history: readonly unknown[] = listed;
  if (history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Zajil returned an oversized history');
  const current = payload.current_update ?? null;
  if (current !== null && !isRecord(current)) throw new SchemaError(PROVIDER, 'Zajil returned an invalid current status');

  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  for (const row of [...history, ...(current ? [current] : [])]) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Zajil returned an invalid status');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan.event);
  }
  // Newest first by wall clock.
  if (listsNewestFirst(scans) === false) scans.reverse();
  const events = scans.sort((left, right) => (right.local_time as string).localeCompare(left.local_time as string));

  // The shipment's own update is the current status, which the page's rail shows.
  const update = cleanScalar(payload.website_update, 40);
  const summary = zajilMappedStage(update);
  const scanned = events.find((event) => event.stage);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary ? 'carrier_map' : scanned?.stage_source;
  const newest = events[0];
  const statusText = newest?.description ?? text(payload, 'status');
  if (!newest && !stage) throw new NoHistoryError(PROVIDER);
  const destination = text(payload, 'destenation_country', 80);
  const country = destination ? countryCode(destination) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: statusText || null,
    last_update: null,
    last_update_local: typeof newest?.local_time === 'string' ? newest.local_time : null,
    expected_delivery: null,
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    // A single status is the current one alone, not a history.
    ...(events.length <= 1 ? { summary_only: true } : {}),
    ...(newest ? {} : CODE.test(update) ? { provider_code: update } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
