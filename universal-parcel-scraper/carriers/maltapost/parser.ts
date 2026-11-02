import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isMaltaPostNotice, keepsMaltaPostStage, maltaPostStage, returnsToSender } from './status.js';

export const PROVIDER = 'MaltaPost';
// A long history is a few kilobytes.
export const MALTAPOST_MAX_BYTES = 256_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The tracker takes any run of letters and digits: MaltaPost's own S10 codes,
// and the foreign barcodes of items it delivers.
const NUMBER = /^(?=.*\d)[A-Z0-9]{6,40}$/;
const OWN_S10 = /^[A-Z]{2}\d{9}MT$/;
const CODE = /^[A-Za-z][A-Za-z0-9]{1,23}$/;
const ACTION = /^[A-Za-z0-9]{1,4}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?$/;
// MaltaPost's own name, and a foreign post's office number, place nothing.
const NO_PLACE = /^(?:malta ?post(?: p\.?l\.?c\.?)?|\d+)$/i;
// A reason that only points at the action shown under it.
const POINTER = /^see action below$/i;

/** MaltaPost tracks its own S10 codes ending MT and the barcodes of the items it delivers. */
export function normalizeMaltaPostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (NUMBER.test(number) && (!OWN_S10.test(number) || isValidS10TrackingNumber(number))) return number;
  throw new InvalidInputError(PROVIDER, 'MaltaPost tracks S10 item codes and the barcodes of items it delivers');
}

/** The scan's clock ("2026-03-04T09:15:00.123") as a wall clock and a sort key. It carries no offset. */
function clockOf(value: unknown): { wall: string; key: string } | null {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(`${match[1]} ${match[2]}`, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  if (!parsed.isValid) return null;
  const wall = parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  return { wall, key: `${wall}.${(match[3] ?? '').padEnd(7, '0')}` };
}

const MALTA = 'Europe/Malta';

/**
 * MaltaPost's own scans are on Malta's clock, so they read in its zone. A foreign post's
 * relayed scans keep the wall clock MaltaPost gives them: their zone is deduced from their place.
 */
function scanClock(wall: string, foreign: boolean): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const time = foreign ? null : isoTime(wall, MALTA);
  return time ? { local_time: wall, time: time.iso, time_zone: MALTA, time_zone_basis: 'carrier' } : { local_time: wall };
}

/** A barcode the reply names, or '' when it names none. */
function barcodeOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, 'MaltaPost returned an invalid barcode');
  return returnedTrackingNumber(value);
}

/** The scan's wording, its reason and the action that follows, as the tracking page lists them. */
function wordingOf(row: Record<string, unknown>): string {
  const reason = clean(row.reasonDescription, 300);
  const parts = [clean(row.description, 300), POINTER.test(reason) ? '' : reason, clean(row.actionDescription, 300)]
    .map(part => part.replace(/[.\s]+$/, '')).filter(Boolean);
  return [...new Set(parts)].join('. ');
}

interface Scan {
  readonly event: CarrierEvent;
  readonly key: string;
  readonly foreign: boolean;
  /** The scan whose code gave this one its stage. */
  origin?: Scan;
}

function scanOf(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'MaltaPost returned an invalid scan');
  const code = cleanScalar(row.code, 24);
  const clock = clockOf(row.date);
  if (!CODE.test(code) || !clock) throw new SchemaError(PROVIDER, 'MaltaPost returned a scan without a code or clock');
  const action = cleanScalar(row.actionCode, 8);
  const providerCode = ACTION.test(action) ? `${code}/${action.toUpperCase()}` : code;
  const place = clean(row.location, 120);
  const location = NO_PLACE.test(place) ? '' : place;
  const foreign = row.isForeignMovement === true;
  const event: CarrierEvent = { ...scanClock(clock.wall, foreign), description: wordingOf(row) || code, provider_code: providerCode,
    ...(location ? { location } : {}) };
  return { event, key: clock.key, foreign };
}

/**
 * The tracking service's reply for one barcode: the item's MaltaPost barcode
 * and foreign barcode, flags for charges and declarations, and its scans,
 * newest first, each with a UPU event code, wording, a wall clock and a
 * place. A barcode MaltaPost does not know comes back with neither barcode
 * and no scans. The recipient's masked name and locality are never read.
 */
export function parseMaltaPost(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeMaltaPostNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.movements) || payload.movements.length > MAX_ROWS) {
    throw new SchemaError(PROVIDER, 'MaltaPost did not return a tracked item');
  }
  const rows = payload.movements as unknown[];
  const local = barcodeOf(payload.localBarcode);
  const foreign = barcodeOf(payload.foreignBarcode);
  // The tracking page reports the number as not recognised when the reply names no barcode.
  if (!local && !foreign) {
    if (rows.length) throw new SchemaError(PROVIDER, 'MaltaPost returned scans without a barcode');
    throw new NotFoundError(PROVIDER);
  }
  // A SendOn or foreign item answers to both its barcodes.
  if (number !== local && number !== foreign) throw new SchemaError(PROVIDER, 'MaltaPost answered for a different item');
  if (payload.isUntrackable === true) {
    throw new IndeterminateError(PROVIDER, 'MaltaPost knows the item but does not track it', { reason: 'tracking_withheld' });
  }
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'MaltaPost returned the item without scans', { reason: 'no_history' });

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach(row => {
    const scan = scanOf(row);
    // A scan repeated within the second would read as the same scan twice.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  // Newest first; scans at the same clock keep the reply's order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => (right.key > left.key ? 1 : right.key < left.key ? -1 : 0));

  // Oldest first: a notice, a hold or a forwarding keeps the stage of the scan
  // before it, and a delivery after the item was sent back reaches the sender.
  let returning = false;
  let previous: Scan | undefined;
  for (const scan of [...scans].reverse()) {
    const { event } = scan;
    const code = event.provider_code!;
    if (keepsMaltaPostStage(code)) {
      if (previous) {
        Object.assign(event, { stage: previous.event.stage, stage_source: 'none' });
        scan.origin = previous.origin;
      }
      continue;
    }
    if (returnsToSender(code)) returning = true;
    const classified = maltaPostStage(code, event.description!);
    const stage = classified?.stage === 'delivered' && returning ? 'returned' : classified?.stage;
    if (stage) {
      Object.assign(event, { stage, stage_source: classified!.source });
      scan.origin = scan;
      previous = scan;
    } else {
      previous = undefined;
    }
  }

  // The recipient's own steps do not say where the item is.
  const decider = scans.find(scan => !isMaltaPostNotice(scan.event.provider_code!)) ?? scans[0]!;
  const stage = decider.event.stage as Stage | undefined;
  const source = decider.origin?.event.stage_source;

  // The MaltaPost office an item waits at is its pickup point. A delivered
  // item was collected there when it waited there last before the delivery.
  let waiting: Scan | undefined;
  if (!returning && stage === 'ready_for_pickup') waiting = decider.origin;
  else if (!returning && stage === 'delivered' && decider.origin === decider) {
    const earlier = scans.slice(scans.indexOf(decider) + 1);
    if (lastMovement(earlier.map(scan => scan.event)) === 'ready_for_pickup') {
      waiting = earlier.find(scan => scan.event.stage === 'ready_for_pickup')?.origin;
    }
  }
  const point = waiting && !waiting.foreign ? waiting.event.location ?? '' : '';
  const events = scans.map(scan => scan.event);

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && source ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: decider.event.description!,
    last_update: scans[0]!.event.time ?? null,
    last_update_local: scans[0]!.event.local_time!,
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
