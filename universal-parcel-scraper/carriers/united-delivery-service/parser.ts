import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { udsMappedStage } from './status.js';

export const PROVIDER = 'United Delivery Service';
// A page is about 25 kB, most of it style rules.
export const UDS_MAX_BYTES = 256 * 1024;
export const UDS_ZONE = 'America/Chicago';
// UDS's own labels and the shippers' barcodes and references it tracks them
// by: letters and digits, with at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{10,40}$/;
const NOT_FOUND = 'Barcode Not Found';
const ABSENT = /^This tracking number: (\S+) cannot be found$/i;
// The plain page's notice: "Barcode 42UDS… Not Found", then its advice.
const PLAIN_ABSENT = /^Barcode (\S+) Not Found/;
// A firewall's or bot check's page in place of the tracker's.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha/i;
const MAX_STEPS = 12;
const POUNDS_TO_KG = 0.453_592_37;

/** A barcode as the tracker takes it; anything else is not one UDS tracks. */
export function normalizeUdsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'UDS barcodes are ten to forty letters and digits');
  return number;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The offset each name the page gives its clocks stands for. */
const CENTRAL_OFFSETS: Readonly<Record<string, string>> = { CDT: '-05:00', CST: '-06:00' };
// "2026-05-29 - 01:16:53 PM CDT"; the former page wrote "2020-06-29 - 7:33 AM".
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) - (\d{1,2}):([0-5]\d)(?::([0-5]\d))? ([AP]M)(?: (C[DS]T))?$/;

/**
 * A scan's clock: an instant when the page names the offset Chicago keeps at
 * that wall clock, which also tells the repeated autumn hour apart, else the
 * wall clock alone.
 */
function clockOf(text: string): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  const hour12 = match ? Number(match[4]) : 0;
  if (!match || !day || hour12 < 1 || hour12 > 12) throw new SchemaError(PROVIDER, 'UDS returned an invalid scan time');
  const wall = `${day}T${pad((hour12 % 12) + (match[7] === 'PM' ? 12 : 0))}:${match[5]}:${match[6] ?? '00'}`;
  const offset = CENTRAL_OFFSETS[match[8] ?? ''];
  if (offset && DateTime.fromISO(`${wall}${offset}`).setZone(UDS_ZONE).toISO({ includeOffset: false, suppressMilliseconds: true }) === wall) {
    return { time: `${wall}${offset}` };
  }
  return { local_time: wall };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Wed, Apr 1 by 8:00 PM": a weekday, a month and a day, without a year, and the latest clock.
const ESTIMATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),? (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?: by \d{1,2}:[0-5]\d [AP]M)?$/i;
// An estimate further than this from the lookup is no estimate for this parcel.
const ESTIMATE_DAYS = 45;
const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/**
 * The delivery day of the estimate card. The year is the one, around the day
 * of the lookup in Chicago, on which that day falls on the weekday shown.
 */
function estimatedDay(text: string, now: number): string | null {
  const match = ESTIMATE.exec(text);
  if (!match) return null;
  const weekday = WEEKDAYS.indexOf(title(match[1]!)) + 1;
  const month = MONTHS.indexOf(title(match[2]!)) + 1;
  const today = DateTime.fromISO(DateTime.fromMillis(now).setZone(UDS_ZONE).toISODate()!, { zone: 'UTC' });
  const days = [today.year - 1, today.year, today.year + 1]
    .map((year) => calendarDay(year, month, Number(match[3])))
    .filter((day): day is string => day !== null)
    .map((day) => ({ day, date: DateTime.fromISO(day, { zone: 'UTC' }) }))
    .filter(({ date }) => date.weekday === weekday && Math.abs(date.diff(today, 'days').days) <= ESTIMATE_DAYS);
  return days.length === 1 ? days[0]!.day : null;
}

/** The parcel's weight and size from the "Shipment Facts" list, when it gives them. */
function facts($: CheerioAPI): Pick<CarrierResult, 'weight_kg' | 'dimensions_text'> {
  const result: Pick<CarrierResult, 'weight_kg' | 'dimensions_text'> = {};
  $('ul.uds-facts > li').each((_, node) => {
    const label = clean($(node).clone().children().remove().end().text(), 80);
    const value = clean($(node).children('strong').text(), 80);
    const pounds = /^(\d{1,5}(?:\.\d{1,3})?) lbs?$/i.exec(value);
    if (/^Package Weight:$/i.test(label) && pounds && Number(pounds[1]) > 0) {
      result.weight_kg = Math.round(Number(pounds[1]) * POUNDS_TO_KG * 1000) / 1000;
    }
    if (/^Dimensions\b/i.test(label) && /^\d{1,4}(?:\.\d{1,2})? × \d{1,4}(?:\.\d{1,2})? × \d{1,4}(?:\.\d{1,2})? in$/.test(value)) {
      result.dimensions_text = value;
    }
  });
  return result;
}

/** The scan the current step names: its place on the first line, its clock on the last. */
function scanOf(step: Cheerio<AnyNode>, wording: string): CarrierEvent | null {
  const meta = step.children('.m');
  if (meta.length > 1) throw new SchemaError(PROVIDER, 'UDS tracking page changed');
  if (!meta.length) return null;
  const lines = (meta.html() ?? '').split(/<br\s*\/?>/i).map((line) => textFromHtml(line, 200)).filter(Boolean);
  if (!lines.length || lines.length > 2) throw new SchemaError(PROVIDER, 'UDS returned an invalid scan');
  const location = lines.length === 2 ? lines[0]! : '';
  const staged = stageOf(wording);
  return {
    ...clockOf(lines.at(-1)!),
    ...(location ? { location } : {}),
    description: wording,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** A wording's stage from the map, else from the shared rules. */
function stageOf(...wordings: string[]): ClassifiedWording | null {
  for (const wording of wordings) {
    const mapped = wording ? udsMappedStage(wording) : undefined;
    if (mapped) return { stage: mapped, source: 'carrier_map' };
  }
  for (const wording of wordings) {
    const worded = wording ? classifyWording(wording, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

/**
 * The tracker's page for one barcode, rendered on the server. It shows the
 * parcel's status, the barcode, a rail of four steps of which only the
 * current one has a place and a clock, a delivery estimate before delivery,
 * the parcel's weight and size, and proof-of-delivery details. A barcode it
 * does not hold gets "Barcode Not Found" and a notice naming the number, or
 * the tracker's plain page, whose notice names it the same way.
 */
export function parseUds(html: string, raw: string, now = Date.now()): CarrierResult {
  const number = normalizeUdsNumber(raw);
  const $ = load(html);
  const heading = $('.uds-udsFormat-statusCenter > .value');
  const plain = heading.length ? null : $('#errors');
  if (plain?.length === 1) {
    const absent = PLAIN_ABSENT.exec(clean(plain.text(), 300));
    if (!absent) throw new SchemaError(PROVIDER, 'UDS returned its plain page without its notice');
    if (normalizeTrackingNumber(absent[1]!) !== number) throw new IndeterminateError(PROVIDER, 'UDS answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (heading.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'UDS answered with a CAPTCHA or block page');
    throw new SchemaError(PROVIDER, 'UDS did not return a tracking page');
  }
  const status = clean(heading.text(), 80);
  if (status === NOT_FOUND) {
    const notice = $('.uds-alert h2');
    const absent = notice.length === 1 ? ABSENT.exec(clean(notice.text(), 200)) : null;
    if (!absent) throw new SchemaError(PROVIDER, 'UDS returned a not-found page without its notice');
    if (normalizeTrackingNumber(absent[1]!) !== number) throw new IndeterminateError(PROVIDER, 'UDS answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (!status) throw new SchemaError(PROVIDER, 'UDS returned a page without a status');
  const shown = $('.uds-udsFormat-right .rid > .v');
  if (shown.length !== 1) throw new SchemaError(PROVIDER, 'UDS returned a page without its barcode');
  if (normalizeTrackingNumber(clean(shown.text(), 80)) !== number) throw new IndeterminateError(PROVIDER, 'UDS answered for another number');
  const steps = $('.uds-udsFormat-tl > .uds-udsFormat-step');
  const current = steps.filter('.current');
  if (!steps.length || steps.length > MAX_STEPS || current.length > 1) throw new SchemaError(PROVIDER, 'UDS tracking page changed');
  const step = current.length ? clean(current.children('.t').text(), 120) : '';
  if (current.length && !step) throw new SchemaError(PROVIDER, 'UDS returned a step without its title');

  const scan = current.length ? scanOf(current, step) : null;
  // The status heading first: it can name a delay or a return the rail does not show.
  const staged = stageOf(status, step);
  const stage = staged?.stage;
  const estimate = stage === 'delivered' ? null : estimatedDay(clean($('.uds-udsFormat-etaLine').first().text(), 80), now);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: status,
    last_update: scan?.time ?? null,
    ...(scan?.local_time ? { last_update_local: scan.local_time } : {}),
    expected_delivery: estimate,
    ...(stage === 'delivered' && scan?.stage === 'delivered' && scan.time ? { delivered_at: scan.time } : {}),
    ...facts($),
    // The rail's earlier steps have no clock: the page shows no history.
    summary_only: true,
    events: scan ? [scan] : [],
  };
}
