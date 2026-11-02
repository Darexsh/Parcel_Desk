import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { taxydemaStage } from './status.js';

export const PROVIDER = 'Taxydema';
// A long history is a few kilobytes.
export const TAXYDEMA_MAX_BYTES = 512 * 1024;
// Every station is in Greece.
const ZONE = 'Europe/Athens';
const WAYBILL = /^\d{12}$/;
// The reply's only wording for a number it does not know.
export const TAXYDEMA_ABSENT = 'Δεν βρέθηκε αποστολή με τα κριτήρια επιλογής σας.';
// A row: the station's date and wall clock, the scan's wording, then the station.
const ROW = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d) - ([\s\S]+)$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/;
const MAX_ROWS = 300;

/** A Taxydema waybill, twelve digits; anything else is not one it issues. */
export function normalizeTaxydemaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!WAYBILL.test(number)) throw new InvalidInputError(PROVIDER, 'Taxydema waybills are twelve digits');
  return number;
}

// A message to the recipient: where it went, a phone or an email address, then its subject.
const CONTACT = /\s*ΣΤΟ\s+(?:ΤΗΛΕΦΩΝΟ|EMAIL)\s*:[\s\S]*$/iu;
// The rest of a delivery's wording names who took the parcel, then the delivery's date and time.
const DELIVERY = /^((?:Η αποστολή )?παραδόθηκε στον παραλήπτη)(?:[\s:.,][\s\S]*)?$/iu;
// The notice number of a failed delivery, and all after it.
const NOTICE_NUMBER = /\s*,?\s*Αρ\.?\s*Ειδοποίησης\s*:[\s\S]*$/iu;
// A link, with or without its scheme, and a template's placeholder for one.
const LINK = /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\d.])(?:[a-z\d-]+\.)+[a-z]{2,}\/\S*|\{\{[^}]*\}\}/giu;
// The masked phone a message went to, as "[*******12345]".
const MASKED = /\[\*+\d*\]/g;
// A Greek phone number: ten digits from 2 (fixed) or 6 (mobile), maybe after +30.
const PHONE = /(?<![\dA-Z])(?:\+?30)?[26]\d{9}(?![\dA-Z])/g;
const EMAIL = /\S+@\S+\.\S+/g;

/**
 * A scan's wording without what it says about the recipient. A message keeps
 * only that it was sent, without where it went and its subject, which carries
 * links to the parcel's delivery options; a delivery loses who took the parcel;
 * a failed delivery loses its notice number; every line loses links, phone
 * numbers and email addresses.
 */
export function taxydemaWording(raw: string): string {
  const text = clean(raw, 1_000).replace(CONTACT, '').replace(DELIVERY, '$1').replace(NOTICE_NUMBER, '');
  return clean(text.replace(LINK, '').replace(MASKED, '').replace(EMAIL, '').replace(PHONE, '').replace(/\s+([,.:;)])/g, '$1'), 300)
    .replace(/^[\s,.:;(-]+|[\s,:;(-]+$/g, '');
}

/** A station's name; the head office, which sends the messages, is no place the parcel is. */
function placeOf(raw: string): string {
  const place = clean(raw, 120);
  return /^ΔΙΟΙΚΗΣΗ$/iu.test(place) || !/\p{L}/u.test(place) ? '' : place;
}

/** A station's wall clock to the second, in Greece, as an instant. */
function instantOf(date: string, time: string): { iso: string; timestamp: number } {
  const parsed = isoTime(`${date}T${time}`, ZONE);
  if (!parsed) throw new SchemaError(PROVIDER, 'Taxydema returned an invalid scan time');
  return parsed;
}

interface Scan {
  readonly index: number;
  readonly timestamp: number;
  readonly event: CarrierEvent;
}

/** One row of `verticalStatus`: "2026-03-14 09:12:00 - {wording}  - {station}". */
function scanOf(row: unknown, index: number): Scan {
  if (typeof row !== 'string') throw new SchemaError(PROVIDER, 'Taxydema returned an invalid scan');
  const match = ROW.exec(clean(row, 4_000));
  if (!match) throw new SchemaError(PROVIDER, 'Taxydema returned a scan without its time');
  const { iso, timestamp } = instantOf(match[1]!, match[2]!);
  const rest = match[3]!;
  // The station follows the last separator; a wording may hold a hyphen of its
  // own. A message's subject is free text, so a message names no station.
  const separator = CONTACT.test(rest) ? -1 : rest.lastIndexOf(' - ');
  const description = taxydemaWording(separator < 0 ? rest : rest.slice(0, separator));
  if (!description) throw new SchemaError(PROVIDER, 'Taxydema returned a scan without wording');
  const location = separator < 0 ? '' : placeOf(rest.slice(separator + 3));
  const stage = taxydemaStage(description);
  return { index, timestamp, event: {
    time: iso,
    ...(location ? { location } : {}),
    description,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/** An optional date-and-time field of the progress rail. */
function railClock(rail: Record<string, unknown>, key: string): string | undefined {
  const value = rail[key];
  if (value === undefined || value === null || value === '') return undefined;
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) throw new SchemaError(PROVIDER, `Taxydema returned an invalid ${key}`);
  return instantOf(match[1]!, match[2]!).iso;
}

/**
 * The progress rail's last step, which settles a delivery or a return: the
 * page heads it "ΠΑΡΑΔΟΣΗ", or "ΕΠΙΣΤΡΟΦΗ ΣΤΟΝ ΑΠΟΣΤΟΛΕΑ" for a parcel going
 * back to its sender, and dates it once the parcel got there.
 */
function settled(rail: unknown): { stage: Stage; at: string } | undefined {
  if (rail === undefined || rail === null) return undefined;
  if (!isRecord(rail)) throw new SchemaError(PROVIDER, 'Taxydema returned an invalid progress rail');
  const at = railClock(rail, 'delivered');
  if (!at) return undefined;
  return { stage: rail.returnToSender === true ? 'returned' : 'delivered', at };
}

/** The 404 reply's error, which names no number. */
export function isTaxydemaAbsence(payload: unknown): boolean {
  return isRecord(payload) && typeof payload.error === 'string' && clean(payload.error, 200) === TAXYDEMA_ABSENT;
}

/**
 * The HTTP 200 reply of the tracking page's `/api/track-request/{number}`:
 * the waybill as `tt_code`, the progress rail and the scans, newest first,
 * each a line of text. A shipment must name the number asked. A missing parcel
 * is HTTP 404 instead, read by `isTaxydemaAbsence`.
 */
export function parseTaxydema(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTaxydemaNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.result)) throw new SchemaError(PROVIDER, 'Taxydema returned an invalid envelope');
  const result = payload.result;
  const waybill = typeof result.tt_code === 'string' ? result.tt_code.trim() : null;
  if (!waybill) throw new SchemaError(PROVIDER, 'Taxydema returned a shipment without its waybill');
  if (waybill.length > 64 || normalizeTrackingNumber(waybill) !== number) {
    throw new IndeterminateError(PROVIDER, 'Taxydema answered for another shipment');
  }
  const rows = result.verticalStatus ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Taxydema returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Taxydema returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const [index, row] of rows.entries()) {
    const scan = scanOf(row, index);
    const identity = JSON.stringify([scan.event.time, scan.event.description, scan.event.location ?? '']);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }
  const settlement = settled(result.horizontalInfo);
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; rows of one second keep the reply's order.
  const events = scans.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index).map((scan) => scan.event);

  const newest = events[0]!;
  const stage = (settlement?.stage ?? events.find((event) => event.stage)?.stage) as Stage | undefined;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time ?? settlement?.at : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery } : {}),
    events,
  };
}
