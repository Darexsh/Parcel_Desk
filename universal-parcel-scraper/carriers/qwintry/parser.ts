import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { qwintryStage } from './status.js';

export const PROVIDER = 'Qwintry';
// A long history page is about twenty kilobytes.
export const QWINTRY_MAX_BYTES = 512 * 1024;
// The tracker's HTTP 404 page for a number it has no record of. Another 404 is a moved route.
export const QWINTRY_NOT_FOUND = /<h2>\s*This tracking does not exist\s*<\/h2>/i;

const QWINTRY = /^QR\d{8}$/;
const RUSSIAN_POST = /^[A-Z]{2}\d{9}RU$/;
const CLOCK = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/;
// The courier service's delivery estimate, which older histories put before each of its scans.
const PLANNED = /^Planned delivery date - (\d{4}-\d{2}-\d{2})\.\s*/;
// Qwintry's own scans and the courier service's in older histories name their place after the step.
const PLACE = /^(?:Arrival scan|Departure scan|Delivering|Delivered|Problem):\s*(.+)$/i;
// Russian Post's scans end with the office in brackets.
const OFFICE = /^(.*?)\s*\[([^\]]+)\]$/;
// A run of nine or more digits, with the separators phone numbers are written with.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;
const SUMMARY = /^Showing (\d+)-(\d+) of (\d+) items?\.?$/i;
// The trackers the page links for the local carrier's number, by host.
const PARTNERS: ReadonlyMap<string, string> = new Map([
  ['www.cdek.ru', 'cdek'],
  ['cdek.ru', 'cdek'],
  ['www.pochta.ru', 'russian-post'],
  ['pochta.ru', 'russian-post'],
]);
const LOCAL_NUMBER = /\btracking number:\s*([A-Z0-9]{4,40})\b/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/**
 * A number Qwintry's tracker reads, in capitals: its own `QR` and eight digits,
 * or the Russian Post number of a parcel it handed to the post.
 */
export function normalizeQwintryNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (QWINTRY.test(number) || (RUSSIAN_POST.test(number) && isValidS10TrackingNumber(number))) return number;
  throw new InvalidInputError(PROVIDER, 'Qwintry numbers are QR and eight digits, or a Russian Post number');
}

function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Qwintry answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** A scan's wall clock, to the second; the page names no zone. */
function scanClock(text: string): string {
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = CLOCK.test(text) ? DateTime.fromFormat(text, 'dd.MM.yyyy HH:mm:ss', { zone: 'UTC' }) : null;
  if (!parsed?.isValid || parsed.toFormat('dd.MM.yyyy HH:mm:ss') !== text) throw new SchemaError(PROVIDER, 'Qwintry returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

interface Scan { wall: string; index: number; key: string; planned?: string; event: CarrierEvent }

function projectRow($: CheerioAPI, row: Element, index: number): Scan {
  const cells = $(row).children('td');
  if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Qwintry returned an invalid scan');
  const wall = scanClock(clean(cells.eq(0).text(), 40));
  const code = clean(cells.eq(1).text(), 60);
  let message = clean(cells.eq(2).text(), 1000).replace(PHONE, '');
  const planned = PLANNED.exec(message);
  if (planned) message = message.slice(planned[0].length);
  let location = '';
  const place = PLACE.exec(message);
  if (place) {
    // The courier service's terminal code follows the town; Qwintry's hub is no place.
    location = place[1]!.replace(/\s*\[[^\]]*\]$/, '');
    if (/^consolidation hub$/i.test(location)) location = '';
  } else {
    const office = OFFICE.exec(message);
    if (office) [, message, location] = office as unknown as [string, string, string];
  }
  // A Russian Post scan without a line of its own is its operation.
  const description = clean(message, 300) || code;
  if (!description) throw new SchemaError(PROVIDER, 'Qwintry returned a scan without wording');
  location = clean(location, 120);
  const staged = qwintryStage(code, description);
  return { wall, index, key: JSON.stringify([wall, code, description, location]), ...(planned ? { planned: planned[1] } : {}), event: {
    local_time: wall,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** An estimate the page printed as a calendar day. */
function estimate(day: string | undefined): string | null {
  return day && DateTime.fromISO(day, { zone: 'UTC' }).isValid ? day : null;
}

/**
 * The local carrier the page names, when it links a tracker the catalog knows
 * for the number the page shows. A parcel Qwintry handed to Russian Post shows
 * no other number, and the link carries its own.
 */
function partnerHandoff($: CheerioAPI, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const notices = $('.user-area p.alert').filter((_, notice) => $(notice).find('a[href]').length > 0);
  if (notices.length !== 1) return {};
  const links = notices.find('a[href]');
  if (links.length !== 1) return {};
  let url: URL;
  try {
    url = new URL(links.attr('href')!);
  } catch {
    return {};
  }
  const carrier = ['https:', 'http:'].includes(url.protocol) ? PARTNERS.get(url.hostname.toLowerCase()) : undefined;
  if (!carrier) return {};
  const text = notices.clone();
  text.find('a').remove();
  const shown = LOCAL_NUMBER.exec(clean(text.text(), 400))?.[1]?.toUpperCase() ?? number;
  let carried: string[];
  try {
    carried = [...url.searchParams.values(), decodeURIComponent(url.hash.slice(1))].map((value) => normalizeTrackingNumber(value));
  } catch {
    return {};
  }
  return carried.includes(shown) ? { delivery_carrier: carrier, delivery_tracking_number: shown } : {};
}

/**
 * The tracker's page for one number, `/track?tracking=`. It names the number
 * over the history and lists the scans oldest first in a table: the clock,
 * the status code and the message. Once the parcel is booked with a local
 * carrier, a notice names that carrier and its number.
 */
export function parseQwintry(html: string, rawNumber: string): CarrierResult {
  const number = normalizeQwintryNumber(rawNumber);
  const $ = load(html);
  const headings = $('.user-area > h1');
  if (!headings.length) unexpected(html, 'Qwintry returned a page without the number');
  const heading = headings.first().clone();
  heading.children().remove();
  const named = normalizeTrackingNumber(clean(heading.text(), 64));
  if (!named) throw new SchemaError(PROVIDER, 'Qwintry returned a page without the number');
  if (named !== number) throw new IndeterminateError(PROVIDER, 'Qwintry answered for another shipment');

  const grids = $('.user-area .grid-view');
  const bodies = grids.children('table').children('tbody');
  if (grids.length !== 1 || bodies.length !== 1) throw new SchemaError(PROVIDER, 'Qwintry returned a page without a history');
  const rows = bodies.children('tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Qwintry returned an oversized history');
  // The grid writes one row with its empty notice when there are no scans.
  if (rows.length === 1 && $(rows[0]).find('td[colspan] .empty').length) throw new NoHistoryError(PROVIDER);

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow($, row, index);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // The grid pages a long history, and its first page holds the oldest scans.
  const summary = SUMMARY.exec(clean(grids.children('.summary').text(), 120));
  const partial = summary !== null && Number(summary[2]) - Number(summary[1]) + 1 < Number(summary[3]);

  // Newest first by wall clock; scans of the same second take the later row first.
  const ordered = scans.sort((left, right) => right.wall.localeCompare(left.wall) || right.index - left.index);
  const events = ordered.map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const ended = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: ended ? null : estimate(ordered.find((scan) => scan.planned)?.planned),
    ...partnerHandoff($, number),
    events: events.slice(0, MAX_EVENTS),
    ...(partial || events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
