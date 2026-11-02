import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cevaLogisticsMilestoneStage, cevaLogisticsStage } from './status.js';

export const PROVIDER = 'CEVA Logistics';
/** The public track-and-trace API behind myCEVA's tracking page, which CEVA-Trak's own tracker also opens. */
export const CEVA_SHIPMENTS = 'https://my.cevalogistics.com/api/wso2/fm/shipment/trackntrace/public/1.0.0/shipments';
// A shipment with a long history is under 100 kB.
export const CEVA_DETAILS_MAX_BYTES = 2 * 1024 * 1024;
// A search answers at most ten shipments, a few kilobytes each.
export const CEVA_SEARCH_MAX_BYTES = 512 * 1024;
// As many results as the tracking page asks for.
const SEARCH_RESULTS = 10;
// Letters and digits with at least one digit. The tracker answers a reference
// of zeros with a stray record, and no CEVA reference is one.
const NUMBER = /^(?=[A-Z]*\d)(?!0+$)[A-Z0-9]{5,40}$/;
const REFERENCE_TYPE = /^[A-Z]{2,4}$/;
// The wall clock of the terminal that logged the event, written with a UTC
// offset of zero whatever the terminal's zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(?:\+0000|\+00:00|Z)$/;
const DATE = /^(\d{4}-\d{2}-\d{2})T/;
// Events whose clock is UTC, written like the terminals' wall clocks: a
// delivery window's confirmation carries the instant of its entry in the
// shipment's exception log, which is UTC.
const UTC_CLOCKS = new Set(['APPSET']);
const COUNTRY = /^[A-Z]{2}$/;
/**
 * What a matched reference can be for the adapter to follow it: the house
 * bill, and the order numbers a seller gives its buyer. A booking, a bill of
 * lading or a container also find shipments but are not what a parcel
 * tracker is handed.
 */
const FOLLOWED = new Set(['HouseBillNumber', 'OrderNumber', 'OrderID', 'PurchaseOrderReference']);
// The tracker's air, ocean and road forwarding, which the public lookup opens.
// Its ground, brokerage and contract-logistics modules answer elsewhere.
const FORWARDING = 'AO';
const MAX_GROUPS = 200;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;

/** A reference for CEVA's tracker, in capitals as it matches them; anything else is not one CEVA issues. */
export function normalizeCevaLogisticsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CEVA references are five to forty letters and digits');
  return number;
}

/** The shipment the tracker opens for a reference of a type, `HB` for a house bill. */
export function cevaLogisticsDetailsUrl(reference: string, type = 'HB'): string {
  if (!NUMBER.test(reference) || !REFERENCE_TYPE.test(type)) throw new SchemaError(PROVIDER, 'CEVA returned an invalid shipment reference');
  return `${CEVA_SHIPMENTS}/${encodeURIComponent(reference)}/${encodeURIComponent(type)}`;
}

/** The tracking page's search for one reference. */
export function cevaLogisticsSearchUrl(number: string): string {
  const url = new URL(CEVA_SHIPMENTS);
  url.searchParams.set('query', normalizeCevaLogisticsNumber(number));
  url.searchParams.set('max_results', String(SEARCH_RESULTS));
  return url.toString();
}

/** The reply the shipment lookup gives with HTTP 404 for a house bill it does not know. */
export function isCevaLogisticsMissing(payload: unknown): boolean {
  return isRecord(payload) && payload.status === 404 && payload.message === 'No results';
}

/** An optional text field; anything but a string or a number is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `CEVA returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** An optional object field. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `CEVA returned an invalid ${key}`);
  return value;
}

/** An optional list field. */
function list(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, `CEVA returned an invalid ${key}`);
  return value;
}

const own = (value: string) => normalizeTrackingNumber(value).toUpperCase();

/** The shipment a search found for a reference: what opens it and its own house bill. */
export interface CevaLogisticsMatch {
  reference: string;
  type: string;
  shipment: string;
}

/**
 * The tracking page's search for one reference. It matches the start of any
 * of a shipment's references, says which one matched, and lists nothing but
 * the count when more shipments match than it lists. A result counts when the
 * reference it matched is the whole number asked.
 */
export function parseCevaLogisticsSearch(payload: unknown, raw: string): CevaLogisticsMatch {
  const number = normalizeCevaLogisticsNumber(raw);
  if (!isRecord(payload) || typeof payload.total_results !== 'number' || !Array.isArray(payload.results)) {
    throw new SchemaError(PROVIDER, 'CEVA returned an invalid search reply');
  }
  if (payload.results.length > 100) throw new SchemaError(PROVIDER, 'CEVA returned an oversized search reply');
  if (payload.total_results === 0 && payload.results.length === 0) throw new NotFoundError(PROVIDER);
  const rows = payload.results.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'CEVA returned an invalid search result');
    return {
      matched: own(text(row, 'matched_reference_number', 80)),
      kind: text(row, 'matched_reference_type', 40),
      shipment: own(text(row, 'house_bill_number', 80)),
      module: text(row, 'module', 8).toUpperCase(),
      reference: text(row, 'reference_query', 80).toUpperCase(),
      type: text(row, 'reference_type_query', 8).toUpperCase(),
    };
  });
  const whole = rows.filter((row) => row.matched === number);
  if (!whole.length) {
    throw new IndeterminateError(PROVIDER, rows.length < payload.total_results ? 'CEVA matched more shipments than it lists'
      : 'CEVA matched only longer references');
  }
  const followed = whole.filter((row) => FOLLOWED.has(row.kind));
  if (!followed.length) throw new IndeterminateError(PROVIDER, 'CEVA matched a reference that is not a house bill or an order number');
  if (new Set(followed.map((row) => row.shipment)).size > 1) throw new IndeterminateError(PROVIDER, 'CEVA matched several shipments');
  const match = followed[0]!;
  if (!match.shipment || !match.reference) throw new SchemaError(PROVIDER, 'CEVA returned a search result without its shipment');
  if (match.module !== FORWARDING) throw new IndeterminateError(PROVIDER, 'CEVA matched a shipment its public lookup does not open');
  return { reference: match.reference, type: match.type || 'HB', shipment: match.shipment };
}

/** An event's clock as the reply writes it, without the offset; for most events the terminal's wall clock. */
function eventClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'local_date', 40));
  const local = match?.[1];
  // Parsing in UTC checks the calendar digits only.
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  if (!local || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'CEVA returned an invalid event time');
  }
  return local;
}

/** Where a group of events happened: its town and country, or nothing for a hub named by code alone. */
function place(group: Record<string, unknown>): string {
  const location = record(group, 'location');
  const town = text(location, 'name', 80);
  const country = text(location, 'country', 8).toUpperCase();
  if (!town) return '';
  return COUNTRY.test(country) ? `${town}, ${country}` : town;
}

const written = (event: CarrierEvent): string => event.local_time ?? event.time!.slice(0, 19);

/** The events the reply groups by terminal, with the event's own name; remarks and who logged it stay out. */
function history(groups: unknown[]): CarrierEvent[] {
  if (groups.length > MAX_GROUPS) throw new SchemaError(PROVIDER, 'CEVA returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let rows = 0;
  for (const group of groups) {
    if (!isRecord(group)) throw new SchemaError(PROVIDER, 'CEVA returned an invalid event group');
    const location = place(group);
    for (const row of list(group, 'events')) {
      if (++rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'CEVA returned an oversized history');
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'CEVA returned an invalid event');
      const description = text(row, 'name', 200);
      if (!description) throw new SchemaError(PROVIDER, 'CEVA returned an event without its name');
      const code = text(row, 'milestone_code', 16).toUpperCase();
      const clock = eventClock(row);
      const key = JSON.stringify([clock, code, description, location]);
      if (seen.has(key)) continue;
      seen.add(key);
      const staged = cevaLogisticsStage(code, description);
      events.push({
        ...(UTC_CLOCKS.has(code) ? { time: `${clock}Z` } : { local_time: clock }),
        ...(location ? { location } : {}),
        description,
        ...(code ? { provider_code: code } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      });
    }
  }
  // Newest first by the clock the reply writes, as each terminal's list is,
  // which places a UTC clock among the terminals' wall clocks as the page
  // does; the sort keeps the reply's order for equal clocks.
  return events.sort((a, b) => written(b).localeCompare(written(a)));
}

/** The shipment's weight in kilograms, as the tracker gives it beside pounds. */
function kilograms(summary: Record<string, unknown>): number | null {
  for (const row of list(summary, 'total_weight')) {
    if (!isRecord(row) || text(row, 'unit', 8).toUpperCase() !== 'KG') continue;
    const value = row.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new SchemaError(PROVIDER, 'CEVA returned an invalid weight');
    return value > 0 ? Math.round(value * 1000) / 1000 : null;
  }
  return null;
}

/** The day the page shows as the estimated arrival, or the scheduled one without an estimate. */
function estimate(summary: Record<string, unknown>): string | null {
  const dates = record(summary, 'arrival_dates');
  for (const key of ['estimated', 'scheduled']) {
    const day = DATE.exec(text(dates, key, 40))?.[1];
    if (day && DateTime.fromISO(day, { zone: 'UTC' }).isValid) return day;
  }
  return null;
}

/**
 * The tracker's shipment for a house bill, from the public lookup's
 * `/shipments/{reference}/{type}`. The reply must name the house bill asked,
 * or the one the search matched the number asked to; a match through an
 * order number reports its house bill as the canonical number.
 */
export function parseCevaLogisticsDetails(payload: unknown, raw: string, match?: CevaLogisticsMatch): CarrierResult {
  const number = normalizeCevaLogisticsNumber(raw);
  const expected = match?.shipment ?? number;
  if (!isRecord(payload) || !isRecord(payload.summary)) throw new SchemaError(PROVIDER, 'CEVA returned a shipment without its summary');
  const summary = payload.summary;
  const shipment = own(text(summary, 'house_bill_number', 80));
  if (!shipment) throw new SchemaError(PROVIDER, 'CEVA returned a shipment without its house bill');
  if (shipment !== expected) throw new IndeterminateError(PROVIDER, 'CEVA answered for another shipment');

  const events = history(list(payload, 'event_history'));
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const milestone = text(record(summary, 'latest_milestone'), 'code', 40);
  const filed = cevaLogisticsMilestoneStage(milestone);
  const scanned = events.find((event) => event.stage);
  // The milestone settles a delivery or a closure; the newest staged event
  // tells the rest. A cancelled booking goes no further.
  let stage: Stage | undefined = filed === 'delivered' || filed === 'exception' ? filed : scanned?.stage as Stage | undefined;
  if (summary.cancelled === true) stage = 'exception';
  // A delivery window's confirmation sorts by its UTC clock, hours ahead of the
  // terminals' in the Americas, so the newest event of the stage, not the newest event, heads the result.
  const newest = events.find((event) => stage && event.stage === stage) ?? scanned ?? events[0]!;
  const source = stage && stage !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const weight = kilograms(summary);
  const country = text(record(summary, 'destination'), 'country', 8).toUpperCase();
  const eta = stage === 'delivered' || stage === 'exception' ? null : estimate(summary);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: eta,
    ...(weight ? { weight_kg: weight } : {}),
    ...(COUNTRY.test(country) ? { destination_country: country } : {}),
    ...(shipment !== number ? { canonical_tracking_number: shipment } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
