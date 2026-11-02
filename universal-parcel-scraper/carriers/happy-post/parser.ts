import { DateTime } from 'luxon';
import { normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { happyPostLabel, happyPostStage } from './status.js';

export const PROVIDER = 'Happy-Post';
// A reply is under a kilobyte.
export const HAPPY_POST_MAX_BYTES = 256 * 1024;

// The service reads the number as an integer, so a leading zero would name
// another parcel: the numbers it issues have none.
const NUMBER = /^[1-9]\d{6,7}$/;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/;
const MAX_STEPS = 100;
// The drop-off network's link, on the steps before the hub, is not the delivery.
const BEFORE_HUB = new Set(['ordered', 'collected']);

/** A Happy-Post parcel number: seven or eight digits; anything else is not one it issues. */
export function normalizeHappyPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Happy-Post parcel numbers are seven or eight digits');
  return number;
}

/** A step's clock: a wall clock without a zone, to the millisecond on Happy-Post's own steps. */
function wallClock(value: string): string {
  const local = CLOCK.exec(value)?.[1];
  // Parsing in UTC checks the calendar digits only; the clock keeps no offset.
  if (!local || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Happy-Post returned an invalid step time');
  }
  return local;
}

/** An optional link; anything but a string or null is a changed reply. */
function link(step: Record<string, unknown>, key: string): string {
  const value = step[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > 2_000) throw new SchemaError(PROVIDER, `Happy-Post returned an invalid ${key}`);
  return value.trim();
}

/** The number and carrier the delivering network's link names, read by the catalog's link rules. */
function deliveryPartner(url: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (!/^https?:\/\//i.test(url)) return {};
  const match = parseTrackingInput(url);
  if (match.source !== 'link' || match.confidence !== 'high') return {};
  const number = normalizeTrackingNumber(match.trackingNumber);
  if (!/^[A-Z0-9]{4,40}$/.test(number)) return {};
  return { delivery_tracking_number: number, ...(match.carrier !== 'happy-post' ? { delivery_carrier: match.carrier } : {}) };
}

/**
 * The reply of `/api/v1/tracking/{number}`: the tracker's steps in journey
 * order, each with a timestamp once reached. A step can carry a link to the
 * tracking page of the network that carries that leg, before it is reached.
 * The reply does not repeat the number.
 */
export function parseHappyPost(payload: unknown, raw: string): CarrierResult {
  normalizeHappyPostNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.tracking)) throw new SchemaError(PROVIDER, 'Happy-Post returned an invalid envelope');
  const steps = payload.tracking;
  if (steps.length > MAX_STEPS) throw new SchemaError(PROVIDER, 'Happy-Post returned an oversized history');

  const reached: CarrierEvent[] = [];
  let partnerLink = '';
  for (const step of steps) {
    if (!isRecord(step) || typeof step.step !== 'string' || !CODE.test(step.step)) throw new SchemaError(PROVIDER, 'Happy-Post returned an invalid step');
    if (step.timestamp !== null && typeof step.timestamp !== 'string') throw new SchemaError(PROVIDER, 'Happy-Post returned an invalid step time');
    const url = link(step, 'tracking_url');
    link(step, 'hp_tracking_url');
    if (url && !BEFORE_HUB.has(step.step)) partnerLink = url;
    if (step.timestamp === null) continue;
    const code = step.step;
    const staged = happyPostStage(code);
    reached.push({ local_time: wallClock(step.timestamp), description: happyPostLabel(code), provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!reached.length) throw new NoHistoryError(PROVIDER);

  // Newest first. The steps keep the reply's journey order rather than their
  // clocks, which come partly from the networks that carried the parcel.
  const events = reached.reverse();
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(partnerLink ? deliveryPartner(partnerLink) : {}),
    events,
  };
}
