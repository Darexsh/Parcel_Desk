import { DateTime, FixedOffsetZone } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cjPacketCurrentStage, cjPacketStage, cjPacketSummary } from './status.js';

export const PROVIDER = 'CJ Packet';
// A long history is under ten kilobytes.
export const CJ_PACKET_MAX_BYTES = 512 * 1024;
// `cj-packet-1`'s layout: CJP, two or three letters, ten digits and YQ.
const NUMBER = /^CJP[A-Z]{2,3}\d{10}YQ$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const STAMP = /^\d{1,15}$/;
// The place a relayed line can open with, such as "[US,SAMPLE CITY,ST]".
const PLACE = /^\[([^\]]{1,120})\]\s*/;
// A clause that sends the reader to someone's support, with whatever follows it.
const CONTACT = /\s*[,，;；]\s*(?=[^,，;；]*\b(?:contact|support|customer service|hotline)\b)[\s\S]*$/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who took a delivered parcel, after the delivery's own words.
const RECEIVER = /\s*[,;:.\-–]\s*(?:signed(?: for)? by|signatory|received by|recibido por|entregado a)\b[\s\S]*$/i;
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A CJ Packet number, in capitals as the tracker needs it; anything else is not one CJ Packet issues. */
export function normalizeCjPacketNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CJ Packet numbers are CJP, two or three letters, ten digits and YQ');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `CJ Packet returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's wording without the support contact a courier appends to it, and
 * without phone numbers or e-mail addresses.
 */
export function cjPacketWording(activity: string): string {
  return clean(activity.replace(CONTACT, '').replace(EMAIL, '').replace(PHONE, '').replace(/\s+([,，;；.。])/g, '$1'))
    .replace(/^[\s,，;；:]+|[\s,，;；:\-–]+$/g, '');
}

/**
 * A scan's clock. `eventTime` is the scanning site's wall clock and
 * `eventTimestamp`, when the forwarder sends one, the same moment in epoch
 * milliseconds, which the page shows instead. Their difference is the site's
 * offset, so such a scan is returned at it. A scan without one, or whose two
 * clocks do not differ by an offset a clock can have, keeps its wall clock.
 */
function scanClock(row: Record<string, unknown>): { time: string } | { local_time: string } {
  const wall = text(row, 'eventTime', 32);
  const local = wall.replace(' ', 'T');
  // Parsing in UTC checks the calendar digits only.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!WALL_CLOCK.test(wall) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'CJ Packet returned an invalid scan time');
  }
  const raw = row.eventTimestamp;
  if (raw === null || raw === undefined || raw === '') return { local_time: local };
  const stamp = typeof raw === 'number' ? raw : typeof raw === 'string' && STAMP.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(stamp) || stamp <= 0) throw new SchemaError(PROVIDER, 'CJ Packet returned an invalid scan timestamp');
  const minutes = (parsed.toMillis() - stamp) / 60_000;
  if (!Number.isInteger(minutes) || minutes % 15 !== 0 || minutes < -12 * 60 || minutes > 14 * 60) return { local_time: local };
  const time = DateTime.fromMillis(stamp, { zone: FixedOffsetZone.instance(minutes) }).toISO({ suppressMilliseconds: true });
  return time ? { time } : { local_time: local };
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } | null {
  // The page writes the line out as HTML.
  const activity = textFromHtml(text(row, 'activity', 1000), 1000);
  const place = PLACE.exec(activity);
  let description = cjPacketWording(place ? activity.slice(place[0].length) : activity);
  const staged = cjPacketStage(description);
  if (staged?.stage === 'delivered') description = description.replace(RECEIVER, '');
  const clock = scanClock(row);
  // A line left empty says nothing to keep.
  if (!description) return null;
  const location = text(row, 'location', 200) || clean(place?.[1], 120);
  const event: CarrierEvent = {
    ...clock,
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock, description, location]), event };
}

/**
 * The destination courier's number from the reply's last-mile field, and
 * that courier when the reply names one the catalog knows whose rules fit
 * the number. A USPS routing barcode gives its package identifier.
 */
function handoff(shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const compact = normalizeTrackingNumber(text(shipment, 'lastTrackNumber', 64)).toUpperCase();
  const reference = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return {};
  const partner = carrierIdFromPartner(text(shipment, 'providerEnName', 80), text(shipment, 'providerUrl', 500));
  const named = partner && partner !== 'cj-packet' && (detectCarrierMatch(reference).candidates as string[]).includes(partner);
  return { ...(named ? { delivery_carrier: partner } : {}), delivery_tracking_number: reference };
}

/** The shipment's summary code: a whole number, or nothing. */
function summaryCode(shipment: Record<string, unknown>): number | undefined {
  const code = shipment.status;
  if (code === null || code === undefined) return undefined;
  if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new SchemaError(PROVIDER, 'CJ Packet returned an invalid status');
  return code;
}

/**
 * The reply of the tracking page's `POST /cj-logistics-api/refactoring/cjpacket/track`
 * for one number. An unknown number is an empty list. The tracker also finds a
 * shipment by its forwarder's or its courier's number, so a shipment counts
 * only when its own CJ Packet number is the one asked. The merchant, the
 * order's references and the courier's phone are never read.
 */
export function parseCjPacket(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCjPacketNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'CJ Packet returned an invalid envelope');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'CJ Packet did not complete the lookup');
  const shipments = payload.data;
  if (!Array.isArray(shipments) || shipments.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'CJ Packet returned an invalid shipment list');
  // The page shows "No tracking info found." for an empty list.
  if (!shipments.length) throw new NotFoundError(PROVIDER);
  const own = shipments.filter((shipment) => {
    if (!isRecord(shipment) || typeof shipment.cjTrackNumber !== 'string') {
      throw new SchemaError(PROVIDER, 'CJ Packet returned a shipment without its number');
    }
    return normalizeTrackingNumber(clean(shipment.cjTrackNumber, 64)).toUpperCase() === number;
  }) as Record<string, unknown>[];
  if (!own.length) throw new IndeterminateError(PROVIDER, 'CJ Packet answered for another shipment');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'CJ Packet answered with several shipments for the number');
  const shipment = own[0]!;

  const rows = shipment.trackEvent ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'CJ Packet returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'CJ Packet returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'CJ Packet returned an invalid scan');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }

  const code = summaryCode(shipment);
  const summary = code === undefined ? undefined : cjPacketSummary(code);
  const service = text(shipment, 'logisticsName', 80);
  const country = text(shipment, 'destCountryCode', 8).toUpperCase();
  const facts = {
    ...(service ? { service_name: service } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...handoff(shipment, number),
  };
  if (!events.length) {
    // A shipment without scans keeps the status the tracker gives it.
    if (!summary) throw new NoHistoryError(PROVIDER);
    return { status: languageStageStatus(summary.stage), current_stage: summary.stage, current_stage_source: 'carrier_map',
      last_status_text: text(shipment, 'statusDescription', 80) || summary.wording, provider_code: String(code),
      last_update: null, expected_delivery: null, ...facts, summary_only: true, events: [] };
  }

  // Newest first, as the page lists them by wall clock: scans at different
  // offsets are not all instants, so the reply's order stands.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = cjPacketCurrentStage(summary, scanned?.stage as Stage | undefined);
  const source = stage === scanned?.stage ? scanned?.stage_source : 'carrier_map';
  // A delivery's moment is its delivered scan's, when that scan has an offset;
  // the summary alone, or a wall clock, gives none.
  const deliveredAt = stage === 'delivered' && scanned?.stage === 'delivered' ? scanned.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...facts,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
