import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { fmxStage } from './status.js';

export const PROVIDER = 'FMX';
export const CARRIER = 'fmx';
// A page is about 24 kB.
export const FMX_MAX_BYTES = 512 * 1024;

// MYX and ten digits, as its tracker and its app guide print them.
const NUMBER = /^MYX\d{10}$/;
// "2026-01-26 21:05:00": a wall clock with no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
// The whole heading the tracker shows, in place of a consignment, for a number it has no data for.
const PLACEHOLDER = '* Consignment Data Generated, Awaiting for Handover';
const NUMBER_LABEL = 'Tracking Number:';
const MAX_EVENTS = 200;

/** A number for FMX's tracker: MYX and ten digits. */
export function normalizeFmxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FMX consignment numbers are MYX and ten digits');
  return number;
}

type Selection = ReturnType<CheerioAPI>;

/** A row's wall clock, to the second. */
function wallClock(text: string): string {
  const parts = CLOCK.exec(text);
  if (parts) {
    const [year, month, day, hour, minute, second] = parts.slice(1).map(Number) as [number, number, number, number, number, number];
    const date = calendarDay(year, month, day);
    if (date && year >= 2000 && hour <= 23 && minute <= 59 && second <= 59) return `${date}T${parts[4]}:${parts[5]}:${parts[6]}`;
  }
  throw new SchemaError(PROVIDER, 'FMX returned an invalid scan time');
}

/** The numbers the page's language links reopen it for, which the tracker fills in from the request. */
function askedNumbers($: CheerioAPI): string[] {
  return $('a[href*="result_detail.php"]').toArray().flatMap((link) => {
    try {
      const asked = new URL($(link).attr('href') ?? '', 'https://www.fmx.asia/').searchParams.get('conno');
      return asked === null ? [] : [normalizeTrackingNumber(asked)];
    } catch {
      return [];
    }
  });
}

/**
 * The timeline, newest first: a time label above each scan, with the scan's
 * wording in its header and the station, its code and name, in its body.
 */
function eventsOf($: CheerioAPI, timeline: Selection): CarrierEvent[] {
  const children = timeline.children().toArray();
  const events: CarrierEvent[] = [];
  for (let at = 0; at < children.length; at += 1) {
    const label = $(children[at]);
    if (!label.hasClass('time-label')) {
      if (label.find('.timeline-item').length) throw new SchemaError(PROVIDER, 'FMX returned a scan without its time');
      continue;
    }
    const item = $(children[at + 1]).children('.timeline-item');
    if (item.length !== 1) throw new SchemaError(PROVIDER, 'FMX returned a time without its scan');
    at += 1;
    const description = clean(item.children('.timeline-header').text(), 300);
    if (!description) throw new SchemaError(PROVIDER, 'FMX returned a scan without wording');
    const location = clean(item.children('.timeline-body').text(), 200);
    const staged = fmxStage(description);
    events.push({
      local_time: wallClock(clean(label.text(), 40)),
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
    if (events.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'FMX returned an invalid history');
  }
  // Newest first; the page lists them so, and a stable sort keeps scans of one second in its order.
  return events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
}

/**
 * The tracker's page for one number, `/result_detail.php?p=1&conno=`, which
 * its server renders: a stage bar, a card with the destination town, the
 * consignment number, the shipper's two references, the pickup and delivery
 * dates and the signatory, and the timeline of scans. The card's number must
 * be the one asked. A number the tracker has no data for gets one heading,
 * "* Consignment Data Generated, Awaiting for Handover", and no card; the
 * page's language links must then carry the number asked. The stage bar, the
 * destination, the references, the dates and the signatory are not kept.
 */
export function parseFmx(html: string, raw: string): CarrierResult {
  const number = normalizeFmxNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FMX answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const labels = $('small').filter((_, label) => clean($(label).text(), 40) === NUMBER_LABEL);
  const timelines = $('div.timeline');

  if (!labels.length) {
    const headings = $('h2').toArray().map((heading) => clean($(heading).text(), 120));
    if (!headings.includes(PLACEHOLDER) || timelines.length) throw new SchemaError(PROVIDER, 'FMX returned a page without a consignment');
    const asked = askedNumbers($);
    if (!asked.length) throw new SchemaError(PROVIDER, 'FMX returned an unexpected page');
    if (asked.some((other) => other !== number)) throw new IndeterminateError(PROVIDER, 'FMX answered for another number');
    throw new NotFoundError(PROVIDER, 'FMX has no data for this consignment');
  }

  if (labels.length !== 1) throw new SchemaError(PROVIDER, 'FMX returned several consignments');
  if (timelines.length !== 1) throw new SchemaError(PROVIDER, 'FMX returned a consignment without its timeline');
  const shown = labels.closest('p').next('.des_1');
  if (shown.length !== 1 || !clean(shown.text(), 40)) throw new SchemaError(PROVIDER, 'FMX returned a consignment without its number');
  if (normalizeTrackingNumber(clean(shown.text(), 40)) !== number) throw new IndeterminateError(PROVIDER, 'FMX answered for another consignment');

  const events = eventsOf($, timelines);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}
