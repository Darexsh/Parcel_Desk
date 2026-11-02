import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { seflStage, seflWordingStage } from './status.js';

export const PROVIDER = 'Southeastern Freight Lines';
// A long history is a few kilobytes.
export const SEFL_MAX_BYTES = 256 * 1024;
// The tracer's own check: seven or nine digits, without the terminal code or a dash.
const NUMBER = /^(?:\d{7}|\d{9})$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// The reply's twelve-hour clock: hour 00 and hour 13 are no reading of it.
const CLOCK = /^(0?[1-9]|1[0-2]):([0-5]\d) ?([AP])M$/i;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;
const NOT_FOUND = /^The tracing information you requested for Pro Number (\S+) was not found in our system\.?$/i;
// Cloudflare's checks and block pages, which could stand in for the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|<title>\s*(?:Just a moment|Attention Required)/i;
// Who signed for a delivery, after its wording: "Delivered - Signed By: …".
const SIGNER = /\s*[-–,;]?\s*\b(?:Signed|Recvd|Received) By\s*:.*$/i;
const APPOINTMENT = /\bAppointment scheduled for (\d{2}\/\d{2}\/\d{4})\b/i;
const POUNDS = /^\d{1,7}(?:\.\d+)?$/;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;
// Stages after which no estimate is kept.
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

/** A PRO number as SEFL's tracer takes it: seven or nine digits; anything else is not one it issues. */
export function normalizeSeflNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Southeastern Freight Lines PRO numbers are seven or nine digits');
  return number;
}

function elements(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name && child.uri === '');
}

/** The one element of that name, if any; a repeated one is a changed reply. */
function element(node: XmlNode, name: string): XmlNode | undefined {
  const found = elements(node, name);
  if (found.length > 1) throw new SchemaError(PROVIDER, `Southeastern Freight Lines returned ${name} twice`);
  return found[0];
}

/** One text field; a field that nests elements is a changed reply. */
function text(node: XmlNode, name: string, maxLength = 200): string {
  const found = element(node, name);
  if (found?.children.length) throw new SchemaError(PROVIDER, `Southeastern Freight Lines returned an invalid ${name}`);
  return clean(found?.text ?? '', maxLength);
}

function dayOf(value: string): string | null {
  const match = DAY.exec(value);
  return match ? calendarDay(Number(match[3]), Number(match[1]), Number(match[2])) : null;
}

/**
 * A scan's clock: its date and twelve-hour time, with the offset the reply
 * gives each scan for its service center's zone. A time without an offset
 * stays a wall clock, and a date without a time a day.
 */
function clockOf(date: string, time: string, offset: string): { time?: string; local_time?: string } {
  const day = dayOf(date);
  if (!day) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned an invalid scan date');
  if (!time) return { local_time: day };
  const match = CLOCK.exec(time);
  if (!match) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned an invalid scan time');
  const hour = (Number(match[1]) % 12) + (match[3]!.toUpperCase() === 'P' ? 12 : 0);
  const wall = `${day}T${String(hour).padStart(2, '0')}:${match[2]}:00`;
  if (!offset) return { local_time: wall };
  const instant = OFFSET.test(offset) ? explicitOffsetTime(`${wall}${offset}`) : null;
  if (!instant) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned an invalid scan offset');
  return { time: instant.iso };
}

/** A scan's wording, without the name of whoever signed for a delivery. */
export function seflWording(message: string): string {
  return clean(message.replace(SIGNER, ''), 300);
}

/**
 * One scan: its clock, the service center's town and state (the center
 * itself when the reply names no town), the wording and its code. The
 * center's ZIP code is not kept.
 */
function scanOf(row: XmlNode): CarrierEvent {
  const description = seflWording(text(row, 'message', 500));
  if (!description) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned a scan without wording');
  const clock = clockOf(text(row, 'date', 16), text(row, 'time', 16), text(row, 'utcOffset', 8));
  const town = text(row, 'city', 80);
  const state = text(row, 'state', 8);
  const location = town && state ? `${town}, ${state}` : town || text(row, 'location', 80);
  const code = text(row, 'statusCode', 8).toUpperCase();
  const staged = seflStage(code, description);
  return {
    ...clock,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The shipment's weight in pounds, as kilograms. */
function weightKg(value: string): number | null {
  const pounds = POUNDS.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(pounds) && pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/**
 * The delivery day SEFL expects: an appointment's day when the status names
 * one, else the committed day. A day before the newest scan's is stale.
 */
function estimate(shipment: XmlNode, newestDay: string | null): string | null {
  const appointment = APPOINTMENT.exec(text(shipment, 'status', 500))?.[1];
  const day = dayOf(appointment ?? text(shipment, 'committedDate', 16));
  return day && !(newestDay && day < newestDay) ? day : null;
}

/** The wall day of a scan's clock, in its own zone. */
function dayOfScan(event: CarrierEvent | undefined): string | null {
  const clock = event?.time ?? event?.local_time;
  return typeof clock === 'string' ? clock.slice(0, 10) : null;
}

/**
 * The reply of SEFL's Web Connect tracing service for one PRO, in its XML
 * form, without a MySEFL login: the condensed shipment with its scans, oldest
 * first. An unknown PRO gets an `error` naming it. The shipper and consignee,
 * the pieces, the delay reason, the appointment's hours, the service centers'
 * phones and the interline fields are never read.
 */
export function parseSefl(xml: string, raw: string): CarrierResult {
  const pro = normalizeSeflNumber(raw);
  const root = xmlDocument(xml, SEFL_MAX_BYTES);
  if (!root || root.name !== 'root' || root.uri !== '') {
    if (CHALLENGE.test(xml.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Southeastern Freight Lines answered with a browser check');
    throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned a reply that is not its tracing document');
  }
  const errors = elements(root, 'error');
  const shipments = elements(root, 'pro');
  if (errors.length + shipments.length !== root.children.length || errors.length > 1 || (errors.length && shipments.length)) {
    throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned an unexpected tracing document');
  }
  if (errors.length) {
    if (errors[0]!.children.length) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned an invalid error');
    const named = NOT_FOUND.exec(clean(errors[0]!.text, 300))?.[1];
    if (named === pro) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, named ? 'Southeastern Freight Lines answered for another PRO' : 'Southeastern Freight Lines did not complete the lookup');
  }
  if (!shipments.length) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned no shipment');
  const numbers = shipments.map((shipment) => text(shipment, 'proNumber', 32));
  if (numbers.some((number) => !number)) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned a shipment without its PRO');
  const mine = shipments.filter((_, index) => numbers[index] === pro);
  if (!mine.length) throw new IndeterminateError(PROVIDER, 'Southeastern Freight Lines answered for another shipment');
  if (mine.length > 1) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned the PRO twice');
  const shipment = mine[0]!;

  const details = element(shipment, 'detailInformation');
  const rows = details ? elements(details, 'detail') : [];
  if (details && rows.length !== details.children.length) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned an unexpected history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Southeastern Freight Lines returned an oversized history');
  const seen = new Set<string>();
  // Newest first: the reply lists the scans oldest first.
  const events = rows.map(scanOf).filter((event) => {
    const key = JSON.stringify([event.time ?? event.local_time, event.provider_code, event.description, event.location]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();

  // "Delivered to Customer" in the shipment's location decides a delivery;
  // otherwise the newest scan with a stage does, else the location.
  const where = text(shipment, 'location', 120);
  const summary = where ? seflWordingStage(where) : undefined;
  const newest = events[0];
  if (!newest && !summary) throw new NoHistoryError(PROVIDER);
  const scanned = events.find((event) => event.stage);
  const delivered = summary === 'delivered';
  const stage = (delivered ? summary : scanned?.stage ?? summary) as Stage | undefined;
  const source = !scanned || (delivered && scanned.stage !== 'delivered') ? 'carrier_map' : scanned.stage_source;
  const delivery = delivered ? events.find((event) => event.stage === 'delivered') : undefined;
  // A delivery the history does not show yet keeps the location's wording.
  const shown = delivered ? delivery : newest;
  const weight = weightKg(text(shipment, 'weight', 16));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: shown?.description ?? where,
    last_update: newest?.time ?? null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: stage && FINAL.has(stage) ? null : estimate(shipment, dayOfScan(newest)),
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(newest ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
