import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { naqelStage, naqelSummaryStage } from './status.js';

export const PROVIDER = 'Naqel';
// A long history is a page of about 100 kilobytes.
export const NAQEL_MAX_BYTES = 1024 * 1024;
// A waybill of eight or nine digits, or a piece's label: its waybill and a five-digit piece counter.
const NUMBER = /^(?:\d{8,9}|\d{13,14})$/;
const WAYBILL = /^\d{8,9}$/;
const PIECE_DIGITS = 5;
// A day heading and a scan's clock, as "September 09, 2026" and "2:06 PM".
const CLOCK = 'MMMM dd, yyyy h:mm a';
const ETA = 'dd-MM-yyyy';
// The page's own answer for a number it has no shipment for.
const MISSING = 'Sorry Tracking information is not available';
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|_Incapsula_Resource/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// The former page's delivery named who signed for it: "Shipment Delivered – signed by …".
const SIGNATORY = /\s*[–—-]?\s*\bsigned by\b[\s\S]*$/i;
// Scans the system records, such as the waybill's creation, give SYSTEM as their place.
const SYSTEM = 'SYSTEM';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * A Naqel waybill, eight or nine digits, or the label of one of its pieces,
 * thirteen or fourteen digits. Anything else is not a number Naqel issues.
 */
export function normalizeNaqelNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Naqel waybills are eight or nine digits, and piece labels thirteen or fourteen');
  return number;
}

/** A scan's wording without the name of whoever signed for it or a phone number. */
export function naqelWording(text: string): string {
  return clean(text.replace(SIGNATORY, '').replace(PHONE, ' '), 300).replace(/[\s,;:–—-]+$/, '');
}

/** The summary's labelled values; the page gives each once. */
function summary($: CheerioAPI): Map<string, string> {
  const values = new Map<string, string>();
  for (const row of $('tr.trborder').toArray()) {
    const cells = $(row).children('th, td');
    if (!cells.first().is('th')) continue;
    const label = clean(cells.first().text(), 40).toUpperCase();
    if (values.has(label)) throw new SchemaError(PROVIDER, 'Naqel returned more than one shipment');
    values.set(label, clean(cells.eq(1).text(), 120));
  }
  return values;
}

/**
 * A scan's clock: the day heading it is listed under and its own time, a
 * wall clock to the minute. The reply names no zone, and a history spans
 * the Gulf and the countries Naqel collects from, so the clock stays local.
 */
function scanClock(day: string, time: string): string {
  const text = `${day} ${time}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromFormat(text, CLOCK, { locale: 'en', zone: 'UTC' });
  // Only a clock that reads back unchanged is kept.
  if (!parsed.isValid || parsed.toFormat(CLOCK, { locale: 'en' }) !== text) throw new SchemaError(PROVIDER, 'Naqel returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The expected delivery day; a missing or unreadable one is none. */
function estimate(text: string): string | null {
  const parsed = DateTime.fromFormat(text, ETA, { zone: 'UTC' });
  return parsed.isValid && parsed.toFormat(ETA) === text ? parsed.toISODate() : null;
}

/** Whether the shipment the page names is the one asked for: its waybill, or one of its pieces. */
function binds(number: string, shipment: string): boolean {
  return number === shipment || (number.length === shipment.length + PIECE_DIGITS && number.startsWith(shipment));
}

/**
 * The page `www.naqelexpress.com/en/Track/TrackShipment/{number}` answers.
 * Its summary must name the waybill asked, or the waybill of the piece
 * asked. The history lists the scans newest first under day headings, each
 * with its wording, place and time. Destination city, pickup date, payment
 * method and piece count are not kept.
 */
export function parseNaqel(html: string, raw: string): CarrierResult {
  const number = normalizeNaqelNumber(raw);
  const $ = load(html);
  const values = summary($);
  if (!$('textarea[name="waybills"]').length || !values.has('SHIPMENT NO:')) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Naqel answered with a browser check');
    throw new SchemaError(PROVIDER, 'Naqel returned a page without a shipment summary');
  }
  const headings = $('h3').filter((_, heading) => clean($(heading).text()) === 'Shipment Details');
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'Naqel returned a page without its shipment details');
  const body = headings.closest('.card').children('.card-body');
  const days = body.children('.row');

  const shipment = normalizeTrackingNumber(values.get('SHIPMENT NO:') ?? '');
  if (!shipment) {
    if (days.length || clean(body.text()) !== MISSING) throw new SchemaError(PROVIDER, 'Naqel returned an unexpected empty answer');
    throw new NotFoundError(PROVIDER);
  }
  if (!WAYBILL.test(shipment)) throw new SchemaError(PROVIDER, 'Naqel returned an invalid waybill');
  if (!binds(number, shipment)) throw new IndeterminateError(PROVIDER, 'Naqel answered for another shipment');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let rows = 0;
  for (const group of days.toArray()) {
    const headers = $(group).children('.border-dangerTrack');
    const day = clean(headers.find('p').first().text(), 40);
    if (headers.length !== 1 || !day) throw new SchemaError(PROVIDER, 'Naqel returned scans without their day');
    for (const scan of $(group).children('.col-md-12').not('.border-dangerTrack').toArray()) {
      if (++rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'Naqel returned an oversized history');
      const cells = $(scan).children('.row').children('div');
      if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Naqel returned an incomplete scan');
      const description = naqelWording(cells.eq(0).text());
      if (!description) throw new SchemaError(PROVIDER, 'Naqel returned a scan without wording');
      const place = clean(cells.eq(1).text(), 120);
      const location = place.toUpperCase() === SYSTEM ? '' : place;
      const local = scanClock(day, clean(cells.eq(2).text(), 16));
      const key = JSON.stringify([local, description, location]);
      if (seen.has(key)) continue;
      seen.add(key);
      const staged = naqelStage(description);
      events.push({
        local_time: local,
        ...(location ? { location } : {}),
        description,
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      });
    }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const summarized = naqelSummaryStage(values.get('CURRENT STATUS:') ?? '');
  const stage = (summarized ?? scanned?.stage) as Stage | undefined;
  const source = summarized && summarized !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(values.get('EXPECTED DELIVERY:') ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    ...(shipment !== number ? { canonical_tracking_number: shipment } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
