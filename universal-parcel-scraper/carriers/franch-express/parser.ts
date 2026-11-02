import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { franchExpressStage } from './status.js';

export const PROVIDER = 'Franch Express';
/** The AWB History page's lookup, which turns the form's query into the token the page opens with. */
export const FRANCH_EXPRESS_LOOKUP = 'https://www.erpfranchexpress.com/inc/cis_ajax/jquery_encryption.php';
/** The AWB History page, opened with the lookup's token as `data`. */
export const FRANCH_EXPRESS_RESULT = 'https://www.erpfranchexpress.com/api-tracking.php';
// The page is about six kilobytes, and each scan adds less than one.
export const FRANCH_EXPRESS_MAX_BYTES = 512 * 1024;

// Eleven digits: the page's AWB field takes digits only, eleven at most.
const NUMBER = /^\d{11}$/;
// The lookup's token, URL-safe base64; the page appends it to its address as it comes.
const TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
// Every scan is at a Franch Express branch or hub in India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
// A scan's day and clock, as "Sep 25, 2025 07:24 PM".
const SCAN_CLOCK = /^[A-Z][a-z]{2} \d{2}, \d{4} \d{2}:\d{2} [AP]M$/;
const RESULT = /^Status of AWB No\.\s*(\S{1,64})$/;
// The page's answer for a number it has no consignment for. It does not name the number.
const NOT_FOUND = /^Consignment Number \/ Reference Number not found\b/i;
// The page's answer when it read no number from its token.
const NO_LOOKUP = /^Please enter AWB number\b/i;
// Bot checks and firewall pages a CDN or the host could put in place of the page or the token.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|Not Acceptable)|_Incapsula_Resource|AwsWafIntegration|captcha|wordfence|sucuri/i;
// A branch or hub and its state's code, as "Sample hub, TN". A line of another shape can name a person, so it is not kept.
const PLACE = /^[A-Za-z][A-Za-z0-9 .&()'/-]{0,80}, [A-Z]{2}$/;
// A scan handed to a partner names the partner's waybill instead of a place, as "Waybill No : 00000000000 - Track Now".
const WAYBILL = /^Waybill No\s*:\s*([A-Za-z0-9]{4,40})\s*-\s*Track Now$/i;
// "Forwarded to SAMPLE PARTNER - Sample State": the partner, then the region it takes the parcel to.
const FORWARDED = /^Forwarded to\s+(.+?)(?:\s+-\s+[^-]+)?$/i;
// "Delivered to SAMPLE NAME": the name of who took the parcel follows the wording.
const DELIVERED_TO = /^(Delivered)\s+to\b[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Franch Express AWB number: eleven digits. Anything else is not one its tracker takes. */
export function normalizeFranchExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Franch Express AWB numbers are eleven digits');
  return number;
}

/** Whether a page or reply is a bot check or a firewall's instead of Franch Express's own. */
export function isFranchExpressChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** The lookup's token for the page, or a challenge or schema failure for any other reply. */
export function franchExpressToken(body: string): string {
  const token = body.trim();
  if (TOKEN.test(token)) return token;
  if (isFranchExpressChallenge(body)) throw new ChallengeError(PROVIDER, 'Franch Express answered with a browser check');
  throw new SchemaError(PROVIDER, 'Franch Express returned an invalid lookup token');
}

/** A wall clock read in India and read back unchanged, as an instant. */
function indianTime(local: string): string | null {
  const format = 'MMM dd, yyyy hh:mm a';
  const wall = firstOccurrence(DateTime.fromFormat(local, format, { zone: ZONE, locale: 'en-US' }));
  // Luxon rolls an impossible day over; only a clock that reads back unchanged is kept.
  if (!wall.isValid || wall.toFormat(format, { locale: 'en-US' }) !== local) return null;
  return wall.toUTC().toISO({ suppressMilliseconds: true });
}

/** A scan's wording without phone numbers; a delivery loses the name of who took the parcel. */
export function franchExpressWording(wording: string): string {
  return clean(wording.replace(DELIVERED_TO, '$1').replace(PHONE, ''), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

interface Scan { event: CarrierEvent; at: string; index: number; key: string; staged: ClassifiedWording | null; partner?: string; waybill?: string }

/**
 * One scan: its clock, its wording, then a line that is the branch or hub, or
 * the partner's waybill when the parcel was handed over. The lines after it,
 * with the scan's code, the consignment's kind, count and weight, a hold's
 * reason and the staff member's name, are not read.
 */
function projectRow($: CheerioAPI, row: Element, index: number): Scan {
  const item = $(row);
  const clock = clean(item.children('p.m-b-5').first().text(), 60);
  const titles = item.children('h4.tracking-title');
  const details = item.children('p').not('.m-b-5');
  if (titles.length !== 1 || details.length !== 1) throw new SchemaError(PROVIDER, 'Franch Express returned an incomplete scan');
  const time = SCAN_CLOCK.test(clock) ? indianTime(clock) : null;
  if (!time) throw new SchemaError(PROVIDER, 'Franch Express returned an invalid scan time');
  const wording = clean(titles.text(), 300);
  const description = franchExpressWording(wording);
  if (!description) throw new SchemaError(PROVIDER, 'Franch Express returned a scan without wording');
  const first = details.children('span.font-normal').first();
  const line = clean(first.text(), 200);
  const location = PLACE.test(line) ? line : '';
  const waybill = WAYBILL.exec(line);
  const forwarded = FORWARDED.exec(wording);
  // The wording must name the partner; its link may only confirm it.
  const named = waybill && forwarded ? carrierIdFromPartner(forwarded[1]!) : undefined;
  const partner = named && carrierIdFromPartner(forwarded![1]!, clean(first.find('a').attr('href'), 300)) === named ? named : undefined;
  const staged = franchExpressStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: time, index, key: JSON.stringify([time, description, location]), staged,
    ...(partner ? { partner, waybill: normalizeTrackingNumber(waybill![1]!) } : {}) };
}

/**
 * The partner a forwarding scan hands the parcel to, with its waybill. The scan
 * must name a catalog carrier and link that carrier's tracking, if it links one,
 * and the waybill must be of a shape the partner issues. Only one partner counts.
 */
function partnerOf(scans: readonly Scan[], number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const found = new Map<string, Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'>>();
  for (const { partner, waybill } of scans) {
    if (!partner || !waybill || partner === 'franch-express' || waybill === number) continue;
    if (!(detectCarrierMatch(waybill).candidates as string[]).includes(partner)) continue;
    found.set(`${partner} ${waybill}`, { delivery_carrier: partner, delivery_tracking_number: waybill });
  }
  return found.size === 1 ? [...found.values()][0]! : {};
}

/**
 * The AWB History page for the number its token holds. A number it knows gets
 * "Status of AWB No." with the number and its scans, newest first; an unknown
 * one gets "Consignment Number / Reference Number not found..!" without the
 * number. The proof-of-delivery images below the scans are not read.
 */
export function parseFranchExpress(html: string, raw: string): CarrierResult {
  const number = normalizeFranchExpressNumber(raw);
  const $ = load(html);
  if (!$('form#thisForm').length) {
    if (isFranchExpressChallenge(html)) throw new ChallengeError(PROVIDER, 'Franch Express answered with a browser check');
    throw new SchemaError(PROVIDER, 'Franch Express returned a page without its tracker');
  }

  const headings = $('h2').filter((_, heading) => RESULT.test(clean($(heading).text(), 200)));
  if (!headings.length) {
    const notices = $('div.alert').toArray().map((notice) => clean($(notice).text(), 200));
    if (notices.some((notice) => NOT_FOUND.test(notice))) throw new NotFoundError(PROVIDER);
    if (notices.some((notice) => NO_LOOKUP.test(notice))) throw new IndeterminateError(PROVIDER, 'Franch Express read no number from the lookup');
    throw new IndeterminateError(PROVIDER, 'Franch Express showed neither a consignment nor its not-found answer');
  }
  if (headings.length > 1) throw new SchemaError(PROVIDER, 'Franch Express returned ambiguous shipments');
  const shown = RESULT.exec(clean(headings.text(), 200))![1]!;
  // The page also finds a consignment by its reference, under the consignment's own number.
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'Franch Express answered for another shipment');

  const rows = headings.nextAll('ul.list-group').first().children('li').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Franch Express returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow($, row, index);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans on one minute keep the page's order, which is newest first too.
  scans.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? 1 : -1));
  const events = scans.map(({ event }) => event);

  const newest = events[0]!;
  const current = scans.find((scan) => scan.staged);
  const staged = current?.staged;
  const delivered = staged?.stage === 'delivered' ? current!.at : undefined;
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...partnerOf(scans, number),
    timezone: ZONE,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
