import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, explicitOffsetTime, isoTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postaSlovenijeStage, startsReturn } from './status.js';

export const PROVIDER = 'Pošta Slovenije';
// A long history is a few kilobytes.
export const POSTA_SLOVENIJE_MAX_BYTES = 512_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const CODE = /^[A-Z0-9]{1,20}$/;
// The unit type of a post office; a parcel locker is 8.
const POST_OFFICE = 99;
const HOME = 'SI';
const ZONE = 'Europe/Ljubljana';
// An office of exchange's UPU code: its country's two letters, three for its
// town and one more, such as SILJUA.
const EXCHANGE = /^([A-Z]{2})[A-Z]{3}[A-Z0-9]$/;
// UPU events by the side of the border they happen on: the origin post's up
// to its outward office of exchange, the destination post's from its inward
// office on. Transit offices' events always name their office.
const ORIGIN_EVENTS: ReadonlySet<string> = new Set(['EMA', 'EMB', 'EMC', 'EXA', 'EXB', 'EXC', 'EXD', 'EXX']);
const DESTINATION_EVENTS: ReadonlySet<string> = new Set(['EMD', 'EME', 'EMF', 'EMG', 'EMH', 'EMI',
  'EDA', 'EDB', 'EDC', 'EDD', 'EDE', 'EDF', 'EDG', 'EDH', 'EDX']);

/**
 * Pošta Slovenije tracks UPU S10 items: the ones it issues, which end in SI,
 * and the ones other posts hand it to deliver.
 */
export function normalizePostaSlovenijeNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Pošta Slovenije tracks S10 item codes');
}

/** The service's not-found reply names the number it looked for: "Record not found for Id '…'". */
export function isNotFoundReply(payload: unknown, number: string): boolean {
  if (!isRecord(payload) || payload.errorCode !== 'error.not.found') return false;
  const named = /\bId '([^']*)'/.exec(clean(payload.errorMessage, 200))?.[1];
  return named === undefined || named.trim().toUpperCase() === number;
}

interface Scan {
  readonly event: CarrierEvent;
  readonly at: number;
  readonly code: string;
  readonly postOffice: boolean;
  readonly index: number;
}

/** The scan's English heading, its detail line and the next step after a failed delivery, as the tracker lists them. */
function wordingOf(row: Record<string, unknown>): string {
  const parts = [clean(row.codeDescriptionEN, 300) || clean(row.codeDescriptionSI, 300),
    clean(row.codeDetailedDescriptionEN, 300), clean(row.nondeliveryActionEN, 300)]
    .map(part => part.replace(/[.\s]+$/, '')).filter(Boolean);
  return [...new Set(parts)].join('. ');
}

/** The country an office of exchange's code names, when a scan's place is one. */
function exchangeCountry(postalId: unknown): string | null {
  const match = EXCHANGE.exec(clean(postalId, 20).toUpperCase());
  return match ? countryCode(match[1]) : null;
}

/**
 * The country each scan happened in, or null when the reply cannot tell.
 * Pošta Slovenije's own scans carry its codes or its offices of exchange. A
 * foreign post's events reach it as UPU events, at that post's office of
 * exchange or at a post office named only by its foreign postcode; the second
 * kind is placed on its side of the border. The origin is the country of the
 * outward offices of exchange, else the one the S10 code names; the
 * destination the country of the inward offices, else Slovenia for an item
 * from abroad.
 */
function countriesOf(rows: readonly Record<string, unknown>[], number: string): (string | null)[] {
  const codes = rows.map(row => clean(row.code, 40));
  const offices = rows.map(row => exchangeCountry(row.postalId));
  const side = (events: ReadonlySet<string>): string | null | undefined => {
    const named = new Set(offices.filter((country, index): country is string => country !== null && events.has(codes[index]!)));
    return named.size > 1 ? null : [...named][0];
  };
  const outward = side(ORIGIN_EVENTS);
  const origin = outward === undefined ? countryCode(number.slice(-2)) : outward;
  const inward = side(DESTINATION_EVENTS);
  const destination = inward === undefined ? (origin && origin !== HOME ? HOME : null) : inward;
  return rows.map((_, index) => {
    const code = codes[index]!;
    return offices[index] ?? (ORIGIN_EVENTS.has(code) ? origin : DESTINATION_EVENTS.has(code) ? destination : HOME);
  });
}

/**
 * When a scan happened. The service labels every clock as UTC. Its own scans
 * are UTC instants. A foreign post's event carries that post's wall clock,
 * which the service reads as Ljubljana time, so it is read again in that
 * country's zone, or kept as a wall clock when the country keeps several or
 * is unknown.
 */
function clockOf(labeled: ParsedTime, country: string | null): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  if (country === HOME) return { time: labeled.iso };
  const wall = DateTime.fromMillis(labeled.timestamp, { zone: ZONE }).toISO({ includeOffset: false, suppressMilliseconds: true })!;
  const zone = country ? countryTimeZone(country) : null;
  const placed = zone ? isoTime(wall, zone) : null;
  return placed ? { time: placed.iso } : { local_time: wall };
}

/**
 * The guest lookup's reply for one number: the parcel and its scans, oldest
 * first, each with a code, wording in Slovenian and English, a clock labelled
 * UTC and the post office it happened at. Sender, recipient, signatory,
 * pickup codes and addresses are left out.
 */
export function parsePostaSlovenije(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePostaSlovenijeNumber(rawNumber);
  const result = isRecord(payload) ? payload.result : undefined;
  if (!isRecord(result) || !isRecord(result.parcel)) throw new SchemaError(PROVIDER, 'Pošta Slovenije did not return a parcel');
  const parcel = result.parcel;
  if (typeof parcel.trackingNumber !== 'string' || parcel.trackingNumber.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Pošta Slovenije answered for a different parcel');
  }
  const rows = result.statuses ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pošta Slovenije returned an invalid parcel history');
  if (!rows.every(isRecord)) throw new SchemaError(PROVIDER, 'Pošta Slovenije returned an invalid scan');
  const countries = countriesOf(rows, number);

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const code = clean(row.code, 40);
    const at = explicitOffsetTime(row.statusDateTime);
    if (!CODE.test(code) || !at) throw new SchemaError(PROVIDER, 'Pošta Slovenije returned a scan without a code or clock');
    // The post office's name; its number, a postcode, is left out.
    const place = clean(row.postalName, 120);
    const event: CarrierEvent = { ...clockOf(at, countries[index]!), description: wordingOf(row) || code, provider_code: code,
      ...(place ? { location: place } : {}) };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, at: at.timestamp, code, postOffice: row.unitType === POST_OFFICE, index });
  });
  // Newest first, by the clock the service labels each scan with, as its
  // tracker orders them; scans at the same clock follow the reply's order, reversed.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);

  // Oldest first: a delivery after the item was sent back reaches its sender.
  let returning = false;
  for (const scan of [...scans].reverse()) {
    const description = scan.event.description!;
    const classified = postaSlovenijeStage(scan.code, description);
    if (startsReturn(scan.code, description)) returning = true;
    if (!classified) continue;
    const stage: Stage = classified.stage === 'delivered' && returning ? 'returned' : classified.stage;
    Object.assign(scan.event, { stage, stage_source: classified.source });
  }
  const events = scans.map(scan => scan.event);

  if (!scans.length) return summaryOf(parcel);
  const decider = scans[0]!;
  const stage = decider.event.stage as Stage | undefined;

  // The post office an item waits at is its pickup point. A delivered item
  // was collected there when it waited there last before the delivery.
  const earlier = scans.slice(1);
  const waiting = stage === 'ready_for_pickup' ? decider
    : stage === 'delivered' && lastMovement(earlier.map(scan => scan.event)) === 'ready_for_pickup'
      ? earlier.find(scan => scan.event.stage === 'ready_for_pickup') : undefined;
  const point = waiting?.postOffice ? waiting.event.location ?? '' : '';

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider.event.stage_source } : {}),
    last_status_text: decider.event.description!,
    last_update: decider.event.time ?? null,
    ...(typeof decider.event.local_time === 'string' ? { last_update_local: decider.event.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && decider.event.time ? { delivered_at: decider.event.time } : {}),
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** A parcel without scans: its own heading and the clock of its state. */
function summaryOf(parcel: Record<string, unknown>): CarrierResult {
  const wording = clean(parcel.codeDescriptionEN, 300) || clean(parcel.codeDescriptionSI, 300);
  if (!wording) throw new IndeterminateError(PROVIDER, 'Pošta Slovenije returned a parcel without a state or scans');
  const classified = classifyWording(wording, 'in_transit');
  const stage = classified.source === 'none' ? undefined : classified.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: classified.source } : {}),
    last_status_text: wording,
    summary_only: true,
    last_update: explicitOffsetTime(parcel.currentStatusDateTime)?.iso ?? null,
    expected_delivery: null,
    events: [],
  };
}
