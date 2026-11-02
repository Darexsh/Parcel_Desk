import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { mainfreightMappedStage, mainfreightStage, placedWording } from './status.js';

export const PROVIDER = 'Mainfreight';
// A shipment is a few kilobytes; a search for a common reference lists a few dozen.
export const MAINFREIGHT_MAX_BYTES = 1_000_000;

const MAX_RESULTS = 500;
const MAX_ROWS = 500;
const NUMBER = /^[A-Z0-9]{4,40}$/;
// A shipment's address on the tracker: its service's code, then Mainfreight's own number.
const PATH = /^([A-Za-z]{2,10})\/([A-Za-z0-9]{1,40})$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /_Incapsula_Resource|Incapsula incident|Request unsuccessful|<title>\s*(?:Access Denied|Attention Required|Just a moment)|_cf_chl_opt|cf-turnstile|captcha/i;

// An hour on a twelve-hour clock ("10:01 AM") or a 24-hour one ("17:52").
const CLOCK = '(?:(?:1[0-2]|0?[1-9]):[0-5]\\d [AP]M|(?:[01]?\\d|2[0-3]):[0-5]\\d)';
// "24 November 2020, 10:01 AM", in a zone ("… AEDT"), on a 24-hour clock ("… 10:00"), or a day alone.
const STAMP = new RegExp(`^(\\d{1,2} [A-Za-z]+ \\d{4})(?:, (${CLOCK})(?: ([A-Z]{2,5}))?)?$`);
// Air and ocean rows give the hour, which can be empty, then the day with whether it is planned.
const HOUR = new RegExp(`^(?:${CLOCK})?$`);
const DAY = /^(\d{1,2} [A-Za-z]+ \d{4})(?: \((Actual|Estimated)\))?$/;
// "CHRISTCHURCH to WELLINGTON", or " to " with neither end: a leg, not a place.
const LEG = /(?:^|\s)to(?:\s|$)/i;

/**
 * The zones the transport services name after a scan's clock, and their
 * offsets. A clock in another zone, or in none, stays a wall clock.
 */
const OFFSETS: Readonly<Record<string, string>> = {
  NZST: '+12:00', NZDT: '+13:00',
  AEST: '+10:00', AEDT: '+11:00', ACST: '+09:30', ACDT: '+10:30', AWST: '+08:00',
  EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00', MST: '-07:00', MDT: '-06:00',
  PST: '-08:00', PDT: '-07:00', AKST: '-09:00', AKDT: '-08:00', HST: '-10:00',
};

/** A shipment on the tracker: its service's code and Mainfreight's own number for it. */
export interface MainfreightShipment {
  code: string;
  reference: string;
}

/**
 * The tracker's search takes consignment, job and house bill numbers and the
 * sender's references, of three or more characters. The adapter takes four to
 * forty letters and digits.
 */
export function normalizeMainfreightNumber(raw: string): string {
  const number = raw.length <= 80 ? normalizeTrackingNumber(raw) : '';
  if (NUMBER.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Mainfreight tracks numbers of four to forty letters and digits');
}

/** A reply's JSON. Anything else is a block page or a changed service. */
export function mainfreightJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Mainfreight answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Mainfreight returned a reply that is not JSON', { cause });
  }
}

/** A search's entries: the address each lists, if it has one, and the reference it shows. */
function listedEntries(reply: unknown): { shipment: MainfreightShipment | null; reference: string }[] {
  if (!Array.isArray(reply) || reply.length > MAX_RESULTS) throw new SchemaError(PROVIDER, 'Mainfreight returned an invalid search reply');
  return reply.map((entry) => {
    if (!isRecord(entry) || typeof entry.url !== 'string') throw new SchemaError(PROVIDER, 'Mainfreight returned an invalid search result');
    const path = PATH.exec(entry.url.trim());
    const reference = typeof entry.reference === 'string' && entry.reference.length <= 80 ? normalizeTrackingNumber(entry.reference.trim()) : '';
    return { shipment: path ? { code: path[1]!.toUpperCase(), reference: path[2]!.toUpperCase() } : null, reference };
  });
}

/**
 * The one shipment the search lists under the whole number: the one whose own
 * number it is, else the one that carries it as its reference. The search
 * also matches other fields, so other entries are left out. Null when none
 * does; several are no answer.
 */
export function searchedShipment(reply: unknown, number: string): MainfreightShipment | null {
  const own = new Map<string, MainfreightShipment>();
  const referenced = new Map<string, MainfreightShipment>();
  for (const { shipment, reference } of listedEntries(reply)) {
    const tail = shipment?.reference ?? '';
    if (tail !== number && reference !== number) continue;
    if (!shipment) throw new SchemaError(PROVIDER, 'Mainfreight listed a shipment without its address');
    (tail === number ? own : referenced).set(`${shipment.code}/${shipment.reference}`, shipment);
  }
  const matches = own.size ? own : referenced;
  if (matches.size > 1) throw new IndeterminateError(PROVIDER, 'Several Mainfreight shipments carry this number');
  return [...matches.values()][0] ?? null;
}

/**
 * The air and ocean jobs a search lists. The search also finds a job by its
 * master bill, but lists it under its job number and house bill.
 */
export function listedJobs(reply: unknown): MainfreightShipment[] {
  const jobs = new Map<string, MainfreightShipment>();
  for (const { shipment } of listedEntries(reply)) {
    if (shipment?.code === 'CW') jobs.set(shipment.reference, shipment);
  }
  return [...jobs.values()];
}

/**
 * The master bills Mainfreight's app gives for the job at `at`: an air
 * waybill's eleven digits, or an ocean master bill of lading. Null when the app
 * does not know the job. The reply also lists the job's other references and
 * its parties, which are not read.
 */
export function masterBillsOf(reply: unknown, at: MainfreightShipment): string[] | null {
  if (!isRecord(reply) || typeof reply.success !== 'boolean') throw new SchemaError(PROVIDER, 'Mainfreight\'s app returned an invalid reply');
  if (!reply.success) return null;
  const document = isRecord(reply.document) && isRecord(reply.document.document) ? reply.document.document : null;
  if (!document || !Array.isArray(document.references) || document.references.length > MAX_ROWS) {
    throw new SchemaError(PROVIDER, 'Mainfreight\'s app returned an invalid shipment');
  }
  if (typeof document.shortCode !== 'string' || document.shortCode.trim().toUpperCase() !== at.code
    || typeof document.primaryReference !== 'string' || document.primaryReference.length > 80
    || normalizeTrackingNumber(document.primaryReference.trim()) !== at.reference) {
    throw new SchemaError(PROVIDER, 'Mainfreight answered for a different shipment');
  }
  return document.references.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.type !== 'string') throw new SchemaError(PROVIDER, 'Mainfreight\'s app returned an invalid reference');
    if (entry.type !== 'MasterBillNumber') return [];
    if (typeof entry.reference !== 'string' || entry.reference.length > 80) {
      throw new SchemaError(PROVIDER, 'Mainfreight\'s app returned an invalid reference');
    }
    const bill = normalizeTrackingNumber(entry.reference.trim());
    return bill ? [bill] : [];
  });
}

interface Clock {
  at: { time: string } | { local_time: string };
  planned: boolean;
  rest: string[];
}

/** A day and an hour on a wall clock, checked against the calendar; a day alone stays a date. */
function wallClock(day: string, hour: string): string {
  const format = !hour ? 'd MMMM yyyy' : /[AP]M$/.test(hour) ? 'd MMMM yyyy h:mm a' : 'd MMMM yyyy H:mm';
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = DateTime.fromFormat(hour ? `${day} ${hour}` : day, format, { zone: 'UTC', locale: 'en-US' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'Mainfreight returned an invalid scan time');
  return parsed.toFormat(hour ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
}

/**
 * A row's clock and the values after it. A transport scan's clock names its
 * zone, which gives the instant; the others are the scanning site's wall clock.
 */
function clockOf(values: readonly string[]): Clock {
  const planned = values.length >= 2 && HOUR.test(values[0]!) ? DAY.exec(values[1]!) : null;
  if (planned) {
    return { at: { local_time: wallClock(planned[1]!, values[0]!) }, planned: planned[2] === 'Estimated', rest: values.slice(2) };
  }
  const stamp = STAMP.exec(values[0] ?? '');
  if (!stamp) throw new SchemaError(PROVIDER, 'Mainfreight returned an invalid scan time');
  const wall = wallClock(stamp[1]!, stamp[2] ?? '');
  const offset = stamp[3] && Object.hasOwn(OFFSETS, stamp[3]) ? OFFSETS[stamp[3]] : undefined;
  return { at: offset ? { time: `${wall}${offset}` } : { local_time: wall }, planned: false, rest: values.slice(1) };
}

function textOf(value: unknown, part: string, maxLength = 200): string {
  if (value !== null && value !== undefined && typeof value !== 'string') throw new SchemaError(PROVIDER, `Mainfreight returned an invalid ${part}`);
  return clean(value, maxLength);
}

/** The rows of the shipment's timeline, newest first, without planned ones or repeats. */
function eventsOf(shipment: Record<string, unknown>): CarrierEvent[] {
  const rows = shipment.timelineDetails ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Mainfreight returned an invalid timeline');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !Array.isArray(row.additionalDetails)) throw new SchemaError(PROVIDER, 'Mainfreight returned an invalid scan');
    const said = textOf(row.status, 'scan');
    if (!said) throw new SchemaError(PROVIDER, 'Mainfreight returned a scan without its status');
    const values = row.additionalDetails.map((detail) => {
      if (!isRecord(detail)) throw new SchemaError(PROVIDER, 'Mainfreight returned an invalid scan detail');
      return textOf(detail.value, 'scan detail');
    });
    const clock = clockOf(values);
    // A planned departure or arrival has not happened.
    if (clock.planned) continue;
    const { wording, place } = placedWording(said);
    const location = place ?? clock.rest.map(value => value.replace(/,\s*\d{5}(?:-\d{4})?$/, '')).find(value => value && !LEG.test(value));
    const stage = mainfreightStage(wording);
    const event: CarrierEvent = { ...clock.at, ...(location ? { location } : {}), description: wording,
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
    // The tracker can list one scan twice.
    const identity = JSON.stringify([event.time, event.local_time, location, wording]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  return events;
}

/** The shipment's details by label: "Weight", "Service", "Estimated Delivery Date". */
function detailsOf(shipment: Record<string, unknown>): Map<string, string> {
  const groups = shipment.details ?? [];
  if (!Array.isArray(groups)) throw new SchemaError(PROVIDER, 'Mainfreight returned invalid shipment details');
  const details = new Map<string, string>();
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.items)) throw new SchemaError(PROVIDER, 'Mainfreight returned invalid shipment details');
    for (const item of group.items) {
      if (!isRecord(item)) throw new SchemaError(PROVIDER, 'Mainfreight returned invalid shipment details');
      const label = textOf(item.label, 'detail', 80);
      const value = textOf(item.value, 'detail', 120);
      if (label && value && !details.has(label)) details.set(label, value);
    }
  }
  return details;
}

function weightOf(details: Map<string, string>): number | undefined {
  const value = details.get('Weight') ?? details.get('Total Actual Gross Weight') ?? details.get('Kilos');
  const match = value ? /^(\d+(?:\.\d+)?) ?kg$/i.exec(value) : null;
  const weight = match ? Number(match[1]) : NaN;
  return Number.isFinite(weight) && weight > 0 && weight <= 1_000_000 ? weight : undefined;
}

/** The day the shipment is expected, from the air and ocean estimate or the European arrival day. */
function estimateOf(details: Map<string, string>): string | null {
  const value = details.get('Rescheduled expected Day of Arrival') ?? details.get('Expected Day of Arrival') ?? details.get('Estimated Delivery Date');
  const stamp = value ? STAMP.exec(value) : null;
  if (!stamp) return null;
  try {
    return wallClock(stamp[1]!, '');
  } catch {
    return null;
  }
}

/**
 * The shipment the tracker opens at the address `{code}/{reference}`, bound to
 * that address. Its timeline is newest first: transport scans with a clock in
 * their zone and the place, air and ocean milestones with the port's wall
 * clock. Branch contacts, postcodes, notification and watchlist keys and
 * documents are left out. Null for an empty reply, which is how the tracker
 * answers an address it does not know.
 */
export function parseMainfreight(reply: unknown, at: MainfreightShipment, rawNumber: string): CarrierResult | null {
  const number = normalizeMainfreightNumber(rawNumber);
  if (!Array.isArray(reply)) throw new SchemaError(PROVIDER, 'Mainfreight returned an invalid shipment reply');
  if (!reply.length) return null;
  const bound = reply.filter((entry): entry is Record<string, unknown> => isRecord(entry)
    && typeof entry.shortCode === 'string' && entry.shortCode.trim().toUpperCase() === at.code
    && typeof entry.fullReference === 'string' && entry.fullReference.length <= 80
    && normalizeTrackingNumber(entry.fullReference.trim()) === at.reference);
  if (bound.length !== 1) throw new SchemaError(PROVIDER, 'Mainfreight answered for a different shipment');
  const shipment = bound[0]!;
  const hero = isRecord(shipment.hero) ? shipment.hero : {};
  const status = textOf(shipment.status, 'status') || textOf(hero.status, 'status');
  const events = eventsOf(shipment);
  const details = detailsOf(shipment);

  const current = events.find(event => event.stage);
  const stage = (current?.stage ?? (status ? mainfreightMappedStage(status) : undefined)) as Stage | undefined;
  if (!events.length && !status) throw new NoHistoryError(PROVIDER);
  const newest = events[0];
  const weight = weightOf(details);
  const service = details.get('Service') ?? details.get('Service Level');
  const destination = countryCode(details.get('Consignee Country') ?? details.get('Consignee Country Code'));
  const delivered = stage === 'delivered';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest?.description ?? status,
    last_update: newest?.time ?? null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: delivered ? null : estimateOf(details),
    ...(delivered && current?.time ? { delivered_at: current.time } : {}),
    ...(weight !== undefined ? { weight_kg: weight } : {}),
    ...(service ? { service_name: service } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(at.reference !== number ? { canonical_tracking_number: at.reference } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
