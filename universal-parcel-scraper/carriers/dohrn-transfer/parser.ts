import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { dohrnHiddenRow, dohrnLifecycleStage, dohrnStage, QUOTE_LIFECYCLE } from './status.js';

export const PROVIDER = 'Dohrn Transfer';
// A long history is a few kilobytes.
export const DOHRN_MAX_BYTES = 256 * 1024;

// The PROs the trace holds run from eight to ten digits. It reads a PRO as a
// number and drops leading zeros, so no PRO starts with 0.
const NUMBER = /^[1-9]\d{7,9}$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;
// The trace's answer for a PRO it does not hold: "Invalid pronumber 12345678".
const NOT_FOUND = /^Invalid pronumber(?: (\S+))?$/;
// The error page of Carrier Logistics' WebSpeed broker, for a lookup the tracker could not run.
const WEBSPEED = /WebSpeed error|WebSpeed Agent/i;
// Firewall and bot check pages, which could stand in for the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|requested URL was rejected|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
// A place as the history writes it, a town and its state: "Sturgeon, MO". Other
// remarks ("In Transit", "Customer Care Center", "Delivering Terminal") name none.
const PLACE = /^\p{L}[\p{L} .'-]{0,59}, [A-Z]{2}$/u;
// The day a delivery appointment is booked for: "Appointment Set: 10/18/21".
const APPOINTMENT = /^Appointment Set:\s*(\d{1,2})\/(\d{1,2})\/(\d{2})$/i;
const POUNDS = /^\d{1,6}(?:\.\d+)?$/;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_ROWS = 300;
// Stages the lifecycle settles over the newest row.
const SETTLED: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'exception']);
// Stages after which no estimate is kept.
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

/** A Dohrn PRO: eight to ten digits. Anything else is not one the trace is asked for. */
export function normalizeDohrnNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Dohrn PROs are eight to ten digits');
  return number;
}

function elements(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name && child.uri === '');
}

/** The one element of that name, if any; a repeated one is a changed reply. */
function element(node: XmlNode, name: string): XmlNode | undefined {
  const found = elements(node, name);
  if (found.length > 1) throw new SchemaError(PROVIDER, `Dohrn returned ${name} twice`);
  return found[0];
}

/** One text field; a field that nests elements is a changed reply. */
function text(node: XmlNode, name: string, maxLength = 200): string {
  const found = element(node, name);
  if (found?.children.length) throw new SchemaError(PROVIDER, `Dohrn returned an invalid ${name}`);
  return clean(found?.text ?? '', maxLength);
}

/** "2026-05-19" as a calendar day, or null when it is not a real one. */
function isoDay(value: string): string | null {
  const match = ISO_DAY.exec(value);
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * A row's date and 24-hour time as a wall clock. The trace gives no zone, and
 * a time without digits ("  :  ") leaves the day.
 */
function wallClock(date: string, time: string): string {
  const day = isoDay(date);
  if (!day) throw new SchemaError(PROVIDER, 'Dohrn returned an invalid history date');
  if (!/\d/.test(time)) return day;
  const match = TIME.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new SchemaError(PROVIDER, 'Dohrn returned an invalid history time');
  return `${day}T${match[1]}:${match[2]}:00`;
}

/** One history row: its clock, the wording and its place when the remark names one. */
function rowOf(row: XmlNode): CarrierEvent {
  const description = text(row, 'histcode', 300);
  if (!description) throw new SchemaError(PROVIDER, 'Dohrn returned a history row without its wording');
  const local_time = wallClock(text(row, 'histdate', 16), text(row, 'histtime', 16));
  const remark = text(row, 'histremarks', 120);
  const staged = dohrnStage(description);
  return {
    local_time,
    ...(PLACE.test(remark) ? { location: remark } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The history rows the tracking page shows, newest first and once each. */
function history(shipment: XmlNode): CarrierEvent[] {
  const list = element(shipment, 'shiphists');
  const rows = list ? elements(list, 'shiphist') : [];
  if (list && rows.length !== list.children.length) throw new SchemaError(PROVIDER, 'Dohrn returned an unexpected history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Dohrn returned an oversized history');
  const seen = new Set<string>();
  const events = rows.map(rowOf).filter((event) => {
    const key = JSON.stringify([event.local_time, event.description, event.location]);
    if (dohrnHiddenRow(event.description!) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The trace lists the newest first; a list the other way round is turned round.
  return events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time! ? events.reverse() : events;
}

/** The shipment's weight in pounds, as kilograms. */
function weightKg(value: string): number | null {
  const pounds = POUNDS.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(pounds) && pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/**
 * The day Dohrn expects to deliver: the trace's estimate, else the day of the
 * newest delivery appointment. A day before the newest row's is stale.
 */
function estimate(shipment: XmlNode, events: readonly CarrierEvent[]): string | null {
  const appointment = events.map((event) => APPOINTMENT.exec(event.description!)).find(Boolean);
  const day = isoDay(text(shipment, 'estdeliverydateiso', 16))
    ?? (appointment ? calendarDay(2000 + Number(appointment[3]), Number(appointment[1]), Number(appointment[2])) : null);
  const clock = events[0]?.local_time;
  const newest = typeof clock === 'string' ? clock.slice(0, 10) : null;
  return day && !(newest && day < newest) ? day : null;
}

/** The trace's error document: "Invalid pronumber" and the number is the only missing shipment. */
function failure(root: XmlNode, pro: string): never {
  const messages = elements(root, 'errormessage');
  if (messages.length !== 1 || root.children.length !== 1 || messages[0]!.children.length) {
    throw new SchemaError(PROVIDER, 'Dohrn returned an unexpected error document');
  }
  const match = NOT_FOUND.exec(clean(messages[0]!.text, 200));
  if (!match) throw new SchemaError(PROVIDER, 'Dohrn answered with an error it does not usually give');
  if (match[1] === pro) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'Dohrn answered for another PRO');
}

/**
 * The reply of Dohrn's XML trace (`protracexml.htm`) for one PRO, without a
 * login: the shipment with its lifecycle and its history, newest first, or an
 * error naming the number. The references, the terminals, the shipper's and
 * consignee's towns and ZIP codes, the pieces, the delivery's clock and
 * status, and the signer, whom the summary status also names, are never read.
 */
export function parseDohrn(xml: string, raw: string): CarrierResult {
  const pro = normalizeDohrnNumber(raw);
  const root = xmlDocument(xml, DOHRN_MAX_BYTES);
  if (!root || root.uri !== '' || !['protrace', 'error'].includes(root.name)) {
    const head = xml.slice(0, 64_000);
    if (CHALLENGE.test(head)) throw new ChallengeError(PROVIDER, 'Dohrn answered with a block page');
    if (WEBSPEED.test(head)) throw new IndeterminateError(PROVIDER, 'Dohrn’s tracker could not run the lookup');
    throw new SchemaError(PROVIDER, 'Dohrn returned a reply that is not its trace document');
  }
  if (root.name === 'error') failure(root, pro);

  const number = text(root, 'pronumb', 32);
  if (!number) throw new SchemaError(PROVIDER, 'Dohrn returned a shipment without its PRO');
  // A lookup that falls back to another reference names another shipment.
  if (number !== pro) throw new IndeterminateError(PROVIDER, 'Dohrn answered for another shipment');

  const code = text(root, 'lifecyclestatuscode', 8);
  const lifecycle = text(root, 'lifecycle', 80);
  // A rate quote shares the trace with shipments and has no freight behind it.
  if (code === QUOTE_LIFECYCLE || /^quote$/i.test(lifecycle)) throw new IndeterminateError(PROVIDER, 'Dohrn answered with a rate quote, not a shipment');
  const delivered = text(root, 'prodelivered', 8).toLowerCase() === 'yes';
  const headline: ClassifiedWording | null = dohrnLifecycleStage(code, lifecycle)
    ?? (delivered ? { stage: 'delivered', source: 'carrier_map' } : null);
  const events = history(root);
  if (!events.length && !headline) throw new NoHistoryError(PROVIDER);

  // The lifecycle settles a delivery, a return or a problem, and a shipment
  // without a staged row; otherwise the newest staged row is ahead of it.
  const scanned = events.find((event) => event.stage);
  const settled = headline !== null && (SETTLED.has(headline.stage) || !scanned);
  const decided = settled ? headline : scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : null;
  const newest = events[0];
  const shown = settled ? lifecycle || events.find((event) => event.stage === headline.stage)?.description || newest?.description
    : newest?.description;
  const weight = weightKg(text(root, 'weight', 16));
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: shown || null,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time! } : {}),
    expected_delivery: decided && FINAL.has(decided.stage) ? null : estimate(root, events),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
