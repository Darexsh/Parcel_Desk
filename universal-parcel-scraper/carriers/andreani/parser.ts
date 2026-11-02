import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { andreaniMilestoneStage, andreaniStage } from './status.js';

export const PROVIDER = 'Andreani';
// A long history is a few kilobytes, with the page's help texts around it.
export const ANDREANI_MAX_BYTES = 512 * 1024;
// Letters and digits with at least one digit. The tracker takes any text:
// Andreani's fifteen-digit numbers, its lettered ones and senders' references.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// A wall clock to the second, sometimes with a fraction.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const ZONE = 'America/Argentina/Buenos_Aires';
// Phone and identity-card numbers, should a recipient's ever reach the wording.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){6,}(?![A-Z\d])/gi;
const MAX_MILESTONES = 30;
const MAX_SCANS = 300;
const MAX_EVENTS = 100;

/** A number for Andreani's tracker, in capitals; anything else is not one it issues. */
export function normalizeAndreaniNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Andreani numbers are six to thirty letters and digits');
  return number;
}

/**
 * A scan's line as the page shows it: the HTML the service words it in, as
 * text. Phone and identity-card numbers are dropped.
 */
export function andreaniWording(html: string): string {
  const text = load(html.replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi, ' '), null, false).text();
  return clean(text.replace(PHONE, '').replace(/\s+([,;:.!?])/g, '$1'), 400);
}

/**
 * A scan's clock. The service sends Argentina's wall clock without an offset:
 * the delivery time it writes into its own summary sentence matches the
 * delivery scan's. Argentina has one zone, without daylight saving.
 */
function scanTime(value: unknown): string {
  const wall = typeof value === 'string' ? CLOCK.exec(value.trim())?.[1] : undefined;
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!wall || !checked?.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Andreani returned an invalid scan time');
  }
  return firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })!;
}

/** A required text field; anything but a non-empty string is a changed reply. */
function required(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  const text = typeof value === 'string' ? clean(value, maxLength) : '';
  if (!text) throw new SchemaError(PROVIDER, `Andreani returned a reply without its ${key}`);
  return text;
}

/** The branch a scan names, or '' without one. */
function branch(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Andreani returned an invalid branch');
  const name = value.nombre;
  if (name === null || name === undefined) return '';
  if (typeof name !== 'string') throw new SchemaError(PROVIDER, 'Andreani returned an invalid branch');
  return clean(name, 120);
}

interface Scan {
  event: CarrierEvent;
  at: number;
}

/** One milestone: its heading and the lines the page lists under it. */
function readMilestone(row: unknown): Scan[] {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Andreani returned an invalid milestone');
  const heading = required(row, 'titulo', 120);
  const lines = row.traducciones ?? [];
  if (!Array.isArray(lines)) throw new SchemaError(PROVIDER, 'Andreani returned a milestone with invalid scans');
  return lines.map((line) => {
    if (!isRecord(line) || typeof line.traduccion !== 'string') throw new SchemaError(PROVIDER, 'Andreani returned an invalid scan');
    const description = andreaniWording(line.traduccion) || heading;
    const time = scanTime(line.fechaEvento);
    const location = branch(line.sucursal);
    const staged = andreaniStage(heading, description);
    const event: CarrierEvent = {
      time,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { event, at: DateTime.fromISO(time).toMillis() };
  });
}

/**
 * The reply of the tracker's `/api/v3/Tracking` for one number: the parcel's
 * current milestone and every milestone with the lines the page lists under
 * it. A reply without a shipment is the page's "No se encontraron
 * resultados". A shipment must name the number asked.
 */
export function parseAndreani(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAndreaniNumber(raw);
  if (payload === null) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Andreani returned an invalid reply');
  const echoed = required(payload, 'numeroAndreani', 64);
  if (normalizeTrackingNumber(echoed).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Andreani answered for another shipment');
  const milestones = payload.timelines ?? [];
  if (!Array.isArray(milestones) || milestones.length > MAX_MILESTONES) throw new SchemaError(PROVIDER, 'Andreani returned invalid milestones');
  const current = payload.procesoActual;
  if (current !== null && current !== undefined && !isRecord(current)) throw new SchemaError(PROVIDER, 'Andreani returned an invalid current state');

  const scans = milestones.flatMap(readMilestone);
  if (scans.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Andreani returned too many scans');
  const seen = new Set<string>();
  // Newest first, whatever order the milestones come in; equal clocks keep the reply's order.
  const ordered = scans.filter(({ event }) => {
    const identity = JSON.stringify([event.time, event.description]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((a, b) => b.at - a.at);
  if (!ordered.length) throw new NoHistoryError(PROVIDER);

  const events = ordered.map(({ event }) => event);
  const newest = events[0]!;
  // The page heads the parcel with its current milestone. A milestone that
  // ends the journey decides; otherwise the newest scan, which can say more.
  const heading = isRecord(current) && typeof current.titulo === 'string' ? clean(current.titulo, 120) : '';
  const summary = heading ? andreaniMilestoneStage(heading) : undefined;
  const ending = summary === 'delivered' || summary === 'returned' || summary === 'exception';
  const stage = ((ending ? summary : newest.stage) ?? summary) as Stage | undefined;
  const source = stage && stage === newest.stage ? newest.stage_source : 'carrier_map';
  // The delivery is the first scan of the run of delivered scans the history ends with.
  const ended = events.findIndex((event) => event.stage && event.stage !== 'delivered');
  const delivery = stage === 'delivered'
    ? events.slice(0, ended < 0 ? undefined : ended).reverse().find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
