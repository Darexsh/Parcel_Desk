import { carrierIdFromName } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { janioStage } from './status.js';

export const PROVIDER = 'Janio';
// A long history is a few kilobytes.
export const JANIO_MAX_BYTES = 512 * 1024;
// Letters and digits with at least one digit: Janio's own numbers, its
// merchants' order-based ones and the partners' numbers its tracker also finds.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
// `updated_on` is an ISO instant, in UTC with or without microseconds.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const DELIVERED = 'DELIVERY_COMPLETED';
const MAX_ENTRIES = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * Janio's keys for the partners whose names the catalog does not know; other
 * keys are read as carrier names. The tracking page links `spx` references to
 * SPX's Singapore tracker.
 */
const PARTNERS: Readonly<Record<string, CarrierId>> = {
  singpost: 'singapore-post',
  scg: 'scg-express',
  spx: 'spx-sg',
};

/** A number for Janio's tracker, in upper case; anything else is not one it issues. */
export function normalizeJanioNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Janio numbers are eight or more letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Janio returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A whole reference in upper case, or nothing. */
function reference(value: string): string {
  const compact = normalizeTrackingNumber(value).toUpperCase();
  return REFERENCE.test(compact) ? compact : '';
}

/** The tracking page's heading for a status code: `DELIVERY_COMPLETED` is "Delivery Completed". */
function codeLabel(code: string): string {
  return code.toLowerCase().split('_').filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

interface Scan {
  readonly event: CarrierEvent;
  readonly timestamp: number;
  readonly code: string;
}

/**
 * One status update. Its `country` is where it happened; its `address` is left
 * out, since on pickup and delivery updates it is the recipient's.
 */
function scan(row: unknown): { key: string; scan: Scan } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Janio returned an invalid status update');
  const code = text(row, 'status', 64).toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Janio returned an invalid status code');
  const description = text(row, 'description', 500) || (code ? codeLabel(code) : '');
  if (!description) throw new SchemaError(PROVIDER, 'Janio returned a status update without wording');
  const raw = text(row, 'updated_on', 40);
  const time = INSTANT.test(raw) ? explicitOffsetTime(raw) : null;
  if (!time) throw new SchemaError(PROVIDER, 'Janio returned an invalid update time');
  const location = text(row, 'country', 80);
  const staged = janioStage(code, description);
  const event: CarrierEvent = {
    time: time.iso,
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time.iso, code, description.toLowerCase(), location]), scan: { event, timestamp: time.timestamp, code } };
}

/**
 * The delivery partner and its number, from `external_tracking_nos`, which
 * maps Janio's key for each partner to that partner's reference. A partner is
 * named when exactly one entry gives a catalog carrier whose rules offer the
 * reference: the other entries are Janio's own first-mile legs or references
 * the partner shares with Janio's number. The number asked or Janio's own is
 * no second reference.
 */
function partner(shipment: Record<string, unknown>, own: readonly string[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const references = shipment.external_tracking_nos;
  if (references === null || references === undefined) return {};
  if (!isRecord(references)) throw new SchemaError(PROVIDER, 'Janio returned invalid partner references');
  const named = new Map<string, { carrier: string; number: string }>();
  for (const [key, value] of Object.entries(references)) {
    const number = typeof value === 'string' ? reference(value) : '';
    const carrier = PARTNERS[key.trim().toLowerCase()] ?? carrierIdFromName(clean(key, 80));
    if (!number || !carrier || carrier === 'janio') continue;
    if (!(detectCarrierMatch(number).candidates as string[]).includes(carrier)) continue;
    named.set(`${carrier} ${number}`, { carrier, number });
  }
  const [only, ...others] = [...named.values()];
  if (!only || others.length) return {};
  return { delivery_carrier: only.carrier, ...(own.includes(only.number) ? {} : { delivery_tracking_number: only.number }) };
}

/** The destination as an ISO code, else as the reply names it. */
function destination(shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const name = text(shipment, 'consignee_country', 80);
  const code = name ? countryCode(name) : null;
  return code ? { destination_country: code } : name ? { destination_country_name: name } : {};
}

/**
 * The reply of the tracking page's `GET /api/v2/tracker/related-updates/` for
 * one number: a list with an entry for the parcel and any orders related to
 * it, or an empty list for a number Janio does not know, which the page
 * reports as "No data". The entry must carry the number asked as its
 * `tracking_no` or, for a parcel found by a partner's reference, as its
 * `searched_by`, as the page binds them.
 */
export function parseJanio(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJanioNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Janio returned an invalid reply');
  if (payload.length > MAX_ENTRIES) throw new SchemaError(PROVIDER, 'Janio returned an oversized reply');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  const entries = payload.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.tracking_no !== 'string') throw new SchemaError(PROVIDER, 'Janio returned a parcel without its number');
    return { entry, own: reference(entry.tracking_no), searched: reference(text(entry, 'searched_by', 64)) };
  });
  const found = entries.find((item) => item.own === number) ?? entries.find((item) => item.searched === number);
  if (!found) throw new IndeterminateError(PROVIDER, 'Janio answered for another shipment');
  const { entry: shipment, own } = found;

  const rows: unknown = shipment.status_updates ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Janio returned a parcel with invalid status updates');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Janio returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const { key, scan: projected } = scan(row);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(projected);
  }
  // The page shows a parcel without updates as "No data", as it does an unknown number.
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the reply and the page list them.
  scans.sort((a, b) => b.timestamp - a.timestamp);

  const events = scans.map((item) => item.event);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivery = stage === 'delivered' ? scans.find((item) => item.code === DELIVERED)?.event.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery } : {}),
    ...destination(shipment),
    ...partner(shipment, [number, own]),
    // A parcel found by its partner's reference has Janio's own number, as the page shows it.
    ...(own && own !== number ? { canonical_tracking_number: own } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
