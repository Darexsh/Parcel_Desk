import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { whizMappedStage } from './status.js';

export const PROVIDER = 'Whiz Delivery';
export const CARRIER = 'whiz-delivery';
// A long history is a couple of kilobytes.
export const WHIZ_MAX_BYTES = 256 * 1024;

// The tracker's own numbers: SW or WHZ, then letters and digits.
const NUMBER = /^(?:SW|WHZ)[A-Z0-9]{6,20}$/;
// An ISO instant; the tracking page reads one without an offset as UTC, and so does the parser.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;
// Firewall and bot-check pages that could stand in for the API's JSON.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_EVENTS = 200;

/** A number for Whiz Delivery's tracker: SW or WHZ and the characters after it. */
export function normalizeWhizNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Whiz Delivery numbers start with SW or WHZ');
  return number;
}

/** A firewall or bot-check page in place of the API's JSON. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** An instant to the second, in UTC. */
function instant(value: unknown): string {
  const raw = text(value);
  const parts = INSTANT.exec(raw);
  const time = parts ? Date.parse(parts[1] ? raw : `${raw}Z`) : Number.NaN;
  // Date.parse rolls 30 February over into March; the calendar day must survive.
  const day = Number(raw.slice(8, 10));
  if (!Number.isFinite(time) || new Date(Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, day)).getUTCDate() !== day) {
    throw new SchemaError(PROVIDER, 'Whiz Delivery returned an invalid event time');
  }
  return `${new Date(time).toISOString().slice(0, 19)}Z`;
}

interface Scan { time: string; event: CarrierEvent }

function scan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Whiz Delivery returned an invalid event');
  const description = text(row.description);
  if (!description) throw new SchemaError(PROVIDER, 'Whiz Delivery returned an event without a description');
  const code = Number.isInteger(row.status_id) ? String(row.status_id) : null;
  const stage = whizMappedStage(code);
  const time = instant(row.timestamp);
  return { time, event: {
    time,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/**
 * The public tracking API's reply for one number: the shipment's status, its
 * origin and destination towns, the shop, and its events, each a UTC instant,
 * a WooDelivery task status id and Whiz's wording for it.
 *
 * The reply must name the whole number asked. The towns, the shop and the
 * support banner are not read.
 */
export function parseWhiz(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWhizNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.events)) throw new SchemaError(PROVIDER, 'Whiz Delivery returned an unexpected reply');
  if (text(payload.tracking_id).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Whiz Delivery answered for another shipment');
  if (payload.events.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Whiz Delivery returned too many events');
  if (!payload.events.length) throw new NoHistoryError(PROVIDER);

  // Newest first, as the reply lists them.
  const scans = payload.events.map(scan);
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((left, right) => right.time.localeCompare(left.time)).map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const country = isRecord(payload.destination) ? text(payload.destination.country).toUpperCase() : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' && payload.delivered_at ? { delivered_at: instant(payload.delivered_at) } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events,
  };
}

/**
 * The API's answer to a lookup that found nothing: HTTP 404 with a detail
 * naming the shipment asked. Any other 404 is a missing route, not a missing shipment.
 */
export function isUnknownShipment(body: string, number: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  return isRecord(payload) && text(payload.detail).toUpperCase() === `SHIPMENT ${number} NOT FOUND`;
}

/** The API's reply as JSON, or the reason it is not one. */
export function whizJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isBlockPage(body)) throw new ChallengeError(PROVIDER, 'Whiz Delivery answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Whiz Delivery returned a reply that is not JSON', { cause });
  }
}
