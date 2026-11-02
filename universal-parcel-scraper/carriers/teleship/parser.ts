import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { teleshipStage, teleshipStatusStage } from './status.js';

export const PROVIDER = 'Teleship';
// A long history is a few kilobytes.
export const TELESHIP_MAX_BYTES = 256 * 1024;
// TS, the origin and destination countries, then the shipment's own characters:
// fifteen in Teleship's examples, nine when its FAQ counts them.
const NUMBER = /^TS[A-Z]{4}[A-Z0-9]{9,30}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The tracker's own answer to a number it holds no shipment for.
const NOT_FOUND = /^shipment not found$/i;

/** A Teleship tracking ID, in capitals; anything else is not one Teleship issues. */
export function normalizeTeleshipNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Teleship tracking IDs start with TS and two country codes');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Teleship returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An ISO instant with its offset, as every Teleship clock is written. */
function instant(value: string): string {
  const parsed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? explicitOffsetTime(value) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Teleship returned an invalid time');
  return parsed.iso;
}

// The line-haul partners the tracking page leaves out of a scan's place.
const PARTNERS = /mark\s*3,?\s*|seko,?\s*|pro\s*carrier,?\s*|procarrier,?\s*/gi;

/** A scan's place as the page shows it, without the line-haul partner's name. */
export function teleshipLocation(raw: string): string {
  return clean(raw.replace(PARTNERS, '')).replace(/^[\s,]+|[\s,]+$/g, '');
}

// Who signed for the parcel, after a delivery scan's wording, and phone
// numbers anywhere in it. "Received by" names the carrier that took it over.
const RECEIVER = /\s*[,;:.\-–]?\s*\bsigned\s+(?:for\s+)?by\b[\s\S]*$/i;
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/** A scan's wording without who signed for the parcel or a phone number. */
export function teleshipWording(raw: string): string {
  return clean(raw.replace(RECEIVER, '').replace(PHONE, '')).replace(/[\s,;:\-–]+$/, '');
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent; type: string } {
  const time = instant(text(row, 'timestamp', 40));
  const code = cleanScalar(row.code, 40).toUpperCase();
  const type = text(row, 'type', 40).toLowerCase();
  const description = teleshipWording(text(row, 'description'));
  if (!description) throw new SchemaError(PROVIDER, 'Teleship returned a scan without wording');
  const location = teleshipLocation(text(row, 'location', 160));
  const staged = teleshipStage(type, description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time, code, description, location]), event, type };
}

/**
 * The carrier that delivers in the destination country and its own number,
 * which the page shows under "Delivered By" once the parcel reaches that
 * country. The partner is named only when the catalog knows its name and its
 * link, if any, is its own; a USPS routing barcode keeps its package number.
 */
function lastMile(data: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const partner = data.lastMile;
  if (partner === null || partner === undefined) return {};
  if (!isRecord(partner)) throw new SchemaError(PROVIDER, 'Teleship returned an invalid last-mile carrier');
  const compact = normalizeTrackingNumber(text(partner, 'trackingNumber', 80)).toUpperCase();
  const delivery = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!/^[A-Z0-9]{4,40}$/.test(delivery) || delivery === number) return {};
  const url = text(partner, 'trackingUrl', 400);
  const carrier = carrierIdFromPartner(text(partner, 'carrier', 80), /^https:\/\//i.test(url) ? url : '');
  return { ...(carrier && carrier !== 'teleship' ? { delivery_carrier: carrier } : {}), delivery_tracking_number: delivery };
}

/** The reply's delivery estimate, an instant; it is no longer one once the journey ended. */
function estimate(data: Record<string, unknown>, stage: Stage | undefined): string | null {
  if (stage === 'delivered' || stage === 'returned' || stage === 'exception') return null;
  const value = text(data, 'estimatedDelivery', 40);
  return value ? instant(value) : null;
}

/**
 * The reply of `api.teleship.com/api/tracking/{number}`, the lookup the
 * tracking page makes: the shipment's status, its scans oldest first, and
 * the last-mile carrier once one takes over. An unknown number is HTTP 404
 * with the message "Shipment not found". A shipment must name the number asked.
 */
export function parseTeleship(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTeleshipNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Teleship returned an invalid reply');
  if (typeof payload.trackingNumber !== 'string') throw new SchemaError(PROVIDER, 'Teleship returned a shipment without its number');
  if (normalizeTrackingNumber(payload.trackingNumber).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Teleship answered for another shipment');
  }
  const rows = payload.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Teleship returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Teleship returned an oversized history');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; type: string; at: number }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Teleship returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push({ ...scan, at: Date.parse(scan.event.time!) });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans at the same instant keep the reply's order turned round.
  const ordered = scans.map((scan, index) => ({ ...scan, index }))
    .sort((a, b) => b.at - a.at || b.index - a.index);
  const events = ordered.map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The status over the scans is the page's banner; a scan's own type stages it otherwise.
  // Its `in_transit` also covers a parcel in clearance, which the newest scan can tell.
  const status = teleshipStatusStage(text(payload, 'status', 40));
  const stage = status === 'in_transit' && scanned?.stage === 'customs' ? 'customs' : status ?? (scanned?.stage as Stage | undefined);
  const source = stage === scanned?.stage ? scanned?.stage_source ?? 'carrier_map' : 'carrier_map';
  const delivery = stage === 'delivered' ? ordered.find((scan) => scan.type === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: estimate(payload, stage),
    ...(delivery ? { delivered_at: delivery.event.time! } : {}),
    ...lastMile(payload, number),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * An HTTP 404 reply. Teleship's own message list with "Shipment not found" is
 * a missing shipment, and another message in it an unfinished lookup. Anything
 * else, such as a web server's page, is a moved route.
 */
export function parseTeleshipNotFound(body: string): never {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages) throw new TransportError(PROVIDER, 'Teleship tracking lookup is unavailable', { status: 404 });
  if (messages.some((message) => isRecord(message) && NOT_FOUND.test(clean(message.message, 200)))) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'Teleship did not complete the lookup', { status: 404 });
}
