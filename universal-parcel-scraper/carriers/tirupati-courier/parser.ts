import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { tirupatiStage } from './status.js';

export const PROVIDER = 'Shree Tirupati Courier';
export const TIRUPATI_ORIGIN = 'https://www.shreetirupaticourier.net';
/** The tracking box every page loads into its header: a WebForms form that posts the number back to itself. */
export const TIRUPATI_HEADER = `${TIRUPATI_ORIGIN}/TopHeader.aspx`;
/** The tracking detail the result page shows in its frame, for the number the server encrypted. */
export const TIRUPATI_DETAIL = `${TIRUPATI_ORIGIN}/Frm_DocTrackWeb.aspx`;
// The header is about 3 kB and the tracking detail about 12 kB; each scan adds well under one.
export const TIRUPATI_MAX_BYTES = 512 * 1024;

// The tracking box asks for twelve-digit AWB numbers.
const NUMBER = /^\d{12}$/;
// Every branch and office is in India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
// The booking's day and clock, as "29-08-26 - 07:00 PM", day first with a two-digit year.
const BOOKED = /^(\d{2})-(\d{2})-(\d{2}) - (\d{2}):(\d{2}) ([AP]M)$/;
// A scan's or the status line's day, as "29-08-26".
const DAY = /^(\d{2})-(\d{2})-(\d{2})$/;
// The status line, as "Out To SAMPLE R.O. On Dated 29-08-26" or "Delivered On Dated 04-09-26 By SAMPLEPUR".
const STATUS_LINE = /^(.+?)\s+On Dated\s+(\d{2}-\d{2}-\d{2})(?:\s+By\s+(.+))?$/i;
// An OUT row's route names the office it left and the next one; an IN row's the office it reached first.
const OUT_ROUTE = /^From:\s*(.*?)\s*To:\s*(.*)$/i;
const IN_ROUTE = /^At:\s*(.*?)(?:\s+From:.*)?$/i;
// A job code, as the first column prints it.
const JOB = /^[A-Z]{1,10}$/;
// The answer's key: the Base64 text the server encrypted the number into.
const KEY = /^[A-Za-z0-9+/]{2,200}={0,2}$/;
const DOC_LIST = /^\/Frm_DocList\.aspx$/i;
// The page the site sends a request it fails to the address of, worded as scheduled maintenance.
const ERROR_PAGE = /^\/_NotAvailable\.aspx$/i;
// Bot checks a CDN or firewall could put in place of a page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|_Incapsula_Resource|AwsWafIntegration|captcha-delivery/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const FIELD = /^__[A-Z]{1,30}$/;
const MAX_FIELD_LENGTH = 50_000;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Shree Tirupati Courier AWB number: twelve digits. Anything else is not one its tracking box takes. */
export function normalizeTirupatiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shree Tirupati Courier AWB numbers are twelve digits');
  return number;
}

/** Whether a page is a bot check instead of the carrier's own. */
export function isTirupatiChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A page without what the carrier's own page has: a bot check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isTirupatiChallenge(html)) throw new ChallengeError(PROVIDER, 'Shree Tirupati Courier answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** What the header's tracking box posts back to look a number up, as its Go button sends it. */
export function tirupatiLookupFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = $('form').filter((_, element) => $(element).find('input#trackingno').length === 1);
  const button = form.find('input#btnTrack[type="submit"]');
  if (form.length !== 1 || button.length !== 1) unexpected(html, 'Shree Tirupati Courier returned a header without its tracking box');
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (FIELD.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) {
    throw new SchemaError(PROVIDER, 'Shree Tirupati Courier returned a tracking box without its state');
  }
  fields.set('trackingno', number);
  fields.set(button.attr('name') || 'btnTrack', button.attr('value') || 'Go');
  // The network search box beside it goes along empty, as in the browser.
  if (form.find('input#networksearch').length) fields.set('networksearch', '');
  return fields;
}

/** An address the site's redirect names, on its own host, or null for another. */
function siteAddress(location: string | null): URL | null {
  try {
    const target = location ? new URL(location, `${TIRUPATI_ORIGIN}/`) : null;
    return target?.origin === TIRUPATI_ORIGIN ? target : null;
  } catch {
    return null;
  }
}

/**
 * A page that answered with a redirect. The site sends a request it fails to
 * its error page, worded as scheduled maintenance, which is no answer; any
 * other redirect is a moved route.
 */
export function tirupatiRedirected(location: string | null, what: string): never {
  if (ERROR_PAGE.test(siteAddress(location)?.pathname ?? '')) {
    throw new IndeterminateError(PROVIDER, `Shree Tirupati Courier sent its ${what} to its error page`);
  }
  throw new TransportError(PROVIDER, `Shree Tirupati Courier moved its ${what}`);
}

/**
 * The tracking detail for the lookup's redirect. The post answers with the
 * address of the AWB list, whose frame opens the detail with the same key;
 * the key is Base64 the server writes raw, so it is encoded here to keep a
 * `+` from reaching the server as a space.
 */
export function tirupatiDetailUrl(location: string | null): string {
  const target = siteAddress(location);
  if (!target || !DOC_LIST.test(target.pathname)) tirupatiRedirected(location, 'tracking lookup');
  const raw = /[?&]docnos=([^&#]*)/i.exec(location!)?.[1] ?? '';
  let key = '';
  try {
    key = decodeURIComponent(raw);
  } catch {
    // A broken escape is a changed answer, as below.
  }
  if (!KEY.test(key)) throw new SchemaError(PROVIDER, 'Shree Tirupati Courier answered the lookup without its key');
  return `${TIRUPATI_DETAIL}?docno=${encodeURIComponent(key)}`;
}

/** The booking's wall clock, read in India and read back unchanged, as an instant. */
function bookingTime(text: string): string {
  const parts = BOOKED.exec(text);
  const local = parts ? `${parts[1]}-${parts[2]}-20${parts[3]} ${parts[4]}:${parts[5]} ${parts[6]}` : '';
  const format = 'dd-MM-yyyy hh:mm a';
  const wall = firstOccurrence(DateTime.fromFormat(local, format, { zone: ZONE, locale: 'en-US' }));
  // Luxon rolls an impossible day over; only a clock that reads back unchanged is kept.
  if (!parts || !wall.isValid || wall.toFormat(format, { locale: 'en-US' }) !== local) {
    throw new SchemaError(PROVIDER, 'Shree Tirupati Courier returned an invalid booking time');
  }
  return wall.toUTC().toISO({ suppressMilliseconds: true });
}

/** A day the page prints as dd-mm-yy, as a local calendar day. */
function localDay(text: string): string {
  const parts = DAY.exec(text);
  const day = parts ? calendarDay(2000 + Number(parts[3]), Number(parts[2]), Number(parts[1])) : null;
  if (!day) throw new SchemaError(PROVIDER, 'Shree Tirupati Courier returned an invalid scan date');
  return day;
}

/** An office's name, without phone numbers; '' for none. */
function office(text: string | undefined): string {
  return clean((text ?? '').replace(PHONE, ''), 120);
}

/** A cell's text without its markup; the tooltips on office names hold addresses and phone numbers and are not read. */
function cellText(cell: Cheerio<Element>): string {
  const copy = cell.clone();
  copy.find('[alt]').removeAttr('alt');
  return clean(copy.text(), 400);
}

interface Row { event: CarrierEvent; day: string; order: number }

/**
 * One row of the tracking detail: the job, its day, and the route. An OUT row
 * is worded as the status line words it, "Out To" the next office, at the
 * office it left; an IN row "Received At" the office it reached.
 */
function projectRow($: CheerioAPI, row: Element, order: number): Row {
  const cells = $(row).children('td');
  if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Shree Tirupati Courier returned an incomplete scan');
  const job = clean(cells.eq(0).text(), 20).toUpperCase();
  if (!JOB.test(job)) throw new SchemaError(PROVIDER, 'Shree Tirupati Courier returned a scan without its job');
  const day = localDay(clean(cells.eq(1).text(), 20));
  const route = cellText(cells.eq(2));
  let description: string;
  let location: string;
  if (job === 'OUT' || job === 'IN') {
    const parts = (job === 'OUT' ? OUT_ROUTE : IN_ROUTE).exec(route);
    if (!parts) throw new SchemaError(PROVIDER, 'Shree Tirupati Courier returned a scan with an invalid route');
    const [at, next] = job === 'OUT' ? [office(parts[1]), office(parts[2])] : [office(parts[1]), ''];
    description = job === 'OUT' ? (next ? `Out To ${next}` : 'Out') : at ? `Received At ${at}` : 'Received';
    location = at;
  } else {
    // A job not seen yet keeps only its code: its route could name someone.
    description = job;
    location = '';
  }
  const staged = tirupatiStage(job, description);
  return {
    event: {
      local_time: day,
      ...(location ? { location } : {}),
      description,
      provider_code: job,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    day,
    order,
  };
}

/** The status line's own first line; the second gives the offices' phone numbers to call, which are not read. */
function statusLine(element: Cheerio<Element>): string {
  const copy = element.clone();
  copy.find('br').replaceWith('\n');
  const [first = ''] = copy.text().split('\n').map((line) => clean(line, 300)).filter(Boolean);
  return clean(first.replace(PHONE, ''), 200);
}

/**
 * The tracking detail `Frm_DocTrackWeb.aspx` shows for one encrypted number:
 * the booking (branch, destination, day and clock, consignee), the jobs
 * oldest first, and a status line over the offices' phone numbers. A number
 * it holds no booking for gets the same page with the number and every field
 * empty. A delivered consignment's page hides its jobs and keeps only the
 * booking and the status line. The page must name the number asked. The
 * destination, the consignee and the phone numbers are not kept.
 */
export function parseTirupati(html: string, raw: string): CarrierResult {
  const number = normalizeTirupatiNumber(raw);
  const $ = load(html);
  const shown = $('span#lblDocNumber');
  const filed = $('input#docNo');
  const status = $('span#lblStatus');
  const table = $('table#tblTrack');
  const fields = ['#txtFromCenter', '#txtToCenter', '#txtDate', '#txtReceiver'].map((id) => $(`span${id}`));
  if (shown.length !== 1 || status.length !== 1 || table.length !== 1 || fields.some((field) => field.length !== 1)) {
    unexpected(html, 'Shree Tirupati Courier returned a page without its tracking detail');
  }
  if (normalizeTrackingNumber(clean(shown.text(), 64)) !== number
    || (filed.length && normalizeTrackingNumber(clean(filed.attr('value'), 64)) !== number)) {
    throw new IndeterminateError(PROVIDER, 'Shree Tirupati Courier answered for another shipment');
  }

  const [from, to, booked, consignee] = fields.map((field) => clean(field.text(), 200)) as [string, string, string, string];
  const line = statusLine(status);
  const rows = table.find('tr').toArray().filter((row) => {
    const first = clean($(row).children('td').first().text(), 20);
    return first !== 'JOB';
  });
  if (!from && !to && !booked && !consignee && !line && !rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shree Tirupati Courier returned an oversized history');

  const seen = new Set<string>();
  const scans: Row[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow($, row, index);
    const key = JSON.stringify(scan.event);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  // The jobs are listed oldest first; newest first, a day's jobs keep their order.
  const events = scans.sort((a, b) => (a.day === b.day ? b.order - a.order : a.day < b.day ? 1 : -1)).map(({ event }) => event);

  // The status line repeats the newest job, and is the only trace of a delivery.
  const parts = STATUS_LINE.exec(line);
  if (parts) {
    const description = clean(parts[1], 120);
    const day = localDay(parts[2]!);
    const place = office(parts[3]);
    const newest = events[0];
    if (!(newest && newest.local_time === day && clean(newest.description, 200).toLowerCase() === description.toLowerCase())) {
      const staged = tirupatiStage(null, description);
      events.unshift({
        local_time: day,
        ...(place ? { location: place } : {}),
        description,
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      });
    }
  }
  if (booked) {
    const staged = tirupatiStage(null, 'Booked');
    events.push({
      time: bookingTime(booked),
      ...(office(from) ? { location: office(from) } : {}),
      description: 'Booked',
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }

  const summed = line ? tirupatiStage(null, parts ? clean(parts[1], 120) : line) : null;
  const newest = events[0];
  if (!newest) {
    if (!line) throw new NoHistoryError(PROVIDER);
    return {
      status: summed ? languageStageStatus(summed.stage) : 'unknown',
      ...(summed ? { current_stage: summed.stage, current_stage_source: summed.source } : {}),
      last_status_text: line,
      last_update: null,
      expected_delivery: null,
      timezone: ZONE,
      summary_only: true,
      events: [],
    };
  }
  const current = events.find((event) => event.stage);
  const stage = (summed?.stage ?? current?.stage) as Stage | undefined;
  const source = summed?.source ?? current?.stage_source;
  // A delivered consignment's page hides the jobs between its booking and its delivery.
  const hidden = /display\s*:\s*none/i.test($('table#Table1').attr('style') ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: line || newest.description!,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    timezone: ZONE,
    events: events.slice(0, MAX_EVENTS),
    ...(hidden || events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
