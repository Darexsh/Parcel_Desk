import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { flashbirdStage } from './status.js';

export const PROVIDER = 'FlashBird';
export const CARRIER = 'flashbird-ca';
/** The zone the tracking page shows every clock in. */
export const FLASHBIRD_ZONE = 'America/Toronto';
// A delivered parcel's reply is under a kilobyte.
export const FLASHBIRD_MAX_BYTES = 256 * 1024;

// Every number FlashBird's tracker has shown is twelve digits.
const NUMBER = /^\d{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Firewall and bot-check pages that could stand in for the service's JSON.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// The tracking page's own limits on the estimate it shows (its tracking-config):
// at most four hours ahead, and no later than 23:00 on the day of the lookup.
const ETA_MAX_SECONDS = 4 * 3600;
const ETA_LATEST_MINUTE = 23 * 60;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** A number for FlashBird's tracker: twelve digits. Anything else is not one it issues. */
export function normalizeFlashbirdNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FlashBird numbers are twelve digits');
  return number;
}

/** The service's reply as JSON, or the reason it is not one. */
export function flashbirdJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (BLOCK.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FlashBird answered with a browser check', { cause });
    // The site answers a path it does not route with its blog's admin page.
    throw new SchemaError(PROVIDER, 'FlashBird returned a reply that is not JSON', { cause });
  }
}

/** An instant on the tracking page's clock, to the second. */
const shown = (millis: number) => DateTime.fromMillis(Math.floor(millis / 1000) * 1000, { zone: FLASHBIRD_ZONE })
  .toISO({ suppressMilliseconds: true })!;

interface Scan { at: number; event: CarrierEvent & { time: string; description: string } }

/** One row of the history: FlashBird's wording and an instant in epoch milliseconds. */
function scan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'FlashBird returned an invalid scan');
  const description = clean(row.message, 300);
  if (!description) throw new SchemaError(PROVIDER, 'FlashBird returned a scan without wording');
  const at = row.time;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 1e12 || at >= 1e13) {
    throw new SchemaError(PROVIDER, 'FlashBird returned an invalid scan time');
  }
  const staged = flashbirdStage(description);
  return { at, event: {
    time: shown(at),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** A count of seconds from the lookup, as the reply gives its estimates; anything else is none. */
function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 7 * 86_400 ? value : null;
}

/** Whether an instant comes after the page's latest delivery time on the day of the lookup, or on a later day. */
function late(at: number, readAt: number): boolean {
  const [then, now] = [DateTime.fromMillis(at, { zone: FLASHBIRD_ZONE }), DateTime.fromMillis(readAt, { zone: FLASHBIRD_ZONE })];
  const [day, today] = [then.toISODate()!, now.toISODate()!];
  return day > today || (day === today && then.hour * 60 + then.minute > ETA_LATEST_MINUTE);
}

/**
 * The estimate the tracking page shows. A delivery the recipient moved to a
 * later day is that day. Otherwise the driver's arrival, `eta` seconds after
 * the lookup, to the minute, within the page's limits; the page lifts the
 * four-hour limit when the driver's route ends by its latest time.
 * Otherwise a scheduled day, unless it has passed.
 */
function estimate(payload: Record<string, unknown>, readAt: number): string | null {
  const scheduled = clean(payload.scheduled_delivery_date, 16);
  const day = DAY.test(scheduled) && DateTime.fromISO(scheduled, { zone: 'utc' }).isValid ? scheduled : null;
  const today = DateTime.fromMillis(readAt, { zone: FLASHBIRD_ZONE }).toISODate()!;
  if (day && day > today) return day;
  const eta = seconds(payload.eta);
  if (eta !== null) {
    const at = readAt + eta * 1000;
    const routeEnd = seconds(payload.route_end_eta);
    if ((routeEnd !== null && !late(readAt + routeEnd * 1000, readAt)) || (eta <= ETA_MAX_SECONDS && !late(at, readAt))) {
      return shown(Math.round(at / 60_000) * 60_000);
    }
  }
  return day === today ? day : null;
}

/**
 * The reply of `/ghost/api/v0.1/package_trackings/{number}` for one number:
 * the number, its history oldest first, the delivery flag and the keys of the
 * delivery photos, and while the parcel is on its way the driver's estimate,
 * position and stops left. A number the service does not hold gets an empty
 * object, which the tracking page reports as not found.
 *
 * The reply must name the whole number asked. Only the history and the
 * estimate are read: the photos, the driver, the driver's position and the
 * page's note stay out.
 */
export function parseFlashbird(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeFlashbirdNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'FlashBird returned an unexpected reply');
  if (!Object.keys(payload).length) throw new NotFoundError(PROVIDER);
  if (!Array.isArray(payload.logs) || (typeof payload.number !== 'string' && typeof payload.number !== 'number')) {
    throw new SchemaError(PROVIDER, 'FlashBird returned an unexpected reply');
  }
  if (normalizeTrackingNumber(cleanScalar(payload.number, 64)) !== number) throw new IndeterminateError(PROVIDER, 'FlashBird answered for another shipment');
  if (payload.logs.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'FlashBird returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of payload.logs) {
    const next = scan(row);
    const key = JSON.stringify([next.at, next.event.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(next);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first. The reply lists them oldest first; scans of one instant keep its order, reversed.
  if (scans[0]!.at < scans.at(-1)!.at) scans.reverse();
  const events = scans.sort((left, right) => right.at - left.at).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const ended = stage === 'delivered' || stage === 'returned';
  const delivered = stage === 'delivered' ? current!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: ended ? null : estimate(payload, readAt),
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
