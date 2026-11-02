import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, firstOccurrence, usStateTimeZone, type ParsedTime } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { SEVENTEENFEIA_HOME_ZONE } from './clock.js';
import { DELAY_LABEL, ESTIMATE_LABEL, seventeenFeiaStage } from './status.js';

export const PROVIDER = '17FEIA';
// A long history is a few dozen kilobytes.
export const SEVENTEENFEIA_MAX_BYTES = 512 * 1024;
// FEI, the branch (SH Shanghai, SZ Shenzhen), ten digits and two letters.
const NUMBER = /^FEI[A-Z]{2}\d{10}[A-Z]{2}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;
// 17FEIA's backend keeps the order data on Beijing time; a row kept as a wall clock is read in it only to hold back future ones.
const HOME_ZONE = SEVENTEENFEIA_HOME_ZONE;
/**
 * 17FEIA's steps at its warehouse in China before the flight, from its
 * receipt. The backend writes them on Beijing time; the offset they carry is
 * the destination line's, whatever the step's clock.
 */
const WAREHOUSE_STEPS: ReadonlySet<string> = new Set(['包裹在去设施路上', '仓库收货', '订单待客户确认', '订单已确认', '订单已出库', '出口报关中']);
// States whose places keep different clocks, so a state does not settle a clock's zone.
const SPLIT_STATES = new Set(['AK', 'AZ', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** 17FEIA's names for the carriers it hands parcels to, by the catalog id that tracks them. */
export const SEVENTEENFEIA_PARTNERS: Readonly<Record<string, string>> = {
  'DPD-DE': 'dpd-de',
  'DE-DHL': 'dhl',
  'FEDEX-GROUND': 'fedex',
};

// The destination as the reply names it, in Chinese.
const DESTINATIONS: Readonly<Record<string, string>> = {
  德国: 'DE', 法国: 'FR', 荷兰: 'NL', 波兰: 'PL', 美国: 'US',
};

/** A 17FEIA order number; anything else is a number its tracker is not asked for. */
export function normalizeSeventeenFeiaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, '17FEIA order numbers are FEI, two letters, ten digits and two letters');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `17FEIA returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/**
 * The zone a row's place settles: a single-zone country's or, in the United
 * States, a single-zone state's. 17FEIA's own milestones name no place.
 */
function placeZone(country: string, state: string): string | null {
  if (country !== 'US') return countryTimeZone(country);
  return /^[A-Z]{2}$/.test(state) && !SPLIT_STATES.has(state) ? usStateTimeZone(state) : null;
}

/**
 * A wall clock's instant in the zone its row's place settles. A `timeZone`
 * that zone does not have at that time leaves it a wall clock: 17FEIA's
 * milestones carry the destination's standard offset over a wall clock orders
 * to other destinations share, and name no place. A US row at midnight sharp
 * is a day, as FedEx's pickup comes under another offset than its state's.
 */
function placedTime(local: string, label: string, country: string, state: string): ParsedTime | null {
  const zone = country === 'US' && local.endsWith('T00:00:00') ? null : placeZone(country, state);
  if (!zone || (label && !OFFSET.test(label))) return null;
  // The row's own offset tells the repeated hour apart; without one the clock reads as its first occurrence.
  const placed = label ? DateTime.fromISO(`${local}${label}`, { setZone: true }) : firstOccurrence(DateTime.fromISO(local, { zone }));
  // A clock the zone skips, or an offset it does not have then, is no reading of the place's clock.
  if (!placed.isValid || placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local
    || DateTime.fromMillis(placed.toMillis(), { zone }).offset !== placed.offset) return null;
  return { iso: placed.toISO({ suppressMilliseconds: true }), timestamp: placed.toMillis() };
}

/** A row's clock: its instant where its place or its step at the warehouse settles one, else its wall clock. */
function clockOf(stamp: string, step: string, label: string, country: string, state: string): { time: string; at: number } | { local_time: string; at: number } {
  const wall = WALL_CLOCK.exec(stamp);
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  const home = local ? firstOccurrence(DateTime.fromISO(local, { zone: HOME_ZONE })) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!home?.isValid || home.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, '17FEIA returned an invalid scan time');
  if (WAREHOUSE_STEPS.has(step)) return { time: home.toISO({ suppressMilliseconds: true }), at: home.toMillis() };
  const time = placedTime(local, label, country, state);
  return time ? { time: time.iso, at: time.timestamp } : { local_time: local, at: home.toMillis() };
}

function projectRow(row: unknown, readAt: number): { key: string; event: CarrierEvent } | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, '17FEIA returned an invalid scan');
  const label = text(row, 'status', 64);
  const description = text(row, 'description');
  if (!description || label === ESTIMATE_LABEL) return null;
  const stamp = text(row, 'createTime', 64);
  const country = text(row, 'country', 8).toUpperCase();
  // A US row's state is read only for its clock.
  const { at, ...clock } = clockOf(stamp, label, text(row, 'timeZone', 16), country, country === 'US' ? text(row, 'state', 8).toUpperCase() : '');
  // A row dated after the read is not a scan yet.
  if (at > readAt) return null;
  const place = text(row, 'location', 200) || text(row, 'city', 200);
  // A relayed place often ends with its country already, as `Town, MA, US` or `FR`.
  const named = /^[A-Z]{2}$/.test(country) && place.split(/,\s*/).at(-1)?.toUpperCase() !== country;
  const location = [place, named ? country : ''].filter(Boolean).join(', ');
  const staged = seventeenFeiaStage(label, description);
  const event: CarrierEvent = {
    ...clock,
    description,
    ...(location ? { location } : {}),
    ...(label ? { provider_code: label } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([stamp, label, description, location]), event };
}

/** The partner's number, when 17FEIA names a partner the catalog tracks and the number is one of its own. */
function handoff(order: Record<string, unknown>): { delivery_carrier: string; delivery_tracking_number: string } | null {
  const label = text(order, 'deliveryCompany', 64).toUpperCase();
  const partner = Object.hasOwn(SEVENTEENFEIA_PARTNERS, label) ? SEVENTEENFEIA_PARTNERS[label]! : undefined;
  const raw = normalizeTrackingNumber(text(order, 'deliveryNumber', 64));
  // DPD's tracking takes the fourteen digits, without the check character a label adds.
  const number = partner === 'dpd-de' ? dpdParcelNumber(raw) : raw;
  if (!partner || !number || !/^[A-Z0-9]{4,40}$/.test(number)) return null;
  return (detectCarrierMatch(number).candidates as string[]).includes(partner)
    ? { delivery_carrier: partner, delivery_tracking_number: number } : null;
}

/**
 * The reply of `GET /public/v1/ordeSearch/listTrackInfos/{number}`. The
 * search also finds an order by its partner's or another forwarder's number,
 * so the order counts only when its own number is the one asked. Rows come
 * newest first and keep that order: their clocks are not all instants. A US
 * row's state settles only its clock; the rows' postcodes and ids, the order
 * id and its weight are not read.
 */
export function parseSeventeenFeia(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeSeventeenFeiaNumber(raw);
  if (!isRecord(payload) || typeof payload.flag !== 'boolean') throw new SchemaError(PROVIDER, '17FEIA returned an invalid envelope');
  if (!payload.flag) {
    // The tracker answers an order it does not know with a bare refusal and shows "no progress yet".
    if (payload.obj === null && [null, undefined, ''].includes(payload.msg as string) && [null, undefined].includes(payload.code as null)) {
      throw new NotFoundError(PROVIDER);
    }
    throw new IndeterminateError(PROVIDER, '17FEIA did not complete the lookup');
  }
  const order = payload.obj;
  if (!isRecord(order)) throw new SchemaError(PROVIDER, '17FEIA returned an invalid order');
  if (normalizeTrackingNumber(text(order, 'insideNumber', 64)) !== number) {
    throw new IndeterminateError(PROVIDER, '17FEIA answered with another order');
  }
  const rows = order.currentOrderTrackInfos;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, '17FEIA returned an order without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, '17FEIA returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = projectRow(row, readAt);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, '17FEIA has no scans for the order yet');
  // Oldest first: a delayed flight keeps the stage of the row before it.
  let previous: string | undefined;
  for (const event of [...events].reverse()) {
    if (event.provider_code !== DELAY_LABEL) previous = event.stage ?? previous;
    else if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
  }

  const newest = events[0]!;
  const current = events.find((event) => event.stage && event.provider_code !== DELAY_LABEL);
  const stage = current?.stage as Stage | undefined;
  const destination = text(order, 'destination', 64);
  const country = Object.hasOwn(DESTINATIONS, destination) ? DESTINATIONS[destination] : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...handoff(order),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
