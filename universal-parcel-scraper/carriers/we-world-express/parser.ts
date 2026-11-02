import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { weWorldStage } from './status.js';

export const PROVIDER = 'We World Express';
export const CARRIER = 'we-world-express';
// A reply is a few kilobytes.
export const WE_WORLD_MAX_BYTES = 256 * 1024;

// WWE, two letters, ten digits and YQ, as its tracker's placeholder shows them.
const NUMBER = /^WWE[A-Z]{2}\d{10}YQ$/;
// "2026-08-06 08:50:04", with the offset in a field of its own.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFSET = /^([+-])(\d{1,2})(?::?(\d{2}))?$/;
// The tracker's answer for a number it has no order under.
const NO_ORDER = /^Order does not exist\.?$/i;
// The page leaves out rows of this code, a scan unbound from the order.
const UNBOUND = '08';
// The page's own English for the warehouse's rows, whose remarks can name its operator.
const PAGE_WORDING = new Map([['00', 'Order Created'], ['06', 'Ready to Ship'], ['07', 'Collected at warehouse'], ['19', 'Weighted'], ['20', 'Bagged']]);
// Delivering partners a hand-off row names, which know the parcel by its logistics number.
const PARTNERS: readonly (readonly [RegExp, string])[] = [[/^Handed over to Aras Cargo$/i, 'aras-kargo']];
const MAX_EVENTS = 200;

/** A number for We World Express' tracker: WWE, two letters, ten digits and YQ. */
export function normalizeWeWorldNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'We World Express numbers are WWE, two letters, ten digits and YQ');
  return number;
}

const field = (record: Record<string, unknown>, key: string, maxLength = 300): string => {
  const value = record[key];
  if (value !== undefined && value !== null && typeof value !== 'string') throw new SchemaError(PROVIDER, `We World Express returned an invalid ${key}`);
  return clean(value ?? '', maxLength);
};

/** A scan's clock: an instant when the row states its offset, else a wall clock in no stated zone. */
function clockOf(text: string, offset: string): Pick<CarrierEvent, 'time' | 'local_time'> {
  const parts = CLOCK.exec(text);
  const zone = OFFSET.exec(offset);
  if (parts && (zone || !offset)) {
    const [year, month, day] = parts.slice(1, 4).map(Number) as [number, number, number];
    const wall = text.replace(' ', 'T');
    if (calendarDay(year, month, day) && year >= 2000) {
      if (!zone) return { local_time: wall };
      const time = explicitOffsetTime(`${wall}${zone[1]}${zone[2]!.padStart(2, '0')}:${zone[3] ?? '00'}`);
      if (time) return { time: time.iso };
    }
  }
  throw new SchemaError(PROVIDER, 'We World Express returned an invalid scan time');
}

interface Row { readonly event: CarrierEvent; readonly logisticsNumber: string }

function rowsOf(rows: unknown[], number: string): Row[] {
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'We World Express returned an invalid history');
  return rows.flatMap((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'We World Express returned an invalid scan');
    if (normalizeTrackingNumber(field(row, 'orderId', 64)) !== number) throw new IndeterminateError(PROVIDER, 'We World Express answered for another number');
    const code = field(row, 'eventCode', 16);
    if (code === UNBOUND) return [];
    const description = PAGE_WORDING.get(code) ?? (field(row, 'eventRemark') || field(row, 'eventContent'));
    if (!description) throw new SchemaError(PROVIDER, 'We World Express returned a scan without wording');
    const location = field(row, 'eventLocation', 120);
    const staged = weWorldStage(code, description);
    const event: CarrierEvent = {
      ...clockOf(field(row, 'eventTime', 40), field(row, 'timeUtc', 8)), description,
      ...(code ? { provider_code: code } : {}),
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return [{ event, logisticsNumber: field(row, 'logisticsNo', 64) }];
  });
}

/**
 * The reply of `POST /wwe/queryTrack2`: a success flag and, as a JSON string,
 * the order's scans oldest first. A number the tracker has no order under
 * comes back unsuccessful with "Order does not exist".
 */
export function parseWeWorld(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWeWorldNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean' || typeof payload.data !== 'string') {
    throw new SchemaError(PROVIDER, 'We World Express returned an invalid reply');
  }
  if (!payload.success) {
    if (NO_ORDER.test(payload.data.trim())) throw new NotFoundError(PROVIDER, 'We World Express has no order under this number');
    throw new IndeterminateError(PROVIDER, 'We World Express did not complete the lookup');
  }
  let data: unknown;
  try {
    data = JSON.parse(payload.data);
  } catch (error) {
    throw new SchemaError(PROVIDER, 'We World Express returned an order that is not JSON', { cause: error });
  }
  const groups = isRecord(data) && Array.isArray(data.events) ? data.events : null;
  const group = groups?.length === 1 && isRecord(groups[0]) ? groups[0].event : null;
  if (!Array.isArray(group)) throw new SchemaError(PROVIDER, 'We World Express returned a reply without its order');

  const rows = rowsOf(group, number).reverse();
  const newest = rows[0]?.event;
  if (!newest) throw new IndeterminateError(PROVIDER, 'We World Express answered without scans');
  const events = rows.map(({ event }) => event);
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The partner a hand-off row names, with the logistics number the order carries for it.
  const handOff = rows.flatMap(({ event, logisticsNumber }) => {
    const partner = PARTNERS.find(([wording]) => wording.test(event.description ?? ''))?.[1];
    return partner && /^\d{10,20}$/.test(logisticsNumber) ? [{ partner, logisticsNumber }] : [];
  })[0];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(handOff ? { delivery_carrier: handOff.partner, delivery_tracking_number: handOff.logisticsNumber } : {}),
    events,
  };
}
