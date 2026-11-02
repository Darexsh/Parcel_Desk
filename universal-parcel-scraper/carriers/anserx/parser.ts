import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { anserxStage } from './status.js';

export const PROVIDER = 'AnserX';
// A long history is a few kilobytes.
export const ANSERX_MAX_BYTES = 256 * 1024;
// BTY, CN, ten digits and YQ: the numbers the tracker calls its own.
const NUMBER = /^BTYCN\d{10}YQ$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SHIPMENTS = 10;
const MAX_ROWS = 300;

/** An AnserX number in upper case, as the tracker reads it; anything else is not one AnserX issues. */
export function normalizeAnserxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'AnserX numbers are BTYCN, ten digits and YQ');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `AnserX returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's `YYYY-MM-DD HH:mm:ss`. The tracker says every scan time is the
 * time where the scan happened, and one history runs from China's clock to
 * the destination's, so it stays a wall clock.
 */
function scanClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'trackingTime', 32));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'AnserX returned an invalid scan time');
  }
  return local;
}

/**
 * A scan's place without its postcode: "Puebla，72000" is Puebla.
 * Each part keeps the words before the first one holding a digit, a postcode
 * or a street number. Scans in a country's network name only its code ("CN").
 */
function place(raw: string): string {
  const parts = raw.split(/[,，;；]/).map((part) => {
    const words = part.trim().split(' ');
    const index = words.findIndex((word) => /\d/.test(word));
    return (index < 0 ? words : words.slice(0, index)).join(' ').replace(/[\s:：/-]+$/, '');
  }).filter(Boolean);
  return [...new Set(parts)].join(', ');
}

/** The delivery carrier's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function deliveryNumber(raw: string, number: string): string {
  const compact = normalizeTrackingNumber(raw);
  const code = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  return /^[A-Z0-9]{4,40}$/.test(code) && code !== number ? code : '';
}

function projectRow(row: unknown, number: string): { key: string; event: CarrierEvent; delivery: string } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'AnserX returned an invalid scan');
  const owner = text(row, 'waybillNo', 64);
  if (owner && normalizeTrackingNumber(owner) !== number) throw new IndeterminateError(PROVIDER, 'AnserX returned a scan of another shipment');
  const code = text(row, 'trackingCode', 64);
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'AnserX returned an invalid scan code');
  // The English wording, as the page's English view shows it; the Chinese one when there is none.
  const description = text(row, 'trackingContentEn') || text(row, 'trackingContentCn');
  if (!description) throw new SchemaError(PROVIDER, 'AnserX returned a scan without wording');
  const local = scanClock(row);
  const location = place(text(row, 'trackingLocation', 120));
  const staged = anserxStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event, delivery: deliveryNumber(text(row, 'deliveryNo', 64), number) };
}

/**
 * The reply of the tracking page's `getTrackInfo` for one number: a list of
 * the shipments it found, each with its scans newest first. A number it does
 * not know leaves the list empty and is counted as abnormal, which the page
 * shows as nothing found. The shipment must be the number asked. The
 * customer's account code and order reference in it are not read.
 */
export function parseAnserx(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAnserxNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'AnserX returned an invalid envelope');
  if (payload.code !== 0) throw new IndeterminateError(PROVIDER, 'AnserX did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.list) || typeof data.abnormalCount !== 'number') {
    throw new SchemaError(PROVIDER, 'AnserX returned a reply without its result list');
  }
  if (!data.list.length) {
    if (data.abnormalCount > 0) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'AnserX returned an empty result');
  }
  if (data.list.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'AnserX returned an oversized result');
  if (!data.list.every((item) => isRecord(item) && typeof item.waybillNo === 'string')) {
    throw new SchemaError(PROVIDER, 'AnserX returned a shipment without its number');
  }
  const shipment = (data.list as Record<string, unknown>[]).find((item) => normalizeTrackingNumber(clean(item.waybillNo, 64)) === number);
  if (!shipment) throw new IndeterminateError(PROVIDER, 'AnserX answered for another shipment');
  const rows = shipment.tksTrackingDetailDTOList ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'AnserX returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'AnserX returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  const relayed = new Set<string>();
  for (const row of rows) {
    const scan = projectRow(row, number);
    if (scan.delivery) relayed.add(scan.delivery);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  // The clocks are each scan's own zone's, so they are not sorted.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The delivery number (派送单号) of the carrier that delivers at destination:
  // the shipment's, else the one its scans carry.
  const delivery = deliveryNumber(text(shipment, 'deliveryNo', 64), number) || (relayed.size === 1 ? [...relayed][0]! : '');
  const country = cleanScalar(shipment.destinationCountry, 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(delivery ? { delivery_tracking_number: delivery } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events: newestFirst,
  };
}
