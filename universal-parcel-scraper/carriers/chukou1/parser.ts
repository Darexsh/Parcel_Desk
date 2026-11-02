import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, escapeRegExp } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { chukou1Stage, chukou1SummaryStage } from './status.js';

export const PROVIDER = 'Chukou1';
// A delivered parcel's reply embeds its proof of delivery, a PDF of photos, in
// base64; one with four photos is under a megabyte.
export const CHUKOU1_MAX_BYTES = 16 * 1024 * 1024;
// A processing number: three letters, the order's date as yymmdd, a three- or
// four-character customer code with a letter in it, and a six- or seven-digit serial.
const NUMBER = /^[A-Z]{3}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?=[A-Z0-9]{0,3}[A-Z])[A-Z0-9]{3,4}\d{6,7}$/;
const CLOCK = /^[A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2} [AP]M$/;
const MAX_SHIPMENTS = 10;
const MAX_FEEDS = 10;
const MAX_ROWS = 300;

/** A Chukou1 processing number in upper case, as the tracker reads it; anything else is not one Chukou1 issues. */
export function normalizeChukou1Number(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Chukou1 processing numbers are three letters, a date, a customer code and a serial');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Chukou1 returned an invalid ${key}`);
  return clean(value, maxLength);
}

function list(row: Record<string, unknown>, key: string, max: number): unknown[] {
  const value = row[key] ?? [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, `Chukou1 returned an invalid ${key}`);
  if (value.length > max) throw new SchemaError(PROVIDER, 'Chukou1 returned an oversized history');
  return value;
}

/**
 * A scan's `MMM dd yyyy hh:mm AM`, the scanning place's wall clock. The reply
 * names no zone and one history runs from China's clock to the destination's,
 * so it stays a wall clock.
 */
function scanClock(row: Record<string, unknown>): string {
  const raw = text(row, 'dateTimeString', 32);
  // Parsing in UTC checks the calendar only; the wall clock keeps no offset.
  const parsed = CLOCK.test(raw) ? DateTime.fromFormat(raw, 'LLL dd yyyy hh:mm a', { zone: 'UTC', locale: 'en-US' }) : null;
  if (!parsed?.isValid || parsed.toFormat('LLL dd yyyy hh:mm a', { locale: 'en-US' }) !== raw) {
    throw new SchemaError(PROVIDER, 'Chukou1 returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who took or delivered the parcel, after a delivery scan's wording.
const RECEIVER = /\s*[,，;；:：.]?\s*(?:\b(?:signed for by|signed by|received by)\b|签收人是?|投递员|派件员|快递员|收件人)[\s\S]*$/i;
const HANDOVER = /\bdelivered\b|\bsigned\b|签收|妥投|投递/i;
// A part that is only a postcode or a site code: "00001", "00001-0000", "00000033".
const CODE_PART = /^\d{4,}(?:-\d{4})?$/;

/** The destination postcode as scans write it; a ZIP+4 code also as its five digits. */
function postcodePattern(postcode: string): RegExp {
  const zip = /^(\d{5})-\d{4}$/.exec(postcode);
  const code = zip ? `${zip[1]}(?:-\\d{4})?` : escapeRegExp(postcode).replace(/\\? /g, '\\s*');
  return new RegExp(`(?<![A-Z0-9])${code}(?![A-Z0-9])`, 'gi');
}

/**
 * A scan's text as its parts: the comma-separated place and wording, without
 * the destination postcode, other bare postcodes and site codes, phone
 * numbers, a delivery's receiver, or a part repeated ("Springfield,ZZ,00001,
 * Springfield, ZZ, 00001, Delivered" is Springfield, ZZ, Delivered).
 */
function scanParts(raw: string, postcode: string): string[] {
  let value = raw.replace(PHONE, '');
  if (postcode) value = value.replace(postcodePattern(postcode), '');
  if (HANDOVER.test(value)) value = value.replace(RECEIVER, '');
  const parts = value.split(',').map((part) => clean(part.replace(/\s+([.;:])/g, '$1')).replace(/^[\s.;:]+/, ''))
    .filter((part) => part && !CODE_PART.test(part));
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = part.toLocaleLowerCase('en-US');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface Scan { local: string; event: CarrierEvent; tail: string }

/**
 * One scan. Chukou1's own scans write the place, then the wording ("SHENZHEN,
 * China, Item received by Logistics Centre"). A partner's scan is kept whole,
 * since its wording can itself hold commas.
 */
function projectScan(row: unknown, postcode: string, own: boolean): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Chukou1 returned an invalid scan');
  const local = scanClock(row);
  const raw = text(row, 'description', 1000);
  if (!raw) throw new SchemaError(PROVIDER, 'Chukou1 returned a scan without wording');
  const parts = scanParts(raw, postcode);
  if (!parts.length) return null;
  const whole = parts.join(', ');
  const split = own && parts.length > 1;
  const description = clean(split ? parts.at(-1)! : whole, 300);
  const location = split ? clean(parts.slice(0, -1).join(', '), 120) : '';
  const staged = chukou1Stage(description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { local, event, tail: parts.at(-1)!.toLocaleLowerCase('en-US') };
}

/**
 * The destination carrier and its number, when the reply names a carrier the
 * catalog tracks, by its service or a partner feed, and the number is one of
 * that carrier's own.
 */
function handoff(shipment: Record<string, unknown>, number: string, feeds: string[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const compact = normalizeTrackingNumber(text(shipment, 'trackingNumber', 64));
  const reference = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return {};
  const candidates = detectCarrierMatch(reference).candidates as string[];
  for (const name of [text(shipment, 'trackingServiceDiscription', 80), ...feeds]) {
    const partner = name ? carrierIdFromPartner(name) : undefined;
    if (partner && partner !== 'chukou1' && candidates.includes(partner)) {
      return { delivery_carrier: partner, delivery_tracking_number: reference };
    }
  }
  return {};
}

/**
 * The reply of the EC-FirstClass tracking page's `trackings` lookup: a list
 * of the shipments asked, each with its status, Chukou1's own scans
 * (`firstLegTrackingDetails`) and the scans of the carriers it handed the
 * parcel to, one feed each, all newest first. A number it does not know comes
 * back with the status `NotFound`. The shipment must be the number asked. Its
 * proof of delivery, destination postcode and origin supplier are not kept.
 */
export function parseChukou1(payload: unknown, raw: string): CarrierResult {
  const number = normalizeChukou1Number(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Chukou1 returned a reply without its result list');
  if (!payload.length) throw new SchemaError(PROVIDER, 'Chukou1 returned an empty result');
  if (payload.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'Chukou1 returned an oversized result');
  if (!payload.every((item) => isRecord(item) && typeof item.orderNumber === 'string' && typeof item.orderStatus === 'string')) {
    throw new SchemaError(PROVIDER, 'Chukou1 returned a shipment without its number or status');
  }
  const shipment = (payload as Record<string, unknown>[]).find((item) => normalizeTrackingNumber(clean(item.orderNumber, 64)) === number);
  if (!shipment) throw new IndeterminateError(PROVIDER, 'Chukou1 answered for another shipment');
  const status = clean(shipment.orderStatus, 32);
  if (status === 'NotFound') throw new NotFoundError(PROVIDER);

  const postcode = text(shipment, 'destinctPostCode', 16);
  const feeds = list(shipment, 'supplierTrackingDetails', MAX_FEEDS).map((feed) => {
    if (!isRecord(feed)) throw new SchemaError(PROVIDER, 'Chukou1 returned an invalid partner feed');
    return { name: text(feed, 'carrierCode', 80), rows: list(feed, 'trackingDetails', MAX_ROWS) };
  });
  const scans: Scan[] = [];
  // Two feeds of one partner repeat the same scans with their places written
  // differently; a scan another feed gave at the same minute with the same
  // wording is left out. The partners' scans come first, so a scan of theirs
  // at the same minute as Chukou1's is the newer one.
  const given = new Map<string, number>();
  feeds.forEach((feed, index) => {
    for (const row of feed.rows) {
      const scan = projectScan(row, postcode, false);
      if (!scan) continue;
      const key = JSON.stringify([scan.local, scan.tail]);
      const owner = given.get(key);
      if (owner !== undefined && owner !== index) continue;
      given.set(key, index);
      scans.push(scan);
    }
  });
  const seen = new Set<string>();
  for (const row of list(shipment, 'firstLegTrackingDetails', MAX_ROWS)) {
    const scan = projectScan(row, postcode, true);
    if (scan) scans.push(scan);
  }
  const events = scans.filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.location, event.description]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a.local < b.local ? 1 : a.local > b.local ? -1 : 0)).map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // Newest first by their wall clocks, which are each place's own.
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const summary = chukou1SummaryStage(status);
  // The page's Delivered stands unless a later scan says the parcel went back.
  const delivered = summary === 'delivered' && current?.stage !== 'delivered' && current?.stage !== 'returned';
  const stage = (delivered ? summary : (current?.stage as Stage | undefined) ?? summary);
  const source = delivered || !current ? 'carrier_map' : current.stage_source;
  const country = countryCode(text(shipment, 'destinctCountry', 80));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...handoff(shipment, number, feeds.map((feed) => feed.name)),
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
