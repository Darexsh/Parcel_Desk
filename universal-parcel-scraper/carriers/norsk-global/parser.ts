import { DateTime } from 'luxon';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { norskGlobalScanStage, norskGlobalSummaryStage } from './status.js';

export const PROVIDER = 'Norsk Global';
// A shipment with a long history is a few kilobytes.
export const NORSK_GLOBAL_MAX_BYTES = 512 * 1024;
// Letters and digits with at least one digit. Ten characters or more, so a
// short reference that could be part of someone else's is never sent.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{10,40}$/;
// A scan's clock: a date, a time to the minute or second, a fraction, and an offset when it has one.
const STAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(?:\.\d{1,7})?(Z|[+-]\d{2}:?\d{2})?$/i;
// The page drops the first nineteen characters of each message, a copy of the
// scan's clock. Only a clock is taken off here, in case a message comes without one.
const CLOCK_PREFIX = /^\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})[ T]\d{1,2}:\d{2}(?::\d{2})?\s*[-–:]?\s*/;
// A delivery, whose wording can name who took the parcel.
const HANDOVER = /\b(?:deliver(?:ed|y)|signed|POD)\b/i;
// Who signed for or took the parcel, after a delivery's wording.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:signed(?:\s+for)?(?:\s+by)?|received\s+by|collected\s+by|left\s+with)\b[\s\S]*$/i;
// A sentence with an e-mail address, such as the depot the page asks a held parcel to be sent to.
const EMAIL_SENTENCE = /[^.!?]*?\S+@[\w-]+(?:\.[\w-]+)+[^.!?]*[.!?]?/g;
// A run of nine or more digits written as a phone number; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// A partner number the page links to is longer than nine characters.
const PARTNER_NUMBER = /^[A-Z0-9]{10,40}$/;
/**
 * Partners by the words the page's own link builder looks for in the
 * partner's name, in its order, where the catalog does not know the whole
 * name. The page sends DHL to DHL Express, Pitney Bowes to USPS and UK Mail to
 * DHL Parcel UK; Landmark Global relays to its own partners.
 */
const PARTNERS: readonly (readonly [RegExp, string])[] = [
  [/\bDHL\b/i, 'dhl-express'],
  [/\b(?:USPS|PITNEY)\b/i, 'usps'],
  [/\bLANDMARK\b/i, 'landmark-global'],
  [/\bYODEL\b/i, 'inpost'],
  [/\bDPD\b/i, 'dpd-uk'],
  [/\bASENDIA\b/i, 'asendia'],
  [/\bUK MAIL\b/i, 'dhl-ecommerce-uk'],
  [/\bARAMEX\b/i, 'aramex'],
  [/\bEVRI\b/i, 'evri-uk'],
  [/\bDAI POST\b/i, 'dai-post'],
  [/\bROYAL MAIL\b/i, 'royal-mail'],
  [/\bUPS\b/i, 'ups'],
  [/\bSKYNET\b/i, 'skynet-worldwide'],
];
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A reference for Norsk's tracker, whole and in capitals; anything else is not one it is asked for. */
export function normalizeNorskGlobalNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Norsk Global references are ten or more letters and digits');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `Norsk Global returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A reference as the reply writes it, compared as the number asked is. */
function reference(row: Record<string, unknown>, key: string): string {
  return normalizeTrackingNumber(text(row, key, 64));
}

/**
 * A scan's clock. One with an offset is an instant. One without is the wall
 * clock of wherever the scan was made, which can be a partner's abroad, so it
 * stays local. `key` orders scans by their written clock.
 */
function scanClock(raw: string): { clock: Pick<CarrierEvent, 'time'> & { local_time?: string }; key: string } {
  const match = STAMP.exec(raw);
  const local = match ? `${match[1]}T${match[2]}${match[3] ?? ':00'}` : '';
  // Parsing in UTC checks the calendar digits only; luxon rolls 24:00 over, so the clock must read back unchanged.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, 'Norsk Global returned an invalid scan time');
  }
  if (!match[4]) return { clock: { local_time: local }, key: local };
  const instant = explicitOffsetTime(`${local}${match[4]}`);
  if (!instant) throw new SchemaError(PROVIDER, 'Norsk Global returned an invalid scan time');
  return { clock: { time: instant.iso }, key: local };
}

/**
 * A scan's message without the clock it starts with, a sentence with an
 * e-mail address or a phone number. A delivery loses the clause naming who
 * signed for it, and is "Delivered" when nothing else is left.
 */
export function norskGlobalWording(raw: string): string {
  const line = clean(raw.replace(CLOCK_PREFIX, '').replace(EMAIL_SENTENCE, ' ').replace(PHONE, ''));
  const handover = HANDOVER.test(line);
  const own = clean((handover ? line.replace(RECEIVER, '') : line).replace(/\s+([,;:.])/g, '$1'))
    .replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  return own || (handover ? 'Delivered' : '');
}

interface Scan { key: string; order: string; event: CarrierEvent }

function projectScan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Norsk Global returned an invalid scan');
  const { clock, key } = scanClock(text(row, 'timeStamp', 40));
  const description = norskGlobalWording(text(row, 'message', 500));
  if (!description) throw new SchemaError(PROVIDER, 'Norsk Global returned a scan without wording');
  // The place of the scan: a depot, a town or a country.
  const location = text(row, 'location', 120);
  const staged = norskGlobalScanStage(description);
  const event: CarrierEvent = {
    ...clock,
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([key, description, location]), order: key, event };
}

/** The partner a shipment was handed to: one the catalog knows by name, or by the words the page's links key on. */
function deliveryPartner(agent: string): string | undefined {
  if (!agent) return undefined;
  const named = carrierIdFromName(agent);
  if (named && named !== 'norsk-global') return named;
  return PARTNERS.find(([pattern]) => pattern.test(agent))?.[1];
}

/** The partner's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function partnerNumber(raw: string, number: string): string | undefined {
  const code = USPS_ROUTING_BARCODE.test(raw) ? uspsPackageIdentifier(raw) ?? '' : raw;
  return PARTNER_NUMBER.test(code) && code !== number ? code : undefined;
}

/** The destination country: its ISO code when the reply gives one, else its name. */
function destination(shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const place = shipment.destination;
  if (place === null || place === undefined || place === '') return {};
  if (!isRecord(place)) throw new SchemaError(PROVIDER, 'Norsk Global returned an invalid destination');
  const iso = text(place, 'isoName', 8).toUpperCase();
  const name = text(place, 'country', 80);
  const code = /^[A-Z]{2}$/.test(iso) ? iso : name ? countryCode(name) : null;
  return code ? { destination_country: code } : name ? { destination_country_name: name } : {};
}

/**
 * The reply of `POST /api/public/{token}/tracking` on Norsk's portal: an
 * array of the shipments that carry the reference asked, empty for one it
 * does not know. A shipment counts only when its own `hawb` is the number
 * asked. The recipient's name and postcode and the proof of delivery's
 * signatory are never read.
 */
export function parseNorskGlobal(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNorskGlobalNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Norsk Global returned an invalid reply');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'Norsk Global returned too many shipments');
  if (!payload.every(isRecord)) throw new SchemaError(PROVIDER, 'Norsk Global returned an invalid shipment');
  const shipments = payload.filter((shipment) => reference(shipment, 'hawb') === number);
  if (!shipments.length) {
    // The tracker also finds a shipment by its partner's number or a sender's
    // reference. That number is not Norsk's own, so its answer stays open.
    if (payload.some((shipment) => reference(shipment, 'trackingNumber') === number)) {
      throw new IndeterminateError(PROVIDER, 'Norsk Global found the shipment by its partner\'s number');
    }
    throw new IndeterminateError(PROVIDER, 'Norsk Global answered for another reference');
  }
  if (new Set(shipments.map((shipment) => JSON.stringify(shipment))).size > 1) {
    throw new SchemaError(PROVIDER, 'Norsk Global returned several shipments for one reference');
  }
  const shipment = shipments[0]!;
  const rows = shipment.narrative ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Norsk Global returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Norsk Global returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const scan = projectScan(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  if (scans[0]!.order < scans.at(-1)!.order) scans.reverse();
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const summary = norskGlobalSummaryStage(text(shipment, 'statusDescription', 120));
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const partner = deliveryPartner(text(shipment, 'agentName', 80));
  const delivery = partnerNumber(reference(shipment, 'trackingNumber'), number);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(delivery ? { delivery_tracking_number: delivery } : {}),
    ...destination(shipment),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
