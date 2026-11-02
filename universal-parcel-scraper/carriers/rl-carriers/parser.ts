import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { rlStage, rlSummaryStage } from './status.js';

export const PROVIDER = 'R+L Carriers';
// The result page is about 80 kB, most of it the site's own markup.
export const RL_MAX_BYTES = 512 * 1024;

// A PRO number as the tracer takes it: nine digits, or two letters and seven
// digits, the last digit a check digit.
const PRO = /^(?:[A-Z]{2}\d{7}|\d{9})$/;
// The tracer names every PRO with an `I` in front, and takes it so as well.
const NAMED_PRO = /^I(?:[A-Z]{2}\d{7}|\d{9})$/;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/;
// A day as ASP.NET writes it: midnight on the East Coast, in milliseconds.
const ASP_DATE = /^\/Date\((\d{1,15})\)\/$/;
const PICKED_UP = /^Picked Up in .+$/i;
const DEPARTED = /^Departed (.+?) in route to .+$/i;
const ARRIVED = /^Arrived at (.+)$/i;
const TERMINAL = /^(?:origin|destination) terminal$/i;
// A terminal's town and state, which the page writes with or without spaces around the comma.
const PLACE = /^([A-Z][A-Z .'-]*?) ?, ?([A-Z]{2})$/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;
const POUNDS_TO_KG = 0.453_592_37;
// How far along a shipment is, for weighing the summary's status against the history.
const PROGRESS: readonly Stage[] = ['accepted', 'in_transit', 'out_for_delivery', 'delivered'];
const NO_ESTIMATE: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

/** A PRO number as the tracer looks it up, without the `I` it names it with. */
export function normalizeRlNumber(raw: string): string {
  const compact = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const number = NAMED_PRO.test(compact) ? compact.slice(1) : compact;
  if (!PRO.test(number)) throw new InvalidInputError(PROVIDER, 'R+L Carriers PRO numbers are nine digits, or two letters and seven digits');
  return number;
}

/** An optional text field; any other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `R+L Carriers returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The shipments the page carries in its hidden `shipment_list` field, as JSON. */
function shipmentList(html: string): unknown {
  const field = load(html)('input#shipment_list');
  if (field.length !== 1) throw new SchemaError(PROVIDER, 'R+L Carriers returned a page without its shipment list');
  try {
    return JSON.parse(field.attr('value') ?? '');
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'R+L Carriers returned a shipment list that is not JSON', { cause });
  }
}

/** A row's wall clock, `MM/DD/YYYY` and `hh:mm:ss AM`, without an offset. */
function clockOf(date: string, time: string): string | null {
  const day = DATE.exec(date);
  const clock = TIME.exec(time);
  if (!day || !clock) return null;
  const iso = calendarDay(Number(day[3]), Number(day[1]), Number(day[2]));
  const hour = Number(clock[1]);
  if (!iso || hour < 1 || hour > 12 || Number(clock[2]) > 59 || Number(clock[3]) > 59) return null;
  const hours = String((hour % 12) + (clock[4] === 'PM' ? 12 : 0)).padStart(2, '0');
  return `${iso}T${hours}:${clock[2]}:${clock[3]}`;
}

/** A terminal's town as `TOWN, ST`; anything else, such as a place with digits, is left out. */
function placeOf(value: string): string | undefined {
  const match = PLACE.exec(value);
  return match ? `${match[1]}, ${match[2]}` : undefined;
}

/**
 * One history row. A pickup names the shipper's town, so it keeps neither the
 * town nor a location. A departure is located at the terminal it leaves and
 * an arrival at the one it reaches, unless the row names it only as the
 * origin or destination terminal.
 */
function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'R+L Carriers returned an invalid history row');
  const status = text(row, 'Status');
  const clock = clockOf(text(row, 'Date', 16), text(row, 'Time', 16));
  if (!status || !clock) throw new SchemaError(PROVIDER, 'R+L Carriers returned a history row without its status or clock');
  const description = PICKED_UP.test(status) ? 'Picked Up' : status;
  const departed = DEPARTED.exec(status)?.[1];
  const arrived = ARRIVED.exec(status)?.[1];
  const location = departed ? placeOf(departed) : arrived && !TERMINAL.test(arrived) ? placeOf(arrived) : undefined;
  const staged = rlStage(status);
  return { local_time: clock, description, ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/** The estimated delivery day the summary shows, while the shipment is still to be delivered. */
function expectedDay(value: string, stage: Stage | undefined): string | null {
  const match = ASP_DATE.exec(value);
  if (!match || (stage && NO_ESTIMATE.has(stage))) return null;
  const day = DateTime.fromMillis(Number(match[1]), { zone: 'America/New_York' });
  return day.isValid && day.hour === 0 && day.minute === 0 && day.second === 0 && day.millisecond === 0 ? day.toISODate() : null;
}

/** The further along of the history's stage and the summary's, which can be ahead of the rows. */
function currentStage(scan: CarrierEvent | undefined, summary: Stage | undefined): { stage: Stage; source: string } | undefined {
  const stage = scan?.stage as Stage | undefined;
  if (!summary) return stage ? { stage, source: scan!.stage_source! } : undefined;
  if (!stage) return { stage: summary, source: 'carrier_map' };
  const scanned = PROGRESS.indexOf(stage);
  // A row off the usual path, such as a return, stands unless the summary says delivered.
  const ahead = scanned < 0 ? summary === 'delivered' : PROGRESS.indexOf(summary) > scanned;
  return ahead ? { stage: summary, source: 'carrier_map' } : { stage, source: scan!.stage_source! };
}

/**
 * The result page of a PRO search. Its hidden `shipment_list` field holds one
 * entry per number searched: the summary (`Head`), the shipment's dates,
 * pieces and weight (`Detail`) and the history, oldest first, or an error
 * naming the number when R+L has no record of it. The entry also lists the
 * shipper, consignee and bill-to parties, the bill of lading number and the
 * shipment's documents; none of them is read.
 *
 * The tracer can answer a PRO search with another PRO's shipment; the result
 * then names that PRO as the canonical tracking number.
 */
export function parseRlCarriers(html: string, raw: string): CarrierResult {
  const number = normalizeRlNumber(raw);
  const list = shipmentList(html);
  if (!Array.isArray(list) || list.length !== 1 || !isRecord(list[0])) {
    throw new SchemaError(PROVIDER, 'R+L Carriers returned an unexpected shipment list');
  }
  const entry = list[0];
  const errors = entry.Errors ?? [];
  if (!Array.isArray(errors) || errors.length > 20 || !errors.every((error) => typeof error === 'string')) {
    throw new SchemaError(PROVIDER, 'R+L Carriers returned invalid lookup errors');
  }
  if (errors.length) {
    const messages = errors.map((error) => clean(error, 200));
    if (messages.length === 1 && messages[0] === `No records found for Number: I${number}`) throw new NotFoundError(PROVIDER);
    if (messages.some((message) => /^No records found for Number:/i.test(message))) {
      throw new SchemaError(PROVIDER, 'R+L Carriers answered for another number');
    }
    throw new IndeterminateError(PROVIDER, 'R+L Carriers could not look up the PRO number');
  }

  const head = entry.Head;
  if (!isRecord(head)) throw new SchemaError(PROVIDER, 'R+L Carriers returned a shipment without its summary');
  const named = text(head, 'ProNumber', 16);
  if (!NAMED_PRO.test(named)) throw new SchemaError(PROVIDER, 'R+L Carriers returned an invalid PRO number');
  const detail = entry.Detail ?? {};
  if (!isRecord(detail)) throw new SchemaError(PROVIDER, 'R+L Carriers returned invalid shipment details');
  const detailPro = text(detail, 'ProNumber', 16);
  if (detailPro && detailPro !== named) throw new SchemaError(PROVIDER, 'R+L Carriers returned the details of another PRO');
  const pro = named.slice(1);

  const rows = entry.History ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'R+L Carriers returned an invalid history');
  // Rows come oldest first. Their clocks have no offset, so the page's order
  // stands, read newest first; identical rows are kept once.
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of [...(rows as unknown[])].reverse()) {
    const event = scanOf(row);
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }

  const summary = text(head, 'Status', 100);
  const current = currentStage(events.find((event) => event.stage), rlSummaryStage(summary));
  if (!events.length && !current) throw new NoHistoryError(PROVIDER);
  const newest = events[0];
  const weight = detail.Weight;
  const weightKg = typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight < 1_000_000
    ? Math.round(weight * POUNDS_TO_KG * 1000) / 1000 : null;
  const service = text(head, 'ServiceType', 80);
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: newest?.description ?? summary,
    last_update: null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expectedDay(text(detail, 'DeliveryDate', 32), current?.stage),
    ...(service ? { service_name: service } : {}),
    ...(weightKg !== null ? { weight_kg: weightKg } : {}),
    ...(pro !== number ? { canonical_tracking_number: pro } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The messages the search page shows after a search it refused, which the
 * page's script holds as `ModelStateErrors`. Null when the page holds none.
 */
export function rlSearchErrors(html: string): string[] | null {
  const match = /const ModelStateErrors = Object\.freeze\((\[[^\]]{0,2000}\])\)/.exec(html);
  if (!match) return null;
  let errors: unknown;
  try {
    errors = JSON.parse(match[1]!);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'R+L Carriers returned unreadable search errors', { cause });
  }
  if (!Array.isArray(errors) || !errors.every((error) => typeof error === 'string')) {
    throw new SchemaError(PROVIDER, 'R+L Carriers returned invalid search errors');
  }
  return errors.map((error) => clean(error, 200));
}

/**
 * The search page after a refused search. R+L checks a PRO's check digit
 * before it looks the shipment up, and refuses one that fails it; any other
 * message, or none, says nothing about the number.
 */
export function parseRlRefusal(html: string, raw: string): never {
  const number = normalizeRlNumber(raw);
  const errors = rlSearchErrors(html);
  if (errors?.length === 1 && errors[0] === `${number}: Pro number failed check digit validation.`) {
    throw new InvalidInputError(PROVIDER, 'R+L Carriers says the PRO number fails its check digit', { reason: 'wrong_number' });
  }
  throw new IndeterminateError(PROVIDER, 'R+L Carriers refused the PRO search');
}
