import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { midlandMappedStage, midlandStage } from './status.js';

export const PROVIDER = 'Midland Transport';
// A delivered parcel's page is about 60 kilobytes.
export const MIDLAND_MAX_BYTES = 1024 * 1024;
// A Midland Courier number: the shipment's twelve digits and a four-digit package counter.
const NUMBER = /^\d{16}$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "15 Sep 2026 18:57", a scan's clock.
const SCAN_CLOCK = /^(\d{1,2}) ([A-Z]{3}) (\d{4}) (\d{2}):(\d{2})$/i;
// "Sep 11 2026 12:11", the shipment's creation, and "Sep 17 2026", a day.
const SUMMARY_CLOCK = /^([A-Z]{3}) (\d{1,2}) (\d{4})(?: (\d{2}):(\d{2}))?$/i;
// The tracker's answer for a number it does not hold.
const NOT_FOUND = /^The shipment number does not exist\b/i;
// ASP.NET's error page, in place of the tracker's.
const SERVER_ERROR = /An error occurred while processing your request/i;
// "Processed at Sort Facility(TESTVILLE,NB)": Midland's wording, then the
// terminal's town and its province or state.
const TERMINAL = /^([\s\S]*?)\s*\(([^()]+?)\s*,\s*([A-Z]{2})\s*\)$/;
// Who signed for or took the parcel, should a delivery's wording name them.
const SIGNER = /\s*[-,:;]?\s*\b(?:signed (?:for )?by|received by|signature)\b[\s\S]*$/i;
// A run of ten or more digits written as a phone number.
const PHONE = /\+?\d(?:[\s().-]{0,2}\d){9,}/g;
// Imperva's block and challenge pages, or another CDN's. Every page of the
// tracker loads an `_Incapsula_Resource` script, so that name alone is no block.
const BLOCKED = /Incapsula incident ID|Request unsuccessful\.|id="main-iframe"[^>]*_Incapsula_Resource|Pardon Our Interruption|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
const PLACEHOLDER = 'no tracking info';
const CREATED = 'Shipment Created';
const FINAL = new Set<Stage>(['delivered', 'returned']);
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A sixteen-digit Midland Courier number; anything else is not one this tracker is known to hold. */
export function normalizeMidlandNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Midland Courier numbers are sixteen digits');
  return number;
}

/** A wall clock from its parts, kept only when the calendar has it. */
function wallClock(year: string, month: string, day: string, hour = '00', minute = '00'): string | null {
  const index = MONTHS.indexOf(month.toLowerCase());
  if (index < 0) return null;
  const local = `${year}-${String(index + 1).padStart(2, '0')}-${day.padStart(2, '0')}T${hour}:${minute}:00`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  return DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") === local ? local : null;
}

function scanClock(text: string): string {
  const match = SCAN_CLOCK.exec(text);
  const local = match ? wallClock(match[3]!, match[2]!, match[1]!, match[4], match[5]) : null;
  if (!local) throw new SchemaError(PROVIDER, 'Midland returned an invalid scan time');
  return local;
}

/**
 * A summary clock, "Sep 11 2026 12:11", or a day, "Sep 17 2026"; null for the
 * page's dash, a blank or another form. These dates only add to the history,
 * so a change in them does not fail the lookup.
 */
function summaryClock(text: string | null): string | null {
  const match = SUMMARY_CLOCK.exec(text ?? '');
  const local = match ? wallClock(match[3]!, match[1]!, match[2]!, match[4], match[5]) : null;
  return local && !match![4] ? local.slice(0, 10) : local;
}

const ownText = (element: Cheerio<AnyNode>) => clean(element.contents().filter((_, node) => node.nodeType === 3).text(), 120);

/** The value the page prints in bold after a label, as "Ship Date:"; null when the page has no such label. */
function summaryValue($: CheerioAPI, container: Cheerio<Element>, label: string): string | null {
  const matches = container.find('p.text-muted').filter((_, element) => ownText($(element)) === `${label}:`);
  if (matches.length > 1) throw new SchemaError(PROVIDER, `Midland returned ${label} twice`);
  return matches.length ? clean(matches.find('strong').first().text(), 64) : null;
}

/** A shipment detail after its label, as "Carrier:"; null when the page has no such label. */
function detail($: CheerioAPI, container: Cheerio<Element>, label: string): string | null {
  const matches = container.find('.form-group > label').filter((_, element) => clean($(element).text(), 80) === `${label}:`);
  if (matches.length > 1) throw new SchemaError(PROVIDER, `Midland returned ${label} twice`);
  return matches.length ? ownText(matches.first().parent()) : null;
}

/** The scan's wording without the terminal after it, which becomes its location, or a signer or phone number. */
function wording(raw: string, mapLocation: string): { description: string; location: string } {
  const terminal = TERMINAL.exec(raw);
  const text = terminal ? terminal[1]! : raw;
  const description = clean(text.replace(SIGNER, '').replace(PHONE, ''), 300).replace(/[\s,;:-]+$/, '');
  const location = terminal ? `${clean(terminal[2], 80)}, ${terminal[3]!.toUpperCase()}` : mapLocation;
  return { description, location };
}

/** The page without a shipment: the tracker's answer for an unknown number, a block or another page. */
function noShipment($: CheerioAPI, html: string, number: string): never {
  const notice = clean($('#divTrackDetails .alert-danger').first().text(), 300);
  if (NOT_FOUND.test(notice)) {
    // The answer does not name the number, but the search field above it repeats the one asked.
    const asked = normalizeTrackingNumber(clean($('input#TrackingNumber').attr('value'), 64));
    if (asked !== number) throw new IndeterminateError(PROVIDER, 'Midland answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Midland answered with a block page');
  if (notice || SERVER_ERROR.test(html.slice(0, 64_000))) throw new IndeterminateError(PROVIDER, 'Midland’s tracker did not complete the lookup');
  throw new SchemaError(PROVIDER, 'Midland returned an unexpected page');
}

/**
 * The tracking page for one number. A shipment opens with a progress bar,
 * then its number, a summary word, the ship, creation and expected delivery
 * dates over the origin and destination towns, a Travel History table oldest
 * first and the shipment details: the package number, carrier and service. A
 * number the tracker does not hold gets one line instead. The package number
 * must be the number asked, and the carrier Midland's. The shipper's name,
 * phone and email, its reference, the towns, the package count and the
 * shipment's other package numbers are not kept.
 */
export function parseMidland(html: string, raw: string): CarrierResult {
  const number = normalizeMidlandNumber(raw);
  const $ = load(html);
  const container = $('#divTrackDetails #TrackingPageContainer');
  if (container.length !== 1) noShipment($, html, number);

  const shown = detail($, container, 'Package Tracking#');
  if (!shown) throw new SchemaError(PROVIDER, 'Midland returned a shipment without its number');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'Midland answered for another number');
  const carrier = detail($, container, 'Carrier');
  if (!carrier) throw new SchemaError(PROVIDER, 'Midland returned a shipment without its carrier');
  // The tracker belongs to a multi-carrier shipping platform; only Midland's own shipments are Midland's to answer.
  if (!/^Midland\b/i.test(carrier)) throw new IndeterminateError(PROVIDER, 'Midland’s tracker answered for another carrier’s shipment');

  const rows = container.find('#collapseTravelHistory table tbody > tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Midland returned an oversized history');
  const creation = summaryClock(summaryValue($, container, 'Shipment Created Date'));
  const created = creation && creation.length > 10 ? creation : null;
  const seen = new Set<string>();
  const events: { event: CarrierEvent; index: number }[] = [];
  // The creation the progress bar starts with: the placeholder row the table
  // shows until the first scan repeats it, and the table drops it after.
  if (created) {
    events.push({ index: -1, event: { local_time: created, description: CREATED, provider_code: CREATED, stage: 'registered', stage_source: 'carrier_map' } });
  }
  for (const [index, element] of rows.toArray().entries()) {
    const cells = $(element).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Midland’s history layout changed');
    const local = scanClock(clean(cells.eq(0).text(), 40));
    const activity = clean(cells.eq(1).text(), 80);
    if (created && activity.toLowerCase() === PLACEHOLDER) continue;
    const { description: own, location } = wording(clean(cells.eq(2).text(), 400), clean(cells.eq(2).attr('data-location'), 120));
    const description = own || activity;
    if (!description) throw new SchemaError(PROVIDER, 'Midland returned a scan without wording');
    const key = JSON.stringify([local, activity, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = midlandStage(activity, description);
    events.push({ index, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(activity ? { provider_code: activity } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the page lists scans oldest first, so equal clocks take its order reversed.
  events.sort((left, right) => {
    const a = left.event.local_time as string;
    const b = right.event.local_time as string;
    return a < b ? 1 : a > b ? -1 : right.index - left.index;
  });
  const newestFirst = events.map(({ event }) => event);

  const newest = newestFirst[0]!;
  // The summary word over the dates is the shipment's state; the newest staged scan stands in when the word is new.
  const summary = midlandMappedStage(clean(container.find('.alert[data-status-type]').first().text(), 80));
  const scanned = newestFirst.find((event) => event.stage);
  const stage = summary ?? (scanned?.stage as Stage | undefined);
  const source = summary ? 'carrier_map' : scanned?.stage_source;
  // The updated estimate replaces the first one; neither matters once the parcel arrived.
  const estimate = summaryClock(summaryValue($, container, 'Updated Expected Delivery'))
    ?? summaryClock(summaryValue($, container, 'Expected Delivery'));
  const expected = estimate && !(stage && FINAL.has(stage)) ? estimate.slice(0, 10) : null;
  const service = detail($, container, 'Service');
  // The destination town under the estimate starts with its country.
  const destination = clean(container.find('p.text-muted').filter((_, element) => ownText($(element)) === 'Expected Delivery:')
    .closest('.panel-body').find('p.scan-description').first().attr('data-location'), 160);
  const country = countryCode(destination.split(',')[0]);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    ...(service && service !== '-' ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
