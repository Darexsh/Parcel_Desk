import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { laPosteSenegalStage } from './status.js';

export const PROVIDER = 'La Poste du Sénégal';
// A scan can carry the signature as an image, so a delivered item's reply can be large.
export const LA_POSTE_SENEGAL_MAX_BYTES = 2 * 1024 * 1024;

const MAX_SCANS = 500;
// The scanning office's wall clock, without a zone: "2026-02-05T23:08:19", maybe with a fraction.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const CODE = /^\d{1,4}$/;
const COUNTRY = /^[A-Z]{2}$/;
// An inward scan, in the country the item was sent to: "(Inb)" in English, "(Ent)" in French.
const INWARD = /\((?:inb|ent)\)\s*$/i;
// A run of four or more digits, as an office's postcode is written.
const DIGITS = /(?:^|\s)\d{4,}(?=\s|$)/g;

/**
 * La Poste du Sénégal's tracker looks up UPU S10 item codes in IPS: its own,
 * ending SN, and those of the posts that send mail to Senegal. The code needs
 * a valid check digit. Jotnaci numbers go to another system and are not read.
 */
export function normalizeLaPosteSenegalNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'La Poste du Sénégal tracks S10 item codes');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `La Poste du Sénégal returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional nested object; anything but an object is a changed reply. */
function part(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `La Poste du Sénégal returned an invalid ${key}`);
  return value;
}

/** A named IPS value in the page's French, else in English. */
function named(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = part(row, key);
  return text(value, 'LocalName', maxLength) || text(value, 'Name', maxLength);
}

/** A calendar-checked wall clock to the second; parsing in UTC assigns no offset. */
function wallClock(value: string): string {
  const digits = CLOCK.exec(value)?.[1];
  const parsed = digits ? DateTime.fromISO(digits, { zone: 'UTC' }) : null;
  if (!digits || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== digits || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned an invalid scan time');
  }
  return digits;
}

interface Scan { event: CarrierEvent; clock: string; inward: boolean; country: string; index: number }

/**
 * One IPS scan. `LocalDate` is the scanning office's wall clock; nothing in the
 * reply gives its offset, so it stays local. The page shows the event's French
 * name; the office's name drops a postcode and is followed by its country. The
 * reason an item was kept or not delivered, and what happens next, follow the
 * event. The signatory and the signature are not read.
 */
function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned an invalid scan');
  const type = part(row, 'MailItemEvent');
  const rawCode = type.Code;
  if (rawCode !== null && rawCode !== undefined && typeof rawCode !== 'string' && typeof rawCode !== 'number') {
    throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned an invalid event code');
  }
  const code = rawCode === null || rawCode === undefined ? '' : String(rawCode).trim();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned an invalid event code');
  const english = text(type, 'Name', 200);
  const wording = text(type, 'LocalName', 200) || english;
  if (!wording) throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned a scan without wording');
  const clock = wallClock(text(row, 'LocalDate', 40));
  const country = part(row, 'Country');
  const countryCode = text(country, 'Code', 8);
  const countryName = text(country, 'Name', 80).replace(/\s*\(the\)$/i, '');
  const office = text(row, 'Location', 120).replace(DIGITS, ' ').replace(/\s+/g, ' ').trim();
  // The office, then its country, which a scan abroad can name alone.
  const location = office.toLowerCase() === countryName.toLowerCase() ? countryName : [office, countryName].filter(Boolean).join(', ');
  const details = ['RetentionReason', 'NonDeliveryReason', 'NonDeliveryMeasure'].map(key => named(row, key, 120)).filter(Boolean);
  const description = details.length ? `${wording}: ${details.join('; ')}` : wording;
  // An event number the map does not know is read by the shared wording rules in English, which they know best.
  const staged = laPosteSenegalStage(code || null, english || description);
  const event: CarrierEvent = {
    local_time: clock,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, clock, inward: INWARD.test(english || wording), country: COUNTRY.test(countryCode) ? countryCode : '', index };
}

/**
 * The reply of the home page's `GET /wp-json/lp/v1/track?code={number}`: IPS's
 * `MailItemId`, `MatchFound` and the item's `Events`, oldest first. The home page
 * reports an item without a match as not found ("introuvable"). It reports the
 * site's own `not_found` flag the same way, but that flag has not been seen and
 * could stand for a lookup that failed, so it is inconclusive.
 */
export function parseLaPosteSenegal(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeLaPosteSenegalNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned an invalid reply');
  if (payload.not_found === true) {
    throw new IndeterminateError(PROVIDER, 'La Poste du Sénégal’s tracker shows nothing for the code', { reason: 'portal_not_found' });
  }
  if (typeof payload.MailItemId !== 'string' || typeof payload.MatchFound !== 'boolean') {
    throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned an invalid reply');
  }
  if (normalizeTrackingNumber(clean(payload.MailItemId, 64)) !== number) throw new SchemaError(PROVIDER, 'La Poste du Sénégal answered for a different item');
  const rows = payload.Events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned an item with invalid scans');
  if (!payload.MatchFound) {
    if (rows.length) throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned scans without a match');
    throw new NotFoundError(PROVIDER);
  }
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = scanOf(row, index);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans at the same clock keep the later one in the reply first.
  scans.sort((left, right) => right.clock.localeCompare(left.clock) || right.index - left.index);
  const events = scans.map(({ event }) => event);

  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  // An inward scan is recorded in the country the item was sent to.
  const destination = scans.find(scan => scan.inward && scan.country)?.country;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
