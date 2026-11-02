import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ancStage } from './status.js';

export const PROVIDER = 'ANC';
export const CARRIER = 'anc-delivers';
// A reply is a few kilobytes until delivery, when the delivered step carries the
// proof-of-delivery photos inline, some hundreds of kilobytes each.
export const ANC_MAX_BYTES = 6 * 1024 * 1024;

const NUMBER = /^A\d{8}[A-Z]{2}$/;
const MAX_STEPS = 30;
// A step's stamp, a wall clock with a space or a T and no zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d{1,6})?$/;

/** An ANC number: A, eight digits and two letters. */
export function normalizeAncNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ANC numbers are A, eight digits and two letters');
  return number;
}

/**
 * The service's answer for a number it does not hold, HTTP 404 with a message:
 * `Delivery not found - {number}`, or a booking its depot system no longer
 * keeps. Any other 404 is not one.
 */
export function ancMissing(payload: unknown, number: string): NotFoundError | null {
  const message = isRecord(payload) && typeof payload.message === 'string' ? payload.message.trim() : '';
  const unknown = /^Delivery not found - (\S+)$/.exec(message);
  if (unknown) return normalizeTrackingNumber(unknown[1]!) === number ? new NotFoundError(PROVIDER) : null;
  if (/HUB job cannot be found|Unable to find requested booking/i.test(message)) return new NotFoundError(PROVIDER, 'ANC no longer keeps the booking');
  return null;
}

/** A stamp's wall clock to the second, or a schema error. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const wall = match ? `${match[1]}T${match[2]}:${match[3] ?? '00'}` : '';
  const date = new Date(`${wall}Z`);
  if (!match || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== wall) {
    throw new SchemaError(PROVIDER, 'ANC returned an invalid step time');
  }
  return wall;
}

interface Step { event: CarrierEvent }

function stepOf(value: unknown): Step | null {
  if (!isRecord(value) || typeof value.title !== 'string') throw new SchemaError(PROVIDER, 'ANC returned an invalid step');
  const title = clean(value.title, 80);
  if (!title) throw new SchemaError(PROVIDER, 'ANC returned an invalid step');
  const stamp = typeof value.timeDateStamp === 'string' ? value.timeDateStamp.trim() : '';
  // A step without a stamp is one the delivery has not reached.
  if (!stamp) return null;
  const wall = wallClock(stamp);
  const mapped = ancStage(title);
  const worded = mapped ? null : classifyWording(title, 'pending');
  const stage = mapped ? { stage: mapped, source: 'carrier_map' } : worded!.source === 'none' ? null : worded!;
  return { event: { local_time: wall, description: title, ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) } };
}

/**
 * The open service's answer, `GET /deliveries/{number}`: the delivery's steps
 * in their order, each with its title and, once reached, a wall-clock stamp
 * without a zone, and the job's status. It does not repeat the number. The
 * steps' longer texts name the driver, the delivered step carries the
 * delivery's photos and signature, and the reply also holds the recipient's
 * address and contacts; none of them is read.
 */
export function parseAnc(payload: unknown, raw: string): CarrierResult {
  normalizeAncNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.statuses) || payload.statuses.length > MAX_STEPS) {
    throw new SchemaError(PROVIDER, 'ANC returned an invalid delivery');
  }
  if ('message' in payload && !('jobStatus' in payload)) throw new IndeterminateError(PROVIDER, 'ANC answered with a message, not a delivery');
  // Newest first in the page's order: the steps follow the delivery, and a
  // schedule's stamp drops the seconds of the booking it shares a minute with.
  const events = payload.statuses.map(stepOf).filter((step): step is Step => step !== null).reverse().map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'ANC has no step for the delivery yet');
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const job = typeof payload.jobStatus === 'string' ? payload.jobStatus.trim().toLowerCase() : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    ...(/^[a-z][a-z0-9 _-]{1,39}$/.test(job) ? { provider_code: job } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}
