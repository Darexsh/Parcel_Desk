import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { hepsijetStage } from './status.js';

export const PROVIDER = 'HepsiJET';
// A long history is a few kilobytes.
export const HEPSIJET_MAX_BYTES = 256 * 1024;
// Merchants print their own codes, so the tracker takes any run of letters and digits.
const NUMBER = /^[A-Z0-9]{8,30}$/;
const ZONE = 'Europe/Istanbul';
// The scan clock, with or without its offset.
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const CODE = /^[A-Z][A-Z_]{1,40}$/;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A number for HepsiJET's tracker, in capitals as the tracker matches it; anything else is not one it issues. */
export function normalizeHepsijetNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HepsiJET numbers are eight to thirty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `HepsiJET returned an invalid ${key}`);
  return clean(value, maxLength);
}

// What follows a handover's wording: the person who took the parcel and how
// they relate to the recipient, "Teslim edildi - Sample P***** (Kendi)".
const HANDED_TO = /\s+[-–]\s+[\s\S]*$/;

/**
 * A scan's wording, without the person who took the parcel, and with the
 * reason a delivery or a pickup failed: "Teslim Edilemedi: Hasarlı".
 */
export function hepsijetWording(transaction: string, reason = ''): string {
  const own = clean(transaction).replace(HANDED_TO, '').replace(/[\s:;,.-]+$/, '');
  const why = clean(reason, 120);
  return own && why ? `${own}: ${why}` : own;
}

// The tracker's names for where a parcel is when it is in no facility: with
// the recipient, with the sender, in the delivery van. None is a place.
const NO_PLACE = new Set(['alıcıda', 'satıcıda', 'dağıtım aracında']);

function projectRow(row: unknown): { key: string; event: CarrierEvent; at: number } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'HepsiJET returned an invalid scan');
  const stamp = text(row, 'transactionDateTime', 40);
  // HepsiJET scans in Turkey, whose clocks keep one offset; a clock without it is read there.
  const at = CLOCK.test(stamp) ? isoTime(stamp, ZONE) : null;
  if (!at) throw new SchemaError(PROVIDER, 'HepsiJET returned an invalid scan time');
  const description = hepsijetWording(text(row, 'transaction', 300),
    text(row, 'nonDeliveryReasonMessage', 120) || text(row, 'nonDeliveryReturnReasonMessage', 120));
  if (!description) throw new SchemaError(PROVIDER, 'HepsiJET returned a scan without wording');
  const code = text(row, 'deliveryStatus', 48).toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'HepsiJET returned an invalid delivery status');
  const place = text(row, 'location', 120);
  const location = NO_PLACE.has(place.toLocaleLowerCase('tr-TR')) ? '' : place;
  const staged = hepsijetStage(code, description);
  const event: CarrierEvent = {
    time: at.iso,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([at.iso, code, description, location]), event, at: at.timestamp };
}

/** The promised day the page shows, in Istanbul, while the parcel is still on its way. */
function promised(shipment: Record<string, unknown>, stage: Stage | undefined): string | null {
  // A return's date is the day it is collected, not delivered.
  if (stage === 'delivered' || stage === 'returned' || text(shipment, 'deliveryType', 40) === 'RETURNED') return null;
  const value = text(shipment, 'deliveryDatePromised', 40);
  const at = CLOCK.test(value) ? isoTime(value, ZONE) : null;
  return at ? DateTime.fromMillis(at.timestamp, { zone: ZONE }).toISODate() : null;
}

/**
 * The reply of the tracking page's `webDeliveryTracking` lookup for one
 * number. `FAIL` with `DELIVERY_BARCODE_NOT_FOUND` is the page's unknown
 * number; `OK` without a shipment and `params.IsNeo` is a number HepsiJET
 * has not received a parcel for yet. A shipment must carry the number asked,
 * as its own number or its barcode.
 */
export function parseHepsijet(payload: unknown, raw: string): CarrierResult {
  const number = normalizeHepsijetNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'string') throw new SchemaError(PROVIDER, 'HepsiJET returned an invalid envelope');
  if (payload.status === 'FAIL') {
    if (payload.detailStatus === 'DELIVERY_BARCODE_NOT_FOUND') throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'HepsiJET did not complete the lookup');
  }
  if (payload.status !== 'OK') throw new SchemaError(PROVIDER, 'HepsiJET returned an unknown lookup status');
  const shipments = payload.data ?? [];
  if (!Array.isArray(shipments) || shipments.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'HepsiJET returned invalid shipments');
  if (!shipments.length) {
    if (isRecord(payload.params) && payload.params.IsNeo === true) {
      throw new NoHistoryError(PROVIDER, 'HepsiJET has not received the parcel yet');
    }
    // The page reports an empty list as a missing shipment.
    throw new NotFoundError(PROVIDER);
  }
  if (!shipments.every(isRecord)) throw new SchemaError(PROVIDER, 'HepsiJET returned an invalid shipment');
  const own = (value: string) => normalizeTrackingNumber(value) === number;
  if (!shipments.some((item) => typeof item.customerDeliveryNo === 'string' || typeof item.barcode === 'string')) {
    throw new SchemaError(PROVIDER, 'HepsiJET returned a shipment without its number');
  }
  const shipment = shipments.find((item) => own(text(item, 'customerDeliveryNo', 64)) || own(text(item, 'barcode', 64)));
  if (!shipment) throw new IndeterminateError(PROVIDER, 'HepsiJET answered for another shipment');
  const rows = shipment.transactions ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'HepsiJET returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'HepsiJET returned an oversized history');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; at: number; index: number }[] = [];
  for (const row of rows) {
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push({ event: scan.event, at: scan.at, index: scans.length });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // The reply lists scans oldest first; scans at one clock keep their order, reversed.
  const events = scans.sort((left, right) => right.at - left.at || right.index - left.index).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current : undefined;
  const service = text(shipment, 'productName', 80);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: promised(shipment, stage),
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...(service ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
