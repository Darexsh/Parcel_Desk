import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, decodeText } from '../../core/transport/index.js';
import { tmmExpressStage } from './status.js';

export const PROVIDER = 'TMM Express';
// A consignment's page is about 45 kB, most of it the site's own markup.
export const TMM_EXPRESS_MAX_BYTES = 1024 * 1024;
const PAGE = 'https://ukr.tmm-express.com/en/trackparcels';
// The AWB numbers TMM Express prints are ten digits.
const NUMBER = /^\d{10}$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;
// The notice for a number the tracker holds nothing for, in English or in the
// site's Russian or Ukrainian: "за запитом -{number} інформація не знайдена".
const NOT_FOUND = /\bnot\s+found\b|не\s+знайден|не\s+найден/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(\d{1,2}):(\d{2}):(\d{2})$/;
// The codes whose remark after " - " names a hub or depot. Other remarks are
// free text, such as the new address of a change of address, and are not kept.
const PLACE_REMARKS: ReadonlySet<string> = new Set(['IS', 'IRP']);
const MAX_ROWS = 300;

/** A TMM Express AWB number; anything else is not one it issues. */
export function normalizeTmmExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TMM Express AWB numbers are ten digits');
  return number;
}

/** The tracker's page for one AWB number. */
export function tmmExpressTrackingUrl(raw: string): string {
  return `${PAGE}?${new URLSearchParams({ num: normalizeTmmExpressNumber(raw), mark: 'is_code' })}`;
}

/** A scan's wall clock to the second. The page names no zone, so it stays local. */
function wallClock(date: string, time: string): string {
  const clock = TIME.exec(time);
  const local = DATE.test(date) && clock ? `${date}T${clock[1]!.padStart(2, '0')}:${clock[2]}:${clock[3]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'TMM Express returned an invalid scan time');
  }
  return local;
}

/**
 * A scan's wording without the remark the page can add after " - ", except a
 * hub's or depot's name; the remark of a change of address is the new address.
 */
export function tmmExpressWording(code: string, description: string): { wording: string; head: string } {
  const text = clean(description, 300);
  const split = /^(.*?)\s+-(?:\s+(.*))?$/.exec(text);
  const head = clean(split?.[1] ?? text, 200);
  const remark = clean(split?.[2] ?? '', 80);
  return { head, wording: remark && PLACE_REMARKS.has(code) ? `${head} - ${remark}` : head };
}

/** One attribute of a status, which must be there. */
function attribute(row: Element, name: string, maxLength: number): string {
  const value = row.attribs[name];
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TMM Express returned a scan without its ${name}`);
  return clean(value, maxLength);
}

/** The statuses of the consignment data, newest first as the page lists them. */
function scans($: CheerioAPI): CarrierEvent[] {
  const rows = $('connote > statuses > status').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TMM Express returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const code = attribute(row, 'code', 16).toUpperCase();
    const { head, wording } = tmmExpressWording(code, attribute(row, 'description', 300));
    if (!head) throw new SchemaError(PROVIDER, 'TMM Express returned a scan without wording');
    const local = wallClock(attribute(row, 'eventDate', 16), attribute(row, 'eventTime', 16));
    const location = clean(row.attribs.depotName, 80);
    const key = JSON.stringify([local, code, wording, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = tmmExpressStage(code, head);
    events.push({
      local_time: local,
      ...(location ? { location } : {}),
      description: wording,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return events;
}

/** The consignment data the page carries for its download button, base64-encoded XML. */
function consignment(encoded: string): CheerioAPI {
  let xml = '';
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length % 4 === 0) {
    try {
      xml = decodeText(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
    } catch {
      xml = '';
    }
  }
  const $ = load(xml, { xml: true });
  if ($('connote').length !== 1 || $('connote > statuses').length !== 1) {
    throw new SchemaError(PROVIDER, 'TMM Express returned invalid consignment data');
  }
  return $;
}

/** Drupal's notice above the content, for a number the tracker has nothing for. */
function notFound($: CheerioAPI, number: string): never {
  const notices = $('div.messages');
  const notice = clean(notices.text(), 300);
  if (notices.length === 1 && NOT_FOUND.test(notice)) {
    // The notice repeats the number asked.
    const echoed = notice.match(/\d{6,}/g) ?? [];
    if (echoed.length !== 1 || echoed[0] !== number) throw new IndeterminateError(PROVIDER, 'TMM Express answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (notice) throw new IndeterminateError(PROVIDER, 'TMM Express answered with another notice');
  throw new SchemaError(PROVIDER, 'TMM Express returned a page without a consignment');
}

/**
 * TMM Express's tracker, `trackparcels?num={number}&mark=is_code`, for one AWB
 * number. A consignment's page has its Common information table, which echoes
 * the number, the Detailed information table of its scans, and the same
 * consignment as base64 XML for the download button, with each status's code.
 * The XML also holds the signatory and a customer reference, which are not read.
 */
export function parseTmmExpress(html: string, raw: string): CarrierResult {
  const number = normalizeTmmExpressNumber(raw);
  const $ = load(html);
  const tables = $('table.common_information');
  if (!tables.length) {
    if (!$('#block-system-main, div.messages').length && BLOCKED.test(html.slice(0, 64_000))) {
      throw new ChallengeError(PROVIDER, 'TMM Express answered with a browser check');
    }
    return notFound($, number);
  }
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'TMM Express returned several consignments');
  const echoed = tables.find('td#awbnum');
  if (echoed.length !== 1) throw new SchemaError(PROVIDER, 'TMM Express returned a consignment without its number');
  if (clean(echoed.text(), 64) !== number) throw new IndeterminateError(PROVIDER, 'TMM Express answered for another number');

  const data = $('input[name="xmltosave[0]"]');
  if (data.length !== 1 || $('input[name="xmltosave[1]"]').length) {
    throw new SchemaError(PROVIDER, 'TMM Express returned a consignment without its data');
  }
  const xml = consignment(clean(data.attr('value'), 2_000_000));
  if (clean(xml('connote > number').first().text(), 64) !== number) {
    throw new IndeterminateError(PROVIDER, 'TMM Express answered for another number');
  }

  const events = scans(xml);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const country = countryCode(xml('connote > destinationCountry').attr('code'));

  // Clocks come from Poland, Ukraine and the origin country and keep no zone, so the page's order stands.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
