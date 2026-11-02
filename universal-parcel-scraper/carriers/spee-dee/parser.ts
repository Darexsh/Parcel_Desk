import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/index.js';
import { speeDeeActivity, speeDeeStatus } from './status.js';

const PROVIDER = 'Spee-Dee';
const NOT_FOUND = 'No packages were found matching the barcode supplied.';
const NUMBER_LABEL = 'Tracking Number:';
const PROGRESS_HEADERS = 'Date / Time|Location|Activity';
// Only these summary rows are read; "Signed by:" and "Delivered to:" never are.
const SUMMARY_LABELS = new Set(['Status:', 'Delivered on:', NUMBER_LABEL]);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const DAY_MS = 86_400_000;
const CLOCK = /^(\d{2}\/\d{2}\/\d{4}) (0?[1-9]|1[0-2]):([0-5]\d)(?::([0-5]\d))? ([AP]M)$/i;
const CHALLENGE_TITLE = /just a moment|attention required|access denied|request rejected|verify.*human|captcha/i;
const CHALLENGE_WIDGETS = '.g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form';

/** A Spee-Dee barcode: SP and 16 or 18 digits. */
export function normalizeSpeeDeeNumber(raw: string): string {
  if (raw.length > 64) throw new InvalidInputError(PROVIDER, 'Spee-Dee tracking number is too long');
  const number = normalizeTrackingNumber(raw);
  if (/^SP(?:\d{16}|\d{18})$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Spee-Dee requires an SP barcode with 16 or 18 digits');
}

/** A page clock ("MM/DD/YYYY hh:mm[:ss] am") as a wall time; the page gives scans no offset. */
function wallClock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const [, day, hour, minute, second = '00', meridiem] = match;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(`${day} ${hour}:${minute}:${second} ${meridiem!.toUpperCase()}`, 'MM/dd/yyyy h:mm:ss a',
    { zone: 'UTC', locale: 'en-US' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

interface Scan { localTime: string; description: string; location: string }

/** A wall clock as a number, for comparing two clocks of the same page only. */
function wallMs(scan: Scan): number {
  return DateTime.fromISO(scan.localTime, { zone: 'UTC' }).toMillis();
}

/** The summary rows this parser reads, from the one table that holds the tracking number row. */
function summaryFields($: CheerioAPI): Map<string, string> {
  const tables = $('table').filter((_, table) => $(table).find('tr').toArray().some((row) => {
    const cells = $(row).children('td');
    return cells.length === 2 && clean(cells.eq(0).children('strong').text(), 64) === NUMBER_LABEL;
  }));
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Spee-Dee page does not identify one package');
  const fields = new Map<string, string>();
  for (const row of tables.find('tr').toArray()) {
    const cells = $(row).children('td');
    const label = cells.length === 2 ? clean(cells.eq(0).children('strong').text(), 64) : '';
    if (!SUMMARY_LABELS.has(label)) continue;
    if (fields.has(label)) throw new SchemaError(PROVIDER, 'Spee-Dee summary repeats a field');
    fields.set(label, clean(cells.eq(1).text(), 64));
  }
  return fields;
}

/**
 * Spee-Dee's package progress page. The page must name the requested barcode
 * in its summary and above the progress table, and nowhere name another.
 * Barcodes are reused: only the rows since the previous delivery are kept.
 * Signer, delivery address and the HTML comments are never read.
 */
export function parseSpeeDee(html: string, raw: string): CarrierResult {
  const number = normalizeSpeeDeeNumber(raw);
  // Comments have held print_r dumps with the recipient's address, the signer
  // and device data; none of it is read.
  const page = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const $ = load(page);
  $('script, style, noscript, template').remove();
  // The whole text: a barcode past a cut would escape the identity check below.
  const text = clean($.root().text(), page.length);
  if (text === NOT_FOUND) throw new NotFoundError(PROVIDER);
  const labels = $('strong').filter((_, strong) => clean($(strong).text(), 64) === NUMBER_LABEL);
  // A challenge shows in the title or as a widget, and only on a page without
  // the package: a bot-detection script next to the tables hides nothing.
  if (!labels.length && (CHALLENGE_TITLE.test(clean($('title').text(), 200)) || $(CHALLENGE_WIDGETS).length)) {
    throw new ChallengeError(PROVIDER, 'Spee-Dee returned a browser challenge');
  }
  if (text.includes(NOT_FOUND)) throw new SchemaError(PROVIDER, 'Spee-Dee page mixes package data with its not-found answer');

  const summary = summaryFields($);
  const heading = $('p').filter((_, paragraph) => clean($(paragraph).children('strong').first().text(), 64) === NUMBER_LABEL);
  const named = text.match(/(?<![A-Z0-9])SP\d{12,}(?!\d)/gi) ?? [];
  if (summary.get(NUMBER_LABEL) !== number || heading.length !== 1
    || clean(heading.text(), 128) !== `${NUMBER_LABEL} ${number}`
    || labels.length !== 2
    || named.some((value) => value.toUpperCase() !== number)) {
    throw new SchemaError(PROVIDER, 'Spee-Dee page does not identify the requested package');
  }
  const status = summary.get('Status:');
  if (!status) throw new SchemaError(PROVIDER, 'Spee-Dee summary has no status');

  const tables = $('table').filter((_, table) => $(table).find('thead th').map((__, th) => clean($(th).text(), 32)).get()
    .join('|') === PROGRESS_HEADERS);
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Spee-Dee package progress is missing');
  const rows = tables.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Spee-Dee returned too many progress rows');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cells = $(row).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Spee-Dee package progress row changed');
    const localTime = wallClock(clean(cells.eq(0).text(), 64));
    const description = speeDeeActivity(clean(cells.eq(2).text(), 200));
    if (!localTime || !description) throw new SchemaError(PROVIDER, 'Spee-Dee progress row has no valid time or activity');
    const scan = { localTime, description, location: clean(cells.eq(1).text(), 100) };
    // A repeated row is one scan; a repeated delivery must not end the shipment below.
    const key = JSON.stringify([scan.localTime, scan.description, scan.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'Spee-Dee returned no package progress');

  // Rows are newest first. A delivery below a later scan, or a day or more
  // away from the delivery row above it, closes an earlier shipment under the
  // same barcode: it and every older row are dropped. Back-to-back delivery
  // rows within a day are one delivery scanned twice.
  const delivered = (scan: Scan) => speeDeeStatus(scan.description)?.stage === 'delivered';
  const previous = scans.findIndex((scan, index) => index > 0 && delivered(scan)
    && !(delivered(scans[index - 1]!) && Math.abs(wallMs(scans[index - 1]!) - wallMs(scan)) < DAY_MS));
  const current = previous < 0 ? scans : scans.slice(0, previous);
  const newest = current[0]!;
  const latest = speeDeeStatus(newest.description);
  // The summary describes one shipment: the newest delivery, or for a barcode
  // whose newest scans are not a delivery, an earlier one. Anything else can
  // be a newer shipment without scans, or a delivery the table lacks.
  const deliveredOn = summary.get('Delivered on:');
  const summaryDelivery = deliveredOn === undefined ? undefined : wallClock(deliveredOn)?.slice(0, 16) ?? null;
  const newestMinute = newest.localTime.slice(0, 16);
  if (latest?.stage === 'delivered'
    ? !/^delivered$/i.test(status) || (summaryDelivery !== undefined && summaryDelivery !== newestMinute)
    : /^delivered$/i.test(status) && !(summaryDelivery && summaryDelivery < newestMinute)) {
    throw new IndeterminateError(PROVIDER, 'Spee-Dee summary does not match its newest scans');
  }

  const events = current.slice(0, MAX_EVENTS).map((scan): CarrierEvent => {
    const mapped = speeDeeStatus(scan.description);
    return { local_time: scan.localTime, description: scan.description, ...(scan.location ? { location: scan.location } : {}),
      ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) };
  });
  return {
    status: latest?.status ?? 'unknown',
    ...(latest ? { current_stage: latest.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.localTime,
    expected_delivery: null,
    events,
  };
}
