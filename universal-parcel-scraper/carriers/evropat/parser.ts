import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { evropatStage } from './status.js';

export const PROVIDER = 'Evropat';
// A long history is a few kilobytes.
export const EVROPAT_MAX_BYTES = 256 * 1024;
// Evropat's own scans, read in Sofia time.
const ZONE = 'Europe/Sofia';
// The tracking page sends eight to fourteen digits and refuses anything else.
const NUMBER = /^\d{8,14}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An Evropat waybill as the tracking page sends it: its digits only. */
export function normalizeEvropatNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Evropat waybills are eight to fourteen digits');
  return number;
}

/** A Sofia wall clock as an instant, or kept as local time in the hour a clock change skips or repeats. */
function scanClock(value: unknown): { wall: string; clock: Pick<CarrierEvent, 'time'> | { local_time: string } } {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = CLOCK.exec(text);
  const parsed = match ? zonedTime(text, 'yyyy-MM-dd HH:mm:ss', ZONE) : null;
  if (!match || !parsed) throw new SchemaError(PROVIDER, 'Evropat returned an invalid step time');
  const wall = `${match[1]}T${match[2]}`;
  const unique = DateTime.fromISO(wall, { zone: ZONE }).getPossibleOffsets().length === 1;
  return { wall, clock: parsed.iso.startsWith(wall) && unique ? { time: parsed.iso } : { local_time: wall } };
}

/**
 * The office a step names in its additional information. Steps with a courier
 * or the delivery name a person instead (the courier, whoever signed), so they
 * give no place and their information is not kept.
 */
function office(state: string, information: string): string {
  const place = (pattern: RegExp) => clean(pattern.exec(information)?.[1], 80);
  switch (state) {
    case 'приета в офис': return place(/^Пр[иi][еe]мане в склад - (.+)$/i);
    case 'натоварена от офис': return place(/^(.+?) -> /);
    case 'разтоварена в офис': return place(/ -> (.+)$/);
    case 'групирана':
    case 'разгрупирана': return place(/^Офис - (.+)$/i);
    default: return '';
  }
}

function step(row: unknown, number: string): { wall: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Evropat returned an invalid step');
  if (typeof row.barcode !== 'string' || normalizeTrackingNumber(row.barcode) !== number) {
    throw new IndeterminateError(PROVIDER, 'Evropat answered for another waybill');
  }
  const name = clean(row.stateName, 120);
  if (!name) throw new SchemaError(PROVIDER, 'Evropat returned a step without its state');
  const information = typeof row.additionalInformation === 'string' ? row.additionalInformation.trim() : '';
  const location = office(name.toLocaleLowerCase('bg'), information);
  const stage = evropatStage(name);
  const { wall, clock } = scanClock(row.dateAndTime);
  return { wall, event: {
    ...clock,
    description: name,
    ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/**
 * The reply of the tracking page's lookup, `POST /wp-json/evropat/v1/track` on
 * evropat.bg: `{ ok: true, statuses }`, the waybill's steps oldest first. Each
 * step names the waybill, its state, its Sofia clock and, for some states, the
 * office, the courier or whoever signed.
 */
export function parseEvropat(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEvropatNumber(raw);
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.statuses)) {
    throw new SchemaError(PROVIDER, 'Evropat returned a reply that is not a waybill');
  }
  if (payload.statuses.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Evropat returned an oversized history');
  // The page reports a waybill without steps as having no information yet.
  if (!payload.statuses.length) throw new NoHistoryError(PROVIDER, 'Evropat has no steps for the waybill yet');
  // Newest first; steps at the same clock keep the order Evropat added them in.
  const events = payload.statuses.map((row, index) => ({ ...step(row, number), index }))
    .sort((a, b) => b.wall.localeCompare(a.wall) || b.index - a.index)
    .map(({ event }) => event);
  const newest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    timezone: ZONE,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
