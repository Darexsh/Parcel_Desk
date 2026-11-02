import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { pakistanPostStage } from './status.js';

export const PROVIDER = 'Pakistan Post';
// A long history is under 20 kB; the page repeats it in its view state.
export const PAKISTAN_POST_MAX_BYTES = 2_000_000;

const MAX_ROWS = 1000;
// Domestic article numbers: three letters for the service, then eight digits.
const DOMESTIC = /^[A-Z]{3}\d{8}$/;
// The tracker's answer for a number it holds no scans for.
const NO_ROUTE = 'Route Not Found';
const HEADING = 'Article Track Detail';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|captcha/i;
const DATE = /^[A-Z][a-z]+ \d{2}, \d{4}$/;
const CLOCK = /^(?:0?[1-9]|1[0-2]):[0-5]\d [AP]M$/i;
// A run of nine or more digits, with the separators phone numbers are written with.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// The bag a domestic scan moved in, as "(BagID:BAG00000000)".
const BAG = /\s*\(BagID:[^)]*\)/gi;
// A delivery names who took the item after "to": "Delivered to Addresse NAME".
const RECEIVER = /^(delivered\b.*?)\s+to\s.*$/i;
// A scan with a reason after a colon: the reason is a postman's pick from a
// list or free text, which can name a person.
const REASONED = /^(undelivered reason|return to sender reason|miss?sent)\s*:\s*(.*)$/i;
const LABELS: Readonly<Record<string, string>> = {
  'undelivered reason': 'Undelivered', 'return to sender reason': 'Return to sender', missent: 'Missent', misssent: 'Missent',
};
// The reasons that recur as the delivery staff's list gives them, spelled as the page spells them.
const REASONS = new Set(['deposit', 'address not found', 'addressee not found', 'receipient not at home', 'refused to received',
  'wrong address', 'incomplete address', 'address changed', 'uncalimed', 'missent', 'rts']);

/**
 * The tracker looks up S10 item codes, Pakistan Post's own ending PK and those
 * of the posts that send items to Pakistan, with a valid check digit, and the
 * domestic article numbers, such as RGL, UMS or PAR and eight digits.
 */
export function normalizePakistanPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number) || DOMESTIC.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Pakistan Post tracks S10 item codes and domestic article numbers of three letters and eight digits');
}

/**
 * A scan's wording, as the page writes it, without the bag it moved in, the
 * person a delivery names, a reason the delivery staff's list does not give
 * and phone numbers. A missent scan keeps no reason: it is the office it is
 * sent on to.
 */
export function pakistanPostWording(text: string): string {
  let wording = clean(text.replace(BAG, ''), 300).replace(RECEIVER, '$1');
  const reasoned = REASONED.exec(wording);
  if (reasoned) {
    const label = LABELS[reasoned[1]!.toLowerCase()]!;
    const reason = clean(reasoned[2], 80);
    wording = label !== 'Missent' && REASONS.has(reason.toLowerCase()) ? `${label}: ${reason}` : label;
  }
  return clean(wording.replace(PHONE, '')).replace(/[\s,;:-]+$/, '');
}

/** A scan's date ("January 09, 2026") and 12-hour time ("7:41 AM"): the scanning office's wall clock, with no zone. */
function wallClock(date: string, time: string): string {
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = DATE.test(date) && CLOCK.test(time)
    ? DateTime.fromFormat(`${date} ${time.toUpperCase()}`, 'MMMM dd, yyyy h:mm a', { zone: 'UTC', locale: 'en-US' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'Pakistan Post returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

interface Scan { event: CarrierEvent; index: number }

/** A labelled value of the summary above the history; the history's sections reuse the same ids. */
function summaryText($: CheerioAPI, id: string): string | undefined {
  const spans = $(`span#${id}`).filter((_, node) => $(node).closest('#TrackDetailDiv').length === 0);
  return spans.length === 1 ? clean(spans.first().text(), 120) : undefined;
}

/** The destination country an international item's summary names; a domestic item's names offices. */
function destinationOf($: CheerioAPI): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  if (!/^Destination Country\s*:?$/i.test(summaryText($, 'LblDeliveryOfficeTitle') ?? '')) return {};
  // ISO 3166 names some countries with a trailing "(the)".
  const name = (summaryText($, 'LblDeliveryOffice') ?? '').replace(/\s*\(the\)$/i, '');
  if (!name || /^(?:n\/a|-+)$/i.test(name)) return {};
  const code = countryCode(name);
  return code ? { destination_country: code } : { destination_country_name: name };
}

function scansOf($: CheerioAPI, table: Cheerio<Element>): Scan[] {
  const scans: Scan[] = [];
  const seen = new Set<string>();
  let date = '';
  const rows = table.find('tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pakistan Post returned an oversized history');
  rows.each((index, node) => {
    const row = $(node);
    const heading = row.find('div.date-heading');
    if (heading.length) {
      date = clean(heading.text(), 40);
      return;
    }
    const cells = row.children('td');
    if (!row.children('td.time').length) return;
    if (cells.length !== 4 || !date) throw new SchemaError(PROVIDER, 'Pakistan Post history columns changed');
    const description = pakistanPostWording(cells.eq(3).text());
    if (!description) throw new SchemaError(PROVIDER, 'Pakistan Post returned a scan without wording');
    const place = clean(cells.eq(2).text(), 120);
    const location = /^-*$/.test(place) ? '' : place;
    const staged = pakistanPostStage(description);
    const event: CarrierEvent = {
      local_time: wallClock(date, clean(cells.eq(1).text(), 16)),
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    // The page can list one scan several times; it is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, index });
  });
  return scans;
}

/**
 * The tracker's page for one number, the one its form opens in a frame: a
 * summary naming the item, then its scans oldest first under the day they
 * happened. A cash-on-delivery or value-payable item's page then adds the
 * money order taking the amount back to its sender, under that order's own
 * number; only the item's own history is read. A number with no scans comes
 * back with the summary and the tracker's "Route Not Found", or, for an S10
 * code, with empty histories.
 */
export function parsePakistanPost(html: string, rawNumber: string): CarrierResult {
  const number = normalizePakistanPostNumber(rawNumber);
  const $ = load(html);
  const echoed = summaryText($, 'LblArticleTrackingNo');
  const details = $('div#TrackDetailDiv');
  if (echoed === undefined || details.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pakistan Post answered with a block page');
    throw new SchemaError(PROVIDER, 'Pakistan Post did not return its tracking page');
  }
  if (returnedTrackingNumber(echoed) !== number) throw new SchemaError(PROVIDER, 'Pakistan Post answered for a different item');
  const table = details.find('table.simple-table').first();
  if (!table.length) {
    if (!clean(details.text())) throw new IndeterminateError(PROVIDER, 'Pakistan Post returned its page without an answer');
    throw new SchemaError(PROVIDER, 'Pakistan Post history changed');
  }
  if (clean(table.find('div.row-heading').first().text(), 60) !== HEADING) throw new SchemaError(PROVIDER, 'Pakistan Post history changed');
  const scans = scansOf($, table);
  if (!scans.length) {
    // Only the tracker's own answer is a missing item.
    const cells = table.find('td').filter((_, cell) => $(cell).find('div.row-heading').length === 0);
    if (cells.length === 1 && clean(cells.text(), 60) === NO_ROUTE) throw new NotFoundError(PROVIDER);
    // An S10 code the tracker holds no scans for comes back with empty histories and no notice.
    if (!table.find('td.time').length && (!cells.length || table.find('div.date-heading').length)) throw new NoHistoryError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Pakistan Post returned a history without scans');
  }
  // Newest first; scans at the same minute keep the page's order reversed, the later one first.
  scans.sort((left, right) => right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : right.index - left.index);
  const events = scans.map(({ event }) => event);
  const latest = events[0]!;
  // An update has no stage; the newest scan with one sets the item's.
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...destinationOf($),
    events,
  };
}
