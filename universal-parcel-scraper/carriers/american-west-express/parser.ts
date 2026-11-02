import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { americanWestStage } from './status.js';

export const PROVIDER = 'American West';
// A page is about twenty kilobytes, most of it the page's own script.
export const AMERICAN_WEST_MAX_BYTES = 512 * 1024;

// A pro number as the tracker's archived lookups show it: two letters and seven digits.
const NUMBER = /^[A-Z]{2}\d{7}$/;
// The page's answer when it finds no shipment picked up in the past 90 days under the number.
const NO_RECORDS = 'no records found matching your criteria (try using a broader search)';
const REPORT = 'window.JSONReport = ';
// The condition the page's form keeps for its search.
const SEARCHED = /^shipment_info\.billno = '([A-Za-z0-9]{1,20})' ?$/;
// A day as the reply writes it: "02-26-2018".
const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
// The progress rail: how many steps are reached, then every step's label.
const RAIL = /^(\d):\[([^\]]{1,200})\]$/;
// A town and its state, with or without a comma: "SAMPLEVILLE CA", "SAMPLEVILLE, CA".
const PLACE = /^(\p{L}[\p{L} .'-]{0,59}?),? ([A-Z]{2})$/u;
// Firewall and bot check pages, which could stand in for the tracker's page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|g-recaptcha|h-captcha|requested URL was rejected|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
// The stages a shipment moves forward through, in order.
const FORWARD: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered'];
const MAX_ROWS = 50;

/**
 * The dated milestones of a row, in the order a shipment reaches them, with
 * the page's label for each. The day of the delivery appointment and the ETAs
 * are estimates, not milestones.
 */
const MILESTONES = [
  { code: 'pickup_date', label: 'Pickup', place: 'pickup_location' },
  { code: 'atadp', label: 'Arrived FinalMile Agent' },
  { code: 'first_contacted_date', label: '1st Call 2 Customer' },
  { code: 'ata_dest', label: 'Delivered To Customer', place: 'delivery_location' },
] as const;

/** An American West pro number in capitals; anything else is not one the adapter asks the tracker for. */
export function normalizeAmericanWestNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'American West pro numbers are two letters and seven digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field of the row; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`American West returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** "02-26-2018" as a calendar day; empty is none. The reply gives days without a clock. */
function dayOf(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key, 40);
  if (!value) return null;
  const match = DAY.exec(value);
  const day = match ? calendarDay(Number(match[3]), Number(match[1]), Number(match[2])) : null;
  if (!day) invalid(`American West returned an invalid ${key}`);
  return day;
}

/** A town and its state as "TOWN, ST"; anything else, which could carry a ZIP code, is not kept. */
function placeOf(row: Record<string, unknown>, key: string): string {
  const match = PLACE.exec(text(row, key, 80));
  return match ? `${match[1]}, ${match[2]}` : '';
}

/**
 * The object the page assigns to `window.JSONReport`, read up to its closing
 * brace. The page's own script then renders it.
 */
function reportOf(html: string): unknown {
  const at = html.indexOf(REPORT);
  if (at < 0) return undefined;
  const start = at + REPORT.length;
  if (html[start] !== '{') invalid('American West returned an unreadable report');
  let depth = 0;
  let quoted = false;
  for (let index = start; index < html.length && index < start + 200_000; index++) {
    const char = html[index];
    if (quoted) {
      if (char === '\\') index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1));
      } catch (cause) {
        throw new SchemaError(PROVIDER, 'American West returned an unreadable report', { cause });
      }
    }
  }
  return invalid('American West returned an unreadable report');
}

/**
 * The pro number the page searched for, from the condition it keeps in its
 * form, `shipment_info.billno = '{pro}' `, or null without one.
 */
function searchedOf($: CheerioAPI): string | null {
  const fields = $('input[name="sub_condition"]').toArray();
  if (fields.length !== 1) return null;
  let condition: string;
  try {
    condition = decodeURIComponent($(fields[0]).attr('value') ?? '');
  } catch {
    return null;
  }
  const match = SEARCHED.exec(condition);
  return match ? normalizeTrackingNumber(match[1]!) : null;
}

/** The rail's furthest reached step, as its label, or null when none is reached. */
function railStep(row: Record<string, unknown>): string | null {
  const value = text(row, 'timeline_dots', 240);
  if (!value) return null;
  const match = RAIL.exec(value);
  const labels = match ? match[2]!.split(',').map((label) => clean(label, 40)) : [];
  const reached = Number(match?.[1]);
  if (!match || labels.some((label) => !label) || reached > labels.length) invalid('American West returned an invalid progress rail');
  return reached ? labels[reached - 1]! : null;
}

/** The row's dated milestones, newest first; on one day, the further milestone first. */
function milestones(row: Record<string, unknown>): CarrierEvent[] {
  const dated = MILESTONES.flatMap((milestone, order) => {
    const day = dayOf(row, milestone.code);
    if (!day) return [];
    const location = 'place' in milestone ? placeOf(row, milestone.place) : '';
    const stage = americanWestStage(milestone.code, milestone.label);
    const event: CarrierEvent = {
      local_time: day,
      ...(location ? { location } : {}),
      description: milestone.label, provider_code: milestone.code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return [{ event, day, order }];
  });
  dated.sort((a, b) => (a.day === b.day ? b.order - a.order : a.day < b.day ? 1 : -1));
  return dated.map(({ event }) => event);
}

/** The shipment's row for the pro number asked, or what the page says instead. */
function rowOf(html: string, number: string): Record<string, unknown> {
  const report = reportOf(html);
  if (report === undefined) {
    const $ = load(html);
    const notices = $('td.global_errors').toArray().map((cell) => clean($(cell).text(), 300)).filter(Boolean);
    if (notices.length === 1 && notices[0] === NO_RECORDS) {
      if (searchedOf($) !== number) throw new IndeterminateError(PROVIDER, 'American West answered for another number');
      // An older shipment, one not picked up yet and an unknown number get the same answer.
      throw new IndeterminateError(PROVIDER, 'American West finds no shipment picked up in the past 90 days under the number',
        { reason: 'portal_not_found' });
    }
    if (notices.length) invalid('American West answered with a notice it does not usually give');
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'American West answered with a block page');
    if (!/I-Trek/.test($('title').text())) invalid('American West did not return its tracking page');
    invalid('American West returned its search page without an answer');
  }
  if (!isRecord(report) || report.success !== 1 || !Array.isArray(report.Rows)) invalid('American West returned an invalid report');
  const rows: unknown[] = report.Rows;
  if (rows.length > MAX_ROWS) invalid('American West returned an oversized report');
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'American West returned an empty report');
  // The page's lookup matches the whole pro number; a list, or a row for another number, is no answer.
  if (rows.length > 1 || report.TotalRowCount !== 1) throw new IndeterminateError(PROVIDER, 'American West answered with several shipments');
  const row = rows[0];
  if (!isRecord(row)) invalid('American West returned an invalid shipment');
  const found = normalizeTrackingNumber(text(row, 'billno', 64));
  if (!found) invalid('American West returned a shipment without its pro number');
  if (found !== number) throw new IndeterminateError(PROVIDER, 'American West answered for another shipment');
  return row;
}

/**
 * The I-Trek page `itrek.cgi?database=awest&type=submit&…&open_text={pro}&SearchOn=open_billno`
 * opens for one pro number. It assigns the shipment's row to
 * `window.JSONReport` (`{"success":1,"TotalRowCount":1,"Rows":[{…}]}`) for its
 * script to render: the pro number, the shipper's bill of lading and the
 * consignee's purchase order numbers, pieces and weight, the pickup's day and
 * town, the last town, the delivery town, the ETA to the final mile agent, the
 * arrival there, the first call to the customer, the delivery appointment's
 * day, the ETA to the customer, the delivery's day and the progress rail. Days
 * have no clock. A number it finds nothing under gets a notice that names no
 * number. The references, pieces, weight, last town and the ETA to the final
 * mile agent are not kept.
 */
export function parseAmericanWest(html: string, raw: string): CarrierResult {
  const number = normalizeAmericanWestNumber(raw);
  const row = rowOf(html, number);
  const events = milestones(row);
  const step = railStep(row);
  const railed = step ? americanWestStage(null, step) : undefined;
  if (!events.length && !step) throw new NoHistoryError(PROVIDER);

  // Milestones only add up, so the furthest dated one is the shipment's state, or the
  // rail's step when the rail is further on. A delivery settles the shipment.
  const rank = (stage: Stage | undefined) => (stage ? FORWARD.indexOf(stage) : -1);
  const furthest = events.reduce<CarrierEvent | undefined>((best, event) =>
    (rank(event.stage as Stage | undefined) > rank(best?.stage as Stage | undefined) ? event : best), undefined);
  const fromRail = railed !== undefined && rank(railed) > rank(furthest?.stage as Stage | undefined);
  const stage = fromRail ? railed : furthest?.stage as Stage | undefined;
  const newest = fromRail ? undefined : events[0];
  const settled = stage === 'delivered';
  // Until the delivery, the appointment's day, else the ETA to the customer; a day before the
  // newest milestone's is stale. The ETA to the final mile agent is the hub's, not the delivery's.
  const estimate = dayOf(row, 'appointment_date') ?? dayOf(row, 'deliver_by_date');
  const latest = events[0]?.local_time;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: fromRail ? step : newest?.description ?? step,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: !settled && estimate && !(latest && estimate < latest) ? estimate : null,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
