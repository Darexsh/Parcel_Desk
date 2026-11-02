import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { fastboxStage } from './status.js';

export const PROVIDER = 'Fastbox';
// A long history is a few dozen kilobytes.
export const FASTBOX_MAX_BYTES = 512 * 1024;
// FB and sixteen digits, the format the tracker asks for.
const NUMBER = /^FB\d{16}$/;
// The tracker's answer for an invoice it does not know, or no longer keeps.
const UNKNOWN = /alert\(\s*'It is not a valid FASTBOX invoice number\./;
const INFO_COLUMNS = ['Destination Country', 'Domestic Invoice No', 'Shipping Company', 'Departed From'];
const EVENT_COLUMNS = 'DATE TIME|STATUS|Location|Shipping|Detail';
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/;
// Fastbox's warehouse and Korea Post date their rows in Korea.
const KOREA_ZONE = 'Asia/Seoul';
const KOREAN_SHIPPERS = /^(?:fastbox|korea post\b)/i;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;
// Stages after which a receipt or advance data is no step back.
const MOVED = new Set<string>(['accepted', 'in_transit', 'customs', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An FB invoice for Fastbox's tracker; anything else is not one Fastbox issues. */
export function normalizeFastboxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Fastbox invoices are FB and sixteen digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

function cellsOf($: CheerioAPI, row: Element): Cheerio<Element> {
  return $(row).children('td, th');
}

function tableByCaption($: CheerioAPI, caption: RegExp): Cheerio<Element> {
  return $('table').filter((_, table) => caption.test(clean($(table).children('caption').text(), 120)));
}

function headings($: CheerioAPI, table: Cheerio<Element>): string[] {
  return table.find('thead th').map((_, cell) => clean($(cell).text(), 60)).get();
}

/**
 * A row's clock: the date and the minute, in Korea for Fastbox's and Korea
 * Post's rows, else the wall clock of the partner's place.
 */
function clock(value: string, shipper: string): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const match = WALL_CLOCK.exec(value);
  if (!match) invalid('Fastbox returned an invalid scan time');
  const wall = `${match[1]}T${match[2]}:00`;
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) invalid('Fastbox returned an invalid scan time');
  const time = KOREAN_SHIPPERS.test(shipper) ? isoTime(wall, KOREA_ZONE) : null;
  return time ? { local_time: wall, time: time.iso, time_zone: KOREA_ZONE, time_zone_basis: 'carrier' } : { local_time: wall };
}

/** The partner's domestic invoice, when its name and the number's layout name the same carrier. */
function handoff(company: string, invoice: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const number = normalizeTrackingNumber(invoice);
  if (!number || !company) return {};
  // Korea Post's EMS service is Korea Post.
  const carrier = carrierIdFromName(company) ?? carrierIdFromName(company.replace(/\s+EMS$/i, ''));
  return carrier && (detectCarrierMatch(number).candidates as string[]).includes(carrier)
    ? { delivery_carrier: carrier, delivery_tracking_number: number } : {};
}

/**
 * The page `fastbox.co.kr/DHUB/tracking.php?fb_invoice_no={number}` answers,
 * with the invoice in its search form. A known invoice has a shipment table
 * (destination, the partner's domestic invoice and name, the origin, then the
 * recipient's name and address, which are never read) and a table of rows,
 * oldest first: Fastbox's own steps, then the partner's scans, relayed with
 * the platform's status tag. An invoice the tracker does not know, or no longer
 * keeps, gets the form alone and an alert.
 */
export function parseFastbox(html: string, raw: string): CarrierResult {
  const number = normalizeFastboxNumber(raw);
  const $ = load(html);
  const asked = normalizeTrackingNumber(clean($('input[name="fb_invoice_no"]').attr('value'), 64));
  const info = tableByCaption($, /^FASTBOX Shipment Information$/);
  const rows = $('table').filter((_, table) => headings($, $(table)).join('|') === EVENT_COLUMNS);
  if (!info.length && !rows.length) {
    if (asked === number && UNKNOWN.test(html)) throw new NotFoundError(PROVIDER, 'Fastbox has no shipment under this invoice');
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Fastbox refused the lookup');
    invalid('Fastbox returned a page without its results');
  }
  if (asked !== number) invalid('Fastbox answered for another invoice');
  if (info.length !== 1 || rows.length !== 1) invalid('Fastbox returned a page the adapter does not know');
  const columns = headings($, info);
  if (INFO_COLUMNS.some((column, index) => columns[index] !== column)) invalid('Fastbox returned a shipment table the adapter does not know');
  // The shipment's first four cells only: the recipient's follow.
  const shipment = cellsOf($, info.find('tbody > tr').first().get(0)!).slice(0, INFO_COLUMNS.length)
    .map((_, cell) => clean($(cell).text(), 120)).get();
  const [country = '', invoice = '', company = '', departed = ''] = shipment;

  const lines = rows.find('tbody > tr').toArray();
  if (lines.length > MAX_ROWS) invalid('Fastbox returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const line of lines) {
    const cells = cellsOf($, line);
    if (cells.length !== 5) invalid('Fastbox returned an incomplete scan');
    const [stamp = '', tag = '', place = '', shipper = '', detail = ''] = cells.map((_, cell) => clean($(cell).text(), 300)).get();
    const description = detail || tag;
    if (!description) invalid('Fastbox returned a scan without its wording');
    // The tracker can list a partner's row twice.
    const key = JSON.stringify([stamp, tag, place, shipper, detail]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = fastboxStage(tag, description);
    const location = place && place !== '-' ? place : '';
    events.push({ ...clock(stamp, shipper), ...(location ? { location } : {}), description, ...(tag ? { provider_code: tag } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // A partner's receipt or advance data after the parcel moved on takes it along its way.
  let moved = false;
  for (const event of events) {
    if (moved && (event.stage === 'accepted' || event.stage === 'registered')) Object.assign(event, { stage: 'in_transit', stage_source: 'carrier_map' });
    else if (event.stage && MOVED.has(event.stage)) moved = true;
  }
  // The rows are in the journey's order on each place's clock, so the newest is the last row.
  events.reverse();
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = countryCode(country);
  const origin = countryCode(departed);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time ?? null,
    expected_delivery: null,
    ...(origin ? { origin_country: origin } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...handoff(company, invoice),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
