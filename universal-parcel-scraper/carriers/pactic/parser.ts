import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { pacticMappedStage, pacticWording } from './status.js';

export const PROVIDER = 'Pactic';
export const CARRIER = 'pactic';
// A long history is a few kilobytes.
export const PACTIC_MAX_BYTES = 256 * 1024;

// Pactic's own waybills and the partner couriers' numbers it books: letters and digits.
const NUMBER = /^[A-Z0-9]{6,40}$/;
// A status code, as the tracker writes it: "4", "101", "-1".
const CODE = /^-?\d{1,6}$/;
// "2026.03.02. 9:05", or with seconds: a wall clock with no zone.
const CLOCK = /^(\d{4})\.(\d{2})\.(\d{2})\. (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
// Firewall and bot-check pages that could stand in for the tracker's reply.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_ITEMS = 50;
const MAX_EVENTS = 500;

/** A number for Pactic's tracker: its own waybill, or a partner courier's number it booked. */
export function normalizePacticNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Pactic looks parcels up by 6 to 40 letters and digits');
  return number;
}

/** Whether a number is one of Pactic's own waybills, as detection names them; partner couriers' numbers are not. */
export function isPacticWaybill(raw: string): boolean {
  return detectCarrierMatch(normalizePacticNumber(raw)).carrier === CARRIER;
}

/** A firewall or bot-check page in place of the tracker's JSON. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const identity = (value: string) => normalizeTrackingNumber(value).toUpperCase();

/** A status's date and time as one wall time. The reply names no zone. */
function wallClock(value: unknown): string {
  const parts = CLOCK.exec(text(value));
  if (!parts) throw new SchemaError(PROVIDER, 'Pactic returned an invalid status time');
  const [year, month, day, hour, minute, second] = parts.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  // UTC only checks the calendar fields; no offset is assigned.
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 2000 || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw new SchemaError(PROVIDER, 'Pactic returned an invalid status time');
  }
  return instant.toISOString().slice(0, 19);
}

/** The parcels in a reply: a bare list, or the `{status, data, error}` envelope the tracker once used. */
function items(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Object.hasOwn(payload, 'data')) {
    if (payload.error != null || (payload.status !== undefined && payload.status !== 200)) {
      throw new IndeterminateError(PROVIDER, 'Pactic answered the lookup with an error');
    }
    if (Array.isArray(payload.data)) return payload.data;
  }
  throw new SchemaError(PROVIDER, 'Pactic returned an unexpected reply');
}

interface Parcel { waybill: string; link: string; history: unknown }

/** A parcel's waybill, partner link and history, at the top level or, in the older envelope, in its status list. */
function parcel(item: unknown): Parcel {
  if (!isRecord(item) || !isRecord(item.statusList)) throw new SchemaError(PROVIDER, 'Pactic returned an invalid parcel');
  const list = item.statusList;
  return {
    waybill: text(item.waybill) || text(list.waybill),
    link: text(item.carrierUrl) || text(list.carrierUrl),
    history: list.history,
  };
}

interface Scan { local: string; index: number; event: CarrierEvent; waybills: string[] }

function scan(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Pactic returned an invalid status');
  const code = typeof row.status === 'number' ? String(row.status) : text(row.status);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'Pactic returned an invalid status code');
  const local = wallClock(row.date);
  const stage = pacticMappedStage(code);
  const waybills = Array.isArray(row.waybills)
    ? row.waybills.flatMap((value) => (typeof value === 'string' && value.length <= 64 ? [identity(value)] : [])).filter((value) => NUMBER.test(value))
    : [];
  return { local, index, waybills, event: {
    local_time: local,
    description: pacticWording(code),
    provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/** Whether a link names a number whole, not inside a longer run of letters and digits. */
function names(href: string, number: string): boolean {
  return new RegExp(`(?:^|[^A-Z0-9])${number}(?:$|[^A-Z0-9])`).test(href);
}

/**
 * The partner courier a parcel's tracking link names, with the courier's
 * number when the link names one of the history's waybills instead of the
 * number asked. A link that names no number of the parcel names no partner.
 */
function lastMile(link: string, number: string, waybills: ReadonlySet<string>): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return {};
  }
  if (!['https:', 'http:'].includes(url.protocol)) return {};
  const partner = carrierIdFromPartner('', url.href);
  if (!partner || partner === CARRIER) return {};
  let href: string;
  try {
    href = decodeURIComponent(url.href).toUpperCase();
  } catch {
    href = url.href.toUpperCase();
  }
  if (names(href, number)) return { delivery_carrier: partner };
  const others = [...waybills].filter((waybill) => waybill !== number && names(href, waybill));
  return others.length === 1 ? { delivery_carrier: partner, delivery_tracking_number: others[0]! } : {};
}

/**
 * The tracker's reply for one number: a list of parcels, each with its
 * waybill, its partner courier's tracking link (empty for Pactic's own
 * delivery) and its statuses, each a Pactic status code and a wall clock to
 * the minute with no zone. An unknown number gets an empty list.
 *
 * The parcel must name the whole number asked. The collection contact's name,
 * email and phone, and the return waybill, are not read.
 */
export function parsePactic(payload: unknown, raw: string): CarrierResult {
  const number = normalizePacticNumber(raw);
  const list = items(payload);
  if (!list.length) throw new NotFoundError(PROVIDER);
  if (list.length > MAX_ITEMS) throw new SchemaError(PROVIDER, 'Pactic returned too many parcels');
  const matching = list.map(parcel).filter((candidate) => candidate.waybill && identity(candidate.waybill) === number);
  if (!matching.length) throw new IndeterminateError(PROVIDER, 'Pactic answered for another parcel');
  if (matching.length > 1) throw new IndeterminateError(PROVIDER, 'Pactic answered with several parcels for the number');
  const { link, history } = matching[0]!;
  if (!Array.isArray(history) || history.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Pactic returned an invalid history');
  if (!history.length) throw new NoHistoryError(PROVIDER);

  // A status the reply lists twice, as it does with each waybill of a parcel, is kept once.
  const seen = new Set<string>();
  const scans = history.map(scan).filter(({ local, event }) => {
    const key = `${local} ${event.provider_code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Newest first, as the reply lists them; it once listed them out of order.
  const events = scans.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index).map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(link ? lastMile(link, number, new Set(scans.flatMap((entry) => entry.waybills))) : {}),
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function pacticJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isBlockPage(body)) throw new ChallengeError(PROVIDER, 'Pactic answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Pactic returned a reply that is not JSON', { cause });
  }
}
