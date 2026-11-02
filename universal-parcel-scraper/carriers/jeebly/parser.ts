import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { jeeblyStage } from './status.js';

export const PROVIDER = 'Jeebly';
export const CARRIER = 'jeebly';
// A long history is under forty kilobytes.
export const JEEBLY_MAX_BYTES = 1024 * 1024;
/** The delivery services the tracking form offers, as it sends them, in the order the adapter asks. */
export const JEEBLY_SERVICES = ['Scheduled', 'Express', 'Moveo'] as const;
export type JeeblyService = (typeof JEEBLY_SERVICES)[number];

// `JB` and seven digits on the tracker; `JB` or `JBP` and six digits in Jeebly's API and webhook documentation.
const NUMBER = /^(?:JB\d{6,7}|JBP\d{6})$/;
const REFERENCE = /^Reference No\.?\s*(\S+)$/i;
const NO_SHIPMENT = /^No Shipment Found$/i;
// "18-Sep-26": the day, the month's abbreviation and the year's last two digits.
const DAY = /^(\d{2})-([A-Z][a-z]{2})-(\d{2})$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date such as 18-09-2026 stays.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|incapsula|imunify360|AwsWafIntegration/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Jeebly air waybill number, in upper case as the page sends it; anything else is not one Jeebly issues. */
export function normalizeJeeblyNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Jeebly air waybill numbers are JB and six or seven digits, or JBP and six digits');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

/** A `dd-Mon-yy` day and a `HH:mm` clock as a wall clock, or null. */
function wallClock(day: string, clock: string): string | null {
  const date = DAY.exec(day);
  const time = CLOCK.exec(clock);
  const month = date ? MONTHS.indexOf(date[2]!) + 1 : 0;
  if (!date || !time || !month || Number(time[1]) > 23 || Number(time[2]) > 59) return null;
  const calendar = calendarDay(2000 + Number(date[3]), month, Number(date[1]));
  return calendar ? `${calendar}T${time[1]}:${time[2]}:00` : null;
}

/** A scan's line, without phone numbers. */
function line(text: string): string {
  return clean(clean(text, 400).replace(PHONE, '').replace(/\s+([,;:.])/g, '$1')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

function scanOf(step: Cheerio<AnyNode>): CarrierEvent {
  const one = (selector: string) => {
    const found = step.find(selector);
    if (found.length !== 1) throw new SchemaError(PROVIDER, 'Jeebly returned an invalid scan');
    return clean(found.text(), 400);
  };
  const local = wallClock(one('.order-track-text-sub'), one('.order-track-text-time'));
  if (!local) throw new SchemaError(PROVIDER, 'Jeebly returned an invalid scan time');
  const status = clean(one('.order-track-text-stat'), 64);
  const description = line(one('.order-track-status-txt')) || status;
  if (!description) throw new SchemaError(PROVIDER, 'Jeebly returned a scan without wording');
  const staged = jeeblyStage(status, description);
  return {
    local_time: local,
    description,
    ...(status ? { provider_code: status } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The value of a line of the package card, such as `Delivery:`, or an empty string. */
function packageField($: CheerioAPI, label: string): string {
  const item = $('.shipping-details li').filter((_, element) => clean($(element).children('span').first().text(), 40) === `${label}:`);
  return item.length === 1 ? clean(clean(item.text(), 100).slice(label.length + 1), 60) : '';
}

/**
 * The tracker's page for one number and delivery service,
 * `/shipment-tracking/?uae=uae&service_type={service}&awb={number}`. The page
 * puts the number back in its search field and checks the service it was asked
 * for. Under the form, a shipment gets "Reference No." and the number, its
 * scans newest first, each a day and a clock, a status name and a line, then
 * cards with the pickup and drop-off names and addresses and the package's
 * details. A number the service does not know gets "No Shipment Found".
 *
 * The reference must be the whole number asked. The pickup and drop-off cards,
 * the payment type, the item type, the weight without a unit and the piece
 * count are not read; the service the page names under `Delivery` is.
 */
export function parseJeebly(html: string, raw: string, service: JeeblyService): CarrierResult {
  const number = normalizeJeeblyNumber(raw);
  const $ = load(html);
  const form = $('form[name="track_shipment"]');
  const section = $('section.order_tracking_page');
  if (form.length !== 1 || section.length !== 1) {
    if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Jeebly answered with a browser check');
    throw new SchemaError(PROVIDER, form.length ? 'Jeebly did not answer the lookup' : 'Jeebly returned an unexpected page');
  }
  // The search field and the checked service say what the page looked up.
  const asked = clean(form.find('input[name="awb"]').attr('value'), 64);
  const checked = form.find('input[name="service_type"][checked]');
  if (asked !== number || checked.length !== 1 || checked.attr('value') !== service) {
    throw new IndeterminateError(PROVIDER, 'Jeebly answered another lookup');
  }
  const track = section.find('.order-track');
  const heading = clean(track.children('p.references_number').first().text(), 80);
  if (track.length !== 1 || !heading) throw new SchemaError(PROVIDER, 'Jeebly returned an unexpected result');
  if (NO_SHIPMENT.test(heading)) throw new NotFoundError(PROVIDER);
  const reference = REFERENCE.exec(heading);
  if (!reference) throw new SchemaError(PROVIDER, 'Jeebly returned a shipment without its number');
  if (reference[1]!.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Jeebly answered for another shipment');

  const steps = track.find('.order-track-step');
  if (steps.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Jeebly returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  steps.each((_, element) => {
    const event = scanOf($(element));
    const key = JSON.stringify([event.local_time, event.provider_code, event.description]);
    if (seen.has(key)) return;
    seen.add(key);
    events.push(event);
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const staged = newestFirst.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const serviceName = packageField($, 'Delivery');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(serviceName ? { service_name: serviceName } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
