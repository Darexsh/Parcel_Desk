import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { leopardsStage } from './status.js';

export const PROVIDER = 'Leopards';
// A results page is about 120 kB.
export const LEOPARDS_MAX_BYTES = 1_000_000;
export const LEOPARDS_ORIGIN = 'https://pk.leopardscourier.com';
/** The lookup the tracking box sends the number to. */
export const LEOPARDS_LOOKUP = `${LEOPARDS_ORIGIN}/shipment_tracking-new`;
/** The page that shows the consignment the lookup kept in the session. */
export const LEOPARDS_VIEW = `${LEOPARDS_ORIGIN}/shipment_tracking_view`;

// Two letters and nine or ten digits. The tracker pads nine digits with a leading zero.
const NUMBER = /^([A-Z]{2})(\d{9,10})$/;
const ZONE = 'Asia/Karachi';
// The date and the minute, as "22 September, 2026" and "(09:26)".
const CLOCK_FORMAT = 'd MMMM, yyyy HH:mm';
const DATE = /^\d{1,2} [A-Z][a-z]+, \d{4}$/;
const MINUTE = /^\((\d{2}:\d{2})\)$/;
const CONSIGNMENT = /^Consignment No\.\s*:\s*([A-Z0-9]{1,20})$/;
const NOT_FOUND = /^Your query about "([^"]{0,64})" appeared to be invalid \/ record not found\./;
// A wording that ends with the city it happened in, as "Inter Transfer at KARACHI".
const PLACED = /^(.*\S)\s+(?:at|in)\s+([A-Z][A-Z .'()/-]*[A-Z.)])$/;
// Bot checks and block pages a CDN or firewall could put in place of the site's.
const BLOCKED = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)/i;
const MAX_EVENTS = 300;

/** A Leopards consignment number: two letters and ten digits, nine digits taking a leading zero as the tracker does. */
export function normalizeLeopardsNumber(raw: string): string {
  const match = NUMBER.exec(raw.length <= 64 ? normalizeTrackingNumber(raw) : '');
  if (!match) throw new InvalidInputError(PROVIDER, 'Leopards consignment numbers are two letters and nine or ten digits');
  return `${match[1]}${match[2]!.padStart(10, '0')}`;
}

/** Whether a page is a firewall's or bot check's instead of the site's. */
export function isLeopardsBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/** The site's notice for a number it has no record of, and the number it names. */
function notFoundNotice($: CheerioAPI): string | undefined {
  for (const cell of $('td').toArray()) {
    const named = NOT_FOUND.exec(clean($(cell).text(), 400))?.[1];
    if (named !== undefined) return named;
  }
  return undefined;
}

/**
 * The lookup's reply: `{"success":true}` once the site has kept the
 * consignment in the session, or the tracking page with its notice for a
 * number it has no record of.
 */
export function readLeopardsLookup(body: string, raw: string): void {
  const number = normalizeLeopardsNumber(raw);
  if (/^\s*[{[]/.test(body)) {
    let reply: unknown;
    try { reply = JSON.parse(body); }
    catch (cause) { throw new SchemaError(PROVIDER, 'Leopards returned a reply that is not JSON', { cause }); }
    if (!isRecord(reply) || typeof reply.success !== 'boolean') throw new SchemaError(PROVIDER, 'Leopards returned an invalid lookup reply');
    // The tracking box then opens the page with the site's notice; the reply says nothing about the parcel.
    if (!reply.success) throw new IndeterminateError(PROVIDER, 'Leopards did not complete the lookup');
    return;
  }
  const named = notFoundNotice(load(body));
  if (named === undefined) {
    if (isLeopardsBlockPage(body)) throw new ChallengeError(PROVIDER, 'Leopards answered with a block page');
    throw new SchemaError(PROVIDER, 'Leopards did not answer the lookup');
  }
  if (named !== number) throw new IndeterminateError(PROVIDER, 'Leopards answered for another consignment');
  throw new NotFoundError(PROVIDER);
}

/** A wall clock to the minute, read in Karachi time: Leopards' scans are made in Pakistan, which keeps one offset. */
function clock(date: string, minute: string): { time: string; at: number } {
  const written = `${date} ${MINUTE.exec(minute)?.[1] ?? ''}`;
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = DateTime.fromFormat(written, CLOCK_FORMAT, { zone: 'UTC', locale: 'en-US' });
  // The day may be written with a leading zero.
  if (!DATE.test(date) || !checked.isValid || ![CLOCK_FORMAT, `d${CLOCK_FORMAT}`].some(format => checked.toFormat(format, { locale: 'en-US' }) === written)) {
    throw new SchemaError(PROVIDER, 'Leopards returned an invalid time');
  }
  const zoned = firstOccurrence(DateTime.fromISO(checked.toFormat("yyyy-MM-dd'T'HH:mm"), { zone: ZONE }));
  return { time: zoned.toISO({ suppressMilliseconds: true })!, at: zoned.toMillis() };
}

/** Who signed for the parcel, as the page's "Signed for by" line names them before a dash. */
function signatoryOf($: CheerioAPI): string {
  const label = $('td').filter((_, cell) => clean($(cell).text(), 40) === 'Signed for by :').first();
  return clean(label.next('td').text(), 200).replace(/\s*-(?:\s.*)?$/, '');
}

/**
 * A wording without who took the parcel. A delivery reads "Delivered at
 * LAHORE NAME ~ RELATION": the name is cut when it is the signatory's, else
 * only the wording before the city is kept, or its first word without a city.
 */
function withoutReceiver(wording: string, signatory: string): string {
  const tilde = wording.indexOf('~');
  if (tilde < 0) return wording;
  const head = wording.slice(0, tilde).trim();
  if (signatory && head.toUpperCase().endsWith(` ${signatory.toUpperCase()}`)) {
    const rest = head.slice(0, head.length - signatory.length).trim();
    if (PLACED.test(rest)) return rest;
  }
  const parts = head.split(/\s+(?:at|in)\s+/);
  return parts.length > 1 ? parts[0]!.trim() : head.split(' ')[0]!;
}

interface Scan { event: CarrierEvent; at: number; order: number }

/**
 * The tracking page for the consignment the lookup kept in the session: its
 * number, a delivery box naming who signed, the booking details and its scans
 * newest first, each with a date, a minute and Leopards' wording. The booking
 * details, the signatory and the receiver named in a delivery's wording are
 * not read.
 */
export function parseLeopards(html: string, raw: string): CarrierResult {
  const number = normalizeLeopardsNumber(raw);
  const $ = load(html);
  const named = $('td').map((_, cell) => CONSIGNMENT.exec(clean($(cell).text(), 200))?.[1]).get();
  if (!named.length) {
    // The page without a consignment in the session names none: the session was not kept.
    const notice = notFoundNotice($);
    if (notice !== undefined) throw new IndeterminateError(PROVIDER, 'Leopards did not keep the lookup in the session', { reason: 'session_rejected' });
    if (isLeopardsBlockPage(html)) throw new ChallengeError(PROVIDER, 'Leopards answered with a block page');
    throw new SchemaError(PROVIDER, 'Leopards did not return its tracking page');
  }
  if (named.length !== 1) throw new SchemaError(PROVIDER, 'Leopards returned several consignments');
  if (named[0] !== number) throw new IndeterminateError(PROVIDER, 'Leopards answered for another consignment');

  const items = $('.tracking-list .tracking-item');
  if (items.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Leopards returned an invalid history');
  const signatory = signatoryOf($);
  const seen = new Set<string>();
  const scans: Scan[] = [];
  items.each((order, node) => {
    const item = $(node);
    const date = item.find('.tracking-date');
    const content = item.find('.tracking-content');
    if (date.length !== 1 || content.length !== 1) throw new SchemaError(PROVIDER, 'Leopards returned an invalid scan');
    const minute = clean(date.find('span').text(), 16);
    const when = clock(clean(date.clone().children().remove().end().text(), 40), minute);
    const description = withoutReceiver(clean(content.text(), 300), signatory);
    if (!description) throw new SchemaError(PROVIDER, 'Leopards returned a scan without wording');
    const location = PLACED.exec(description)?.[2];
    const staged = leopardsStage(description);
    const event: CarrierEvent = {
      time: when.time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    const identity = JSON.stringify([event.time, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, at: when.at, order });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans at the same minute keep the page's order, which is newest first.
  const events = scans.sort((a, b) => b.at - a.at || a.order - b.order).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    ...(normalizeTrackingNumber(raw) !== number ? { canonical_tracking_number: number } : {}),
    events,
  };
}
