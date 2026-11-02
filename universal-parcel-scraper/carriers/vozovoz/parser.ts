import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { CREATED, GIVEN, vozovozStage, type VozovozFlags } from './status.js';

export const PROVIDER = 'Vozovoz';
// An order's reply is about a kilobyte.
export const VOZOVOZ_MAX_BYTES = 64 * 1024;
// The lookup's answer to a number it has no order for: "Проверьте корректность номера заказа."
const CHECK_NUMBER = '4033';
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;
// 1C, behind the tracker, writes an unset date as the year 1.
const FIRST_YEAR = 2000;
// The fields that name the order's parties; the adapter only asks whether the reply has them.
const PARTIES = ['organizationId', 'payerId', 'payer', 'consignee'];

/** The nine digits of an order number, the only number the tracker's form takes. */
export function normalizeVozovozNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{9}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Vozovoz orders are tracked by their nine-digit number');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Vozovoz returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional flag of the order's state; anything but a boolean is a changed reply. */
function flag(status: Record<string, unknown>, key: string): boolean {
  const value = status[key];
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') throw new SchemaError(PROVIDER, `Vozovoz returned an invalid ${key}`);
  return value;
}

/** The order's dates by name: an object, or an empty list when it has none. */
function datesOf(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return {};
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Vozovoz returned invalid dates');
  return value;
}

/**
 * A date as the reply writes it, to the second and without a zone. Nothing
 * says whose clock it is, and Russia spans eleven zones, so it stays a wall
 * clock; a day alone stays a day. An unset date is none.
 */
function clock(dates: Record<string, unknown>, key: string): string | undefined {
  const raw = text(dates, key, 32);
  if (!raw) return undefined;
  const parts = CLOCK.exec(raw);
  if (!parts) throw new SchemaError(PROVIDER, `Vozovoz returned an invalid ${key} date`);
  if (Number(parts[1]) < FIRST_YEAR) return undefined;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(raw, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat(parts[4] ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd') !== raw) {
    throw new SchemaError(PROVIDER, `Vozovoz returned an invalid ${key} date`);
  }
  return raw;
}

const named = (payload: Record<string, unknown>) =>
  PARTIES.some((key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== '');

/**
 * The reply of `POST https://api.vozovoz.ru/v1/order/mini` for one number:
 * the order's status message and flags and its dates, which is all the
 * tracker shows a visitor. An unknown number is error 4033, or an echo of the
 * number without a status, a date or a party, which the page shows as «Нет
 * данных». The lookup also finds an order by its customer's own reference,
 * so the reply must name the number asked.
 */
export function parseVozovoz(payload: unknown, raw: string): CarrierResult {
  const number = normalizeVozovozNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Vozovoz returned an invalid reply');
  if (payload.error !== undefined && payload.error !== null && payload.error !== false) {
    const details = isRecord(payload.raw) && isRecord(payload.raw.status) ? payload.raw.status : {};
    if (cleanScalar(details.code, 16) === CHECK_NUMBER) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Vozovoz refused the lookup');
  }
  if (typeof payload.number !== 'string') throw new SchemaError(PROVIDER, 'Vozovoz returned an order without its number');
  if (payload.number.trim() !== number) throw new IndeterminateError(PROVIDER, 'Vozovoz answered for another order');
  const status = payload.status;
  if (!isRecord(status)) throw new SchemaError(PROVIDER, 'Vozovoz returned an order without its status');

  const message = text(status, 'message', 120);
  const description = text(status, 'description');
  const flags: VozovozFlags = {
    isTaken: flag(status, 'isTaken'), hasArrived: flag(status, 'hasArrived'), isGiven: flag(status, 'isGiven'), isCanceled: flag(status, 'isCanceled'),
  };
  const dates = datesOf(payload.dates);
  const idle = Object.values(status).every((value) => value !== true);
  if (!message && !description && idle && !Object.keys(dates).length && !named(payload)) throw new NotFoundError(PROVIDER);

  const created = clock(dates, 'created');
  const given = clock(dates, 'given');
  // The page shows this day as the estimated delivery; it is no milestone.
  const arrival = clock(dates, 'arrivalFrom');
  const events: CarrierEvent[] = [];
  // The issue date belongs to the order's final status, which names what it was: an issue, or a finished group pickup.
  if (given && flags.isGiven) {
    const wording = message || GIVEN;
    const staged = vozovozStage(wording, flags);
    events.push({ local_time: given, description: wording, stage: staged.stage, stage_source: staged.source });
  }
  if (created) events.push({ local_time: created, description: CREATED, stage: 'registered', stage_source: 'carrier_map' });
  // Newest first; on one clock, the issue comes after the creation.
  events.sort((left, right) => String(right.local_time).localeCompare(String(left.local_time)));
  if (!message && !events.length && idle) throw new NoHistoryError(PROVIDER);

  const current = vozovozStage(message, flags);
  const settled = flags.isGiven || flags.isCanceled || current.stage === 'delivered' || current.stage === 'returned';
  return {
    status: languageStageStatus(current.stage),
    current_stage: current.stage,
    current_stage_source: current.source,
    last_status_text: message || null,
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: settled || !arrival ? null : arrival.slice(0, 10),
    summary_only: true,
    events,
  };
}
