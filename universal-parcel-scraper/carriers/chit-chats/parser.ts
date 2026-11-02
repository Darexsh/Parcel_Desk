import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { chitChatsOwnWording, chitChatsStage } from './status.js';

export const PROVIDER = 'Chit Chats';
export const CHIT_CHATS_ORIGIN = 'https://chitchats.com';
// A shipment's reply is a few kilobytes; the search page about thirty.
export const CHIT_CHATS_MAX_BYTES = 512 * 1024;
// Ten letters and digits, as the tracking page describes the shipment ID.
const NUMBER = /^(?=[A-Z]*\d)(?=\d*[A-Z])[A-Z0-9]{10}$/;
// Chit Chats stamps its own scans to the millisecond; scans it relays from a
// partner come without, or in the partner's precision.
const OWN_CLOCK = /T\d{2}:\d{2}:\d{2}\.(?!000)\d{3}(?:Z|[+-]\d{2}:\d{2})$/;
// A Canadian postal code or a US ZIP code, which a partner's location can carry.
const POSTCODE = /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b|\b\d{5}(?:-\d{4})?\b/gi;
const WEIGHT = /^(\d{1,6}(?:\.\d{1,3})?) ?(kg|g|lb|oz)$/i;
const KILOGRAMS: Readonly<Record<string, number>> = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.028349523125 };
const FINAL: readonly Stage[] = ['delivered', 'returned'];
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Chit Chats shipment ID; anything else is a number Chit Chats does not issue. */
export function normalizeChitChatsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Chit Chats shipment IDs are ten letters and digits');
  return number;
}

/** An optional text field; an object, array or other non-scalar is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `Chit Chats returned an invalid ${key}`);
  return typeof value === 'number' ? cleanScalar(value, maxLength) : clean(value, maxLength);
}

/** A scan's town. Postcodes are dropped, and a place still holding a digit may be a street address. */
function location(raw: string): string {
  const place = raw.replace(POSTCODE, ' ').replace(/\s+/g, ' ').replace(/^[\s,.]+|[\s,.]+$/g, '');
  return /\d/.test(place) ? '' : place;
}

function projectScan(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Chit Chats returned an invalid scan');
  const description = text(row, 'title');
  if (!description) throw new SchemaError(PROVIDER, 'Chit Chats returned a scan without wording');
  const stamp = text(row, 'created_at', 64);
  const clock = explicitOffsetTime(stamp);
  if (!clock) throw new SchemaError(PROVIDER, 'Chit Chats returned a scan without an offset time');
  const code = text(row, 'status', 64);
  const place = location(text(row, 'location_description', 200));
  const staged = chitChatsStage(code, description);
  // A partner's scan carries Chit Chats' Pacific label over a clock that can be
  // hours off the partner's own, so only its wall clock is kept.
  const own = chitChatsOwnWording(description) && OWN_CLOCK.test(stamp);
  const wall = DateTime.fromISO(stamp, { setZone: true }).toISO({ includeOffset: false, suppressMilliseconds: true })!;
  const event: CarrierEvent = {
    ...(own ? { time: clock.iso } : { local_time: wall }),
    description,
    ...(place ? { location: place } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  // The page lists some scans twice.
  return { key: JSON.stringify([stamp, description, place, code]), event };
}

function weightKg(raw: string): number | undefined {
  const match = WEIGHT.exec(raw);
  if (!match) return undefined;
  const kilograms = Number(match[1]) * KILOGRAMS[match[2]!.toLowerCase()]!;
  return Number.isFinite(kilograms) && kilograms > 0 ? Math.round(kilograms * 1000) / 1000 : undefined;
}

/** The estimate's calendar day on Chit Chats' clock: it gives the end of a business day. */
function estimatedDay(raw: string): string | null {
  const parsed = explicitOffsetTime(raw) ? DateTime.fromISO(raw, { setZone: true }) : null;
  return parsed?.isValid ? parsed.toISODate() : null;
}

/** The partner's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function partnerNumber(raw: string, number: string): string | undefined {
  const compact = normalizeTrackingNumber(raw);
  const code = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  return /^[A-Z0-9]{4,40}$/.test(code) && code !== number ? code : undefined;
}

/**
 * The reply of `GET /tracking/{shipment ID}.json`. The shipment's own ID must
 * be the one asked for. The sender's and recipient's towns and postcodes, the
 * scans' subtitles (which repeat the partner's number) and the package kind
 * are never read.
 */
export function parseChitChats(payload: unknown, raw: string): CarrierResult {
  const number = normalizeChitChatsNumber(raw);
  const shipment = isRecord(payload) ? payload.shipment : undefined;
  if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'Chit Chats returned an unexpected reply');
  if (text(shipment, 'shipment_id', 64).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Chit Chats returned another shipment');
  const rows = shipment.tracking_events;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Chit Chats returned a shipment without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Chit Chats returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const { key, event } = projectScan(row);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // Every shipment starts with its label scan; none at all says nothing.
  if (!events.length) throw new IndeterminateError(PROVIDER, 'Chit Chats returned no scans for the shipment');

  // The reply lists scans newest first. Partner clocks are not instants, so its order stands.
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const confirmed = text(shipment, 'resolution', 64) === 'delivery_confirmed';
  const stage = confirmed ? 'delivered' : staged?.stage as Stage | undefined;
  const source = confirmed && staged?.stage !== 'delivered' ? 'carrier_map' : staged?.stage_source;
  const weight = weightKg(text(shipment, 'weight_description', 32));
  const dimensions = text(shipment, 'size_description', 80);
  const service = text(shipment, 'postage_description', 80);
  const destination = text(shipment, 'to_country_code', 8).toUpperCase();
  const partner = carrierIdFromPartner(text(shipment, 'carrier', 64));
  const delivery = partnerNumber(text(shipment, 'carrier_tracking_code', 64), number);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: stage && FINAL.includes(stage) ? null : estimatedDay(text(shipment, 'estimated_delivery_at', 64)),
    ...(service ? { service_name: service } : {}),
    ...(weight !== undefined ? { weight_kg: weight } : {}),
    ...(dimensions ? { dimensions_text: dimensions } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    ...(partner && partner !== 'chit-chats' ? { delivery_carrier: partner } : {}),
    ...(delivery ? { delivery_tracking_number: delivery } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * Where an unknown shipment's redirect leads: the search page, which the
 * session then shows a notice on. Any other target says nothing.
 */
export function isSearchRedirect(location: string | null): boolean {
  if (!location) return false;
  try {
    const url = new URL(location, CHIT_CHATS_ORIGIN);
    return url.origin === CHIT_CHATS_ORIGIN && url.pathname === '/tracking' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

// The flash notice the search page script shows after the redirect.
const FLASH = /new Flash\('((?:[^'\\]|\\.){0,300})', '([a-z]{1,20})'\)/g;
const BLOCK_PAGE = /_cf_chl_opt|cf-turnstile|<title>Just a moment|<title>403 Forbidden/i;

/** A bot wall's or the web server's refusal page instead of Chit Chats' own. */
export function isChitChatsBlockPage(html: string): boolean {
  return BLOCK_PAGE.test(html);
}

/**
 * The search page after an unknown shipment's redirect. Only its notice
 * naming the whole shipment ID means the shipment is missing; Chit Chats
 * gives it for IDs it never issued and for shipments it no longer keeps.
 */
export function parseChitChatsSearch(html: string, number: string): never {
  if (isChitChatsBlockPage(html)) throw new ChallengeError(PROVIDER, 'Chit Chats answered with a block page');
  const notices = [...html.matchAll(FLASH)].map((match) => match[1]!);
  if (notices.some((notice) => notice.toUpperCase() === `NOTHING FOUND FOR SHIPMENT ID ${number}`)) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, notices.length ? 'Chit Chats refused the lookup' : 'Chit Chats sent the lookup to its search page without a notice');
}
