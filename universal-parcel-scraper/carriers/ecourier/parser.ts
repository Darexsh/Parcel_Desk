import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { ecourierStage } from './status.js';

export const PROVIDER = 'eCourier';
// The tracking page is about fifty kilobytes with its history.
export const ECOURIER_MAX_BYTES = 1024 * 1024;

// The tracking form's check is ECR or BL and eleven characters or more. ECR
// IDs have digits after the prefix; no BL ID has been published.
const NUMBER = /^(?:ECR\d{8,20}|BL[A-Z0-9]{9,30})$/;
// Bangladesh keeps one zone, without daylight saving time.
const ZONE = 'Asia/Dhaka';
// A day heading, as "Tuesday, March 3 2026", and a scan's minute, as "2:05 pm".
const DAY = /^[A-Z][a-z]+, [A-Z][a-z]+ \d{1,2} \d{4}$/;
const MINUTE = /^(?:0?[1-9]|1[0-2]):[0-5]\d [ap]m$/i;
const CLOCK_FORMAT = 'cccc, LLLL d yyyy h:mm a';
// A scan's detail line, as "Location: Uttara Branch (D7) - Dhaka".
const DETAIL = /^(Name|Location|Group)\s*:\s*(.*)$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Bot checks and block pages a CDN or firewall could put in place of the page.
const BLOCKED = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)/i;
const MAX_DAYS = 200;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An eCourier ID as its tracking form takes it, in capitals; anything else is not one eCourier issues. */
export function normalizeEcourierNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'eCourier IDs are ECR followed by digits, or start with BL');
  return number;
}

/** Text without phone numbers. */
function scrubbed(text: string, maxLength: number): string {
  return clean(text.replace(PHONE, '').replace(/\s+\)/g, ')').replace(/\(\)/g, ''), maxLength).replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

/** A scan's wall clock in Dhaka time, from its day heading and its minute. */
function scanClock(day: string, minute: string): { time: string; at: number } {
  if (!DAY.test(day) || !MINUTE.test(minute)) throw new SchemaError(PROVIDER, 'eCourier returned an invalid scan time');
  const zoned = firstOccurrence(DateTime.fromFormat(`${day} ${minute}`, CLOCK_FORMAT, { zone: ZONE, locale: 'en-US' }));
  // Luxon refuses a weekday that does not fall on the date.
  if (!zoned.isValid) throw new SchemaError(PROVIDER, 'eCourier returned an invalid scan time');
  return { time: zoned.toISO({ suppressMilliseconds: true }), at: zoned.toMillis() };
}

/**
 * The lines under a scan's status, split at its line breaks: "Name: …",
 * "Location: …" and "Group: …". The page writes the label inside or outside
 * the bold value depending on the day.
 */
function details($: CheerioAPI, box: Cheerio<Element>, status: Element): Map<string, string> {
  const lines = [''];
  box.contents().each((_, node) => {
    if (node === status) return;
    if ($(node).is('br')) lines.push('');
    else lines[lines.length - 1] += $(node).text();
  });
  const found = new Map<string, string>();
  for (const line of lines) {
    const match = DETAIL.exec(clean(line, 400));
    if (match && !found.has(match[1]!.toLowerCase())) found.set(match[1]!.toLowerCase(), match[2]!);
  }
  return found;
}

interface Scan { event: CarrierEvent; at: number; order: number }

/**
 * One scan: its status in bold, its minute and its location. The staff
 * member or rider it names, with their phone number, and the group they
 * belong to are not kept.
 */
function scanOf($: CheerioAPI, row: Element, day: string, order: number): Scan {
  const minute = clean($(row).children('h4').first().text(), 20);
  const box = $(row).children('div').first();
  const status = box.children('b').first();
  const description = scrubbed(status.text(), 200);
  if (!box.length || !status.length || !description) throw new SchemaError(PROVIDER, 'eCourier returned a scan without its status');
  const when = scanClock(day, minute);
  const location = scrubbed(details($, box, status[0]!).get('location') ?? '', 160);
  const staged = ecourierStage(description);
  return {
    event: {
      time: when.time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    at: when.at, order,
  };
}

/** The scans, newest first, once each: the page lists some twice. */
function history($: CheerioAPI, content: Cheerio<Element>): CarrierEvent[] {
  const days = content.find('.track-info > ul > li').toArray();
  if (days.length > MAX_DAYS) throw new SchemaError(PROVIDER, 'eCourier returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  let order = 0;
  for (const day of days) {
    // The day is the group's own text, before its list of scans.
    const heading = clean($(day).contents().filter((_, node) => node.nodeType === 3).text(), 60);
    for (const row of $(day).children('ul').children('li').toArray()) {
      if (order >= MAX_ROWS) throw new SchemaError(PROVIDER, 'eCourier returned an oversized history');
      const scan = scanOf($, row, heading, order++);
      const identity = JSON.stringify([scan.event.time, scan.event.description, scan.event.location ?? '']);
      if (seen.has(identity)) continue;
      seen.add(identity);
      scans.push(scan);
    }
  }
  // The page lists the scans newest first; a tie keeps its order.
  return scans.sort((a, b) => b.at - a.at || a.order - b.order).map(({ event }) => event);
}

/** A value of the package information list, by its label. */
function info($: CheerioAPI, content: Cheerio<Element>, label: string): string {
  const item = content.find('.track-order-info li').toArray()
    .find((li) => clean($(li).children('span').first().text(), 80).toLowerCase() === label);
  if (!item) return '';
  const copy = $(item).clone();
  copy.children('span').first().remove();
  return clean(copy.text(), 80);
}

/**
 * eCourier's tracking page for one ID. A known parcel gets its package
 * information, naming the ID, and its scans grouped by day; an unknown one
 * gets "No Result Found" in its place.
 */
export function parseEcourier(html: string, raw: string): CarrierResult {
  const number = normalizeEcourierNumber(raw);
  const $ = load(html);
  const section = $('section.track');
  const content = section.find('.track-content');
  if (!content.length) {
    if (/^No Result Found$/i.test(clean(section.find('.track-not-found h3').text(), 80))) throw new NotFoundError(PROVIDER);
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'eCourier answered with a block page');
    throw new SchemaError(PROVIDER, 'eCourier did not return a tracking result');
  }
  if (content.length !== 1) throw new SchemaError(PROVIDER, 'eCourier returned several tracking results');
  const shown = clean(content.find('.track-content-heading h4 strong').first().text(), 80);
  if (!shown) throw new SchemaError(PROVIDER, 'eCourier returned a result without its ID');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'eCourier answered for another ID');

  const events = history($, content);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const service = info($, content, 'delivery type');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(stage === 'delivered' ? { delivered_at: current!.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
