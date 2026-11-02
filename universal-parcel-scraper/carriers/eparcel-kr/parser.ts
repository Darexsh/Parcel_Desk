import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { normalizeJanioNumber } from '../janio/parser.js';
import { eparcelKrStage } from './status.js';

export const PROVIDER = 'eParcel Korea';
// A long history page is under twenty kilobytes.
export const EPARCEL_KR_MAX_BYTES = 512 * 1024;
// E, the destination country's code, nine digits and KR: the registration number the tracker takes.
const NUMBER = /^E[A-Z]{2}\d{9}KR$/;
const ZONE = 'Asia/Seoul';
// The heading over one number's result, "1 Registration Number : {number}".
const HEADING = /^\d+\s+Registration number\s*:\s*(\S*)$/i;
// The page's own answer for a number it has no parcel for.
const NO_DATA = 'No data.';
// The page the server shows in place of a lookup it could not run.
const UNKNOWN_ERROR = /^Unknown error\.?$/i;
const COLUMNS = 'Date|Status|Explanation';
// A scan's clock to the second; the page marks some "(local time)".
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\s*\(local time\))?$/i;
const STATUS = /^\[(\d{1,4})\]\s*(.+)$/;
const KOREA = /^(?:republic of korea|south korea|korea)$/i;
// Registration, the warehouse in Korea and the flight out of it. Their clocks
// carry the "(local time)" mark; later scans' clocks do not.
const KOREAN_LEG = new Set(['10', '20', '30', '100']);
// Flight scans, whose explanation is the airport.
const AIRPORT = new Set(['100', '200']);
// The delivery company's scans before the delivery, whose explanation is that
// company's own line. The sender (10), eParcel itself or a stock phrase (20,
// 30) and the delivery's outcome (700) are not kept, nor anything under a code
// not seen yet.
const PARTNER_LINE = new Set(['500', '550']);
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;
// A run of nine or more digits, with the separators phone numbers are written with; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Delivery companies whose tracker also finds a parcel by its sender's reference.
const TAKES_REFERENCES: Readonly<Record<string, (reference: string) => boolean>> = {
  janio: (reference) => {
    try {
      return normalizeJanioNumber(reference) === reference;
    } catch {
      return false;
    }
  },
};
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A registration number for eParcel Korea's tracker, in upper case; anything else is not one this adapter sends. */
export function normalizeEparcelKrNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'eParcel Korea registration numbers are E, a country code, nine digits and KR');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** A scan's clock as the page writes it, checked digit for digit, and whether the page marks it local. */
function scanClock(text: string): { wall: string; marked: boolean } {
  const match = CLOCK.exec(text);
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const digits = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!match || !digits.isValid || digits.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) invalid('eParcel Korea returned an invalid scan time');
  return { wall, marked: Boolean(match[3]) };
}

interface Detail { value: string; href?: string }

/** The "More information" lines beside the history, by their label in lower case. */
function details($: CheerioAPI, body: Cheerio<Element>): Map<string, Detail> {
  const boxes = body.find('div.panel').filter((_, box) => clean($(box).children('div.panel-heading').text(), 60) === 'More information');
  if (boxes.length !== 1) invalid('eParcel Korea returned a parcel without its details');
  const lines = new Map<string, Detail>();
  for (const part of (boxes.children('div.panel-body').html() ?? '').split(/<br\s*\/?>/i)) {
    const line = load(part, null, false);
    const text = clean(line.root().text(), 300);
    if (!text) continue;
    const colon = text.indexOf(':');
    if (colon < 1) invalid('eParcel Korea returned an unlabelled detail');
    const label = text.slice(0, colon).trim().toLowerCase();
    if (lines.has(label)) invalid('eParcel Korea returned repeated details');
    lines.set(label, { value: text.slice(colon + 1).trim(), href: line('a[href]').first().attr('href') });
  }
  return lines;
}

/**
 * The delivery company the page names with its number. It is named when the
 * catalog knows it, its link is not on another carrier's host, and its own
 * tracker takes the number: its rules offer it, or it finds parcels by their
 * sender's reference. Another number stays as the delivery number alone.
 */
function handoff(lines: Map<string, Detail>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = normalizeTrackingNumber(lines.get('delivery no')?.value ?? '').toUpperCase();
  if (!/^[A-Z0-9]{4,40}$/.test(reference)) return {};
  const company = lines.get('delivery company');
  const carrier = company?.value ? carrierIdFromPartner(company.value, company.href ?? '') : undefined;
  const takes = carrier && carrier !== 'eparcel-kr'
    && (TAKES_REFERENCES[carrier]?.(reference) ?? (detectCarrierMatch(reference).candidates as string[]).includes(carrier));
  if (takes) return { delivery_carrier: carrier, delivery_tracking_number: reference };
  return reference === number ? {} : { delivery_tracking_number: reference };
}

interface Scan { wall: string; key: string; event: CarrierEvent }

function projectRow($: CheerioAPI, row: Element, korean: boolean): Scan {
  const cells = $(row).children('td');
  if (cells.length !== 3) invalid('eParcel Korea returned an incomplete scan');
  const { wall, marked } = scanClock(clean(cells.eq(0).text(), 40));
  const status = clean(cells.eq(1).text(), 120);
  const coded = STATUS.exec(status);
  const code = coded?.[1] ?? '';
  const wording = clean(coded?.[2] ?? status, 120);
  if (!wording) invalid('eParcel Korea returned a scan without its status');
  const explanation = clean(cells.eq(2).text().replace(PHONE, ' '), 200);
  const location = AIRPORT.has(code) ? explanation.slice(0, 120) : '';
  const description = PARTNER_LINE.has(code) && explanation ? `${wording}: ${explanation}` : wording;
  // A clock the page marks local, on a scan in Korea, is Korea's: one zone, UTC+9 all year.
  const time = korean && marked && KOREAN_LEG.has(code)
    ? firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toUTC().toISO({ suppressMilliseconds: true })! : undefined;
  const staged = eparcelKrStage(code, wording);
  return { wall, key: JSON.stringify([wall, code, description, location]), event: {
    ...(time ? { time } : { local_time: wall }),
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The page `www.eparcel.kr/Track/Result?mode=0&ids={number}` answers, in
 * English. It has one result per number asked, headed by that number. A parcel
 * has its scans newest first, each with its clock, a bracketed code and
 * wording, and an explanation, and a box of details: the departure and
 * destination countries, the registration number, the sender's order number
 * and the delivery company with its number. A number without a parcel gets the
 * page's `No data.`. The sender's name, the order number and the explanations
 * the adapter does not read are not kept.
 */
export function parseEparcelKr(html: string, raw: string): CarrierResult {
  const number = normalizeEparcelKrNumber(raw);
  const $ = load(html);
  const content = $('div#content');
  if (content.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'eParcel Korea answered with a browser check');
    invalid('eParcel Korea returned a page without its results');
  }
  const results = content.children('div.panel');
  if (!results.length && UNKNOWN_ERROR.test(clean(content.text(), 100))) throw new IndeterminateError(PROVIDER, 'eParcel Korea could not run the lookup');
  if (results.length !== 1) invalid('eParcel Korea returned an unexpected set of results');
  const result = results.first();
  const headings = result.children('div.panel-heading').children('span')
    .map((_, span) => HEADING.exec(clean($(span).text(), 100))?.[1]).get();
  const body = result.children('div.panel-body');
  if (headings.length !== 1 || body.length !== 1) invalid('eParcel Korea returned a result without its number');
  if (headings[0] !== number) throw new IndeterminateError(PROVIDER, 'eParcel Korea answered for another number');

  const tables = body.find('table');
  if (!tables.length) {
    if (clean(body.text(), 100) === NO_DATA) throw new NotFoundError(PROVIDER);
    invalid('eParcel Korea returned a result without a history');
  }
  const lines = details($, body);
  const registered = normalizeTrackingNumber(lines.get('registration number')?.value ?? '');
  if (!registered) invalid('eParcel Korea returned a parcel without its registration number');
  if (registered !== number) throw new IndeterminateError(PROVIDER, 'eParcel Korea answered for another parcel');
  if (tables.length !== 1) invalid('eParcel Korea returned more than one history');
  const columns = tables.find('thead th').map((_, cell) => clean($(cell).text(), 40)).get().join('|');
  if (columns !== COLUMNS) invalid('eParcel Korea returned an unexpected history table');
  const rows = tables.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) invalid('eParcel Korea returned an oversized history');

  const korean = KOREA.test(lines.get('departure country')?.value ?? '');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const scan = projectRow($, row, korean);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  if (scans[0]!.wall < scans.at(-1)!.wall) scans.reverse();
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = clean(lines.get('destination country')?.value, 80);
  const country = destination ? countryCode(destination) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    ...handoff(lines, number),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
