import { DateTime } from 'luxon';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { transcorpLabel, transcorpStage } from './status.js';

export const PROVIDER = 'Transcorp';
// A delivered parcel's reply is under 50 kilobytes.
export const TRANSCORP_MAX_BYTES = 1_000_000;
const MAX_NODES = 250_000;
const MAX_EVENTS = 100;

/** Elite's airwaybills are ten digits. */
const NUMBER = /^\d{10}$/;

/** The airwaybill as the tracker takes it: ten digits, nothing else. */
export function normalizeTranscorpNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Elite airwaybills are ten digits');
  return number;
}

// Row tags whose payload gives its length in bytes, as hex before a comma, and
// ends without a line feed: text, a stream's chunks, and typed arrays.
const LENGTH_TAGS = new Set([...'TAOoUSsLlGgMmV'].map((tag) => tag.charCodeAt(0)));
const COLON = 0x3a;
const COMMA = 0x2c;
const LINE_FEED = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
/** Next's notFound() and redirect() travel as error rows, and mean the route changed. */
const NEXT_CONTROL = /^(?:NEXT_NOT_FOUND$|NEXT_HTTP_ERROR_FALLBACK;|NEXT_REDIRECT;)/;
// Bot checks the host could put in place of the page.
export const CHALLENGE = /Vercel Security Checkpoint|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

/** The digest of an error row; an unreadable one is an empty digest, never a Next signal. */
function errorDigest(json: string): string {
  try {
    const error: unknown = JSON.parse(json);
    return isRecord(error) && typeof error.digest === 'string' ? error.digest : '';
  } catch {
    return '';
  }
}

/**
 * The JSON rows of a React Server Components reply, and the digests of its
 * error rows. Text rows and the chunks of a stream row end where their byte
 * length does, often with the next row on the same line, so rows are read by
 * length, not split at line feeds. The page streams a copy of itself in such
 * chunks; it is skipped with them.
 */
function flightRows(bytes: Uint8Array): { rows: unknown[]; failures: string[] } {
  const rows: unknown[] = [];
  const failures: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (bytes[at] === LINE_FEED) { at += 1; continue; }
    const colon = bytes.indexOf(COLON, at);
    const id = colon < 0 ? '' : ascii(bytes.subarray(at, Math.min(colon, at + 9)));
    if (colon < 0 || !/^[0-9a-f]{0,8}$/.test(id)) throw new SchemaError(PROVIDER, 'Elite returned an unreadable page');
    at = colon + 1;
    if (LENGTH_TAGS.has(bytes[at]!) && /^[0-9a-f]{1,8},/.test(ascii(bytes.subarray(at + 1, at + 11)))) {
      const comma = bytes.indexOf(COMMA, at);
      at = comma + 1 + parseInt(ascii(bytes.subarray(at + 1, comma)), 16);
      if (at > bytes.length) throw new SchemaError(PROVIDER, 'Elite returned a truncated page');
      continue;
    }
    const end = bytes.indexOf(LINE_FEED, at);
    const stop = end < 0 ? bytes.length : end;
    let row: string;
    try { row = utf8.decode(bytes.subarray(at, stop)); }
    catch (cause) { throw new SchemaError(PROVIDER, 'Elite returned an unreadable page', { cause }); }
    at = stop + 1;
    if (row.startsWith('E{')) failures.push(errorDigest(row.slice(1)));
    else if (id && /^[[{]/.test(row)) {
      try { rows.push(JSON.parse(row)); }
      catch { /* A row that is not JSON holds neither a shipment nor its absence. */ }
    }
  }
  return { rows, failures };
}

type Element = [string, unknown, unknown, Record<string, unknown>];
const isElement = (node: unknown): node is Element => Array.isArray(node) && node.length === 4 && node[0] === '$' && isRecord(node[3]);

/**
 * The tracker's answers: a lazily rendered component keyed with the reference
 * asked, holding either the shipment or an error message.
 */
function answers(rows: unknown[]): { key: string; props: Record<string, unknown> }[] {
  const found: { key: string; props: Record<string, unknown> }[] = [];
  const stack: unknown[] = [...rows];
  for (let visited = 0; stack.length; visited += 1) {
    if (visited > MAX_NODES) throw new SchemaError(PROVIDER, 'Elite returned an oversized page');
    const node = stack.pop();
    if (Array.isArray(node)) {
      if (isElement(node) && typeof node[1] === 'string' && node[1].startsWith('$L') && typeof node[2] === 'string'
        && (Object.hasOwn(node[3], 'shipment') || (typeof node[3].error === 'string' && !node[3].error.startsWith('$')))) {
        found.push({ key: node[2], props: node[3] });
        continue;
      }
      for (const child of node) stack.push(child);
    } else if (isRecord(node)) {
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return found;
}

/** A value of the reply: `$undefined` is no value, `$$` escapes a literal dollar and other `$` values are references. */
function plain(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('$')) return value;
  return value.startsWith('$$') ? value.slice(1) : undefined;
}

function text(record: unknown, key: string, maxLength = 120): string {
  return isRecord(record) ? clean(plain(record[key]), maxLength) : '';
}

/** The shipment's weight in kilograms: the weighed total, else the declared weight. */
function weightKg(shipment: Record<string, unknown>): number | undefined {
  for (const key of ['actualTotalWeight', 'weight']) {
    const weight = plain(shipment[key]);
    if (!isRecord(weight) || typeof weight.value !== 'number' || !Number.isFinite(weight.value) || weight.value <= 0) continue;
    const unit = clean(weight.unit, 8).toLowerCase();
    if (unit === 'kg') return Math.round(weight.value * 1000) / 1000;
    if (unit === 'g') return Math.round(weight.value) / 1000;
  }
  return undefined;
}

const SERVICES: Readonly<Record<string, string>> = {
  AIR_FREIGHT: 'Air Freight', BULLET: 'Bullet', COLD_CHAIN: 'Cold Chain', COURIER: 'Courier', EXPRESS: 'Express',
  FOUR_HOUR: 'Four Hour', NORMAL: 'Normal', SAME_DAY: 'Same Day',
};

const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Where an event happened: its region and country. A region given as a
 * subdivision code, the street, the area within the region and the
 * coordinates are not kept.
 */
function place(location: unknown): string {
  if (!isRecord(location)) return '';
  const code = countryCode(text(location, 'country', 8));
  const country = code ? ENGLISH_REGIONS.of(code) ?? '' : '';
  const region = text(location, 'subdivision', 60);
  return [/^[A-Z0-9]{1,3}$/.test(region) ? '' : region, country].filter(Boolean).join(', ');
}

interface Scan { event: CarrierEvent; at: number; index: number; code: string }

// The legacy portal's clocks were read as Dubai time, whatever country it ran in.
const LEGACY_CLOCK_ZONE = 'Asia/Dubai';

/**
 * An event's clock. A current event's timestamp is an instant. An event moved
 * from the legacy portal keeps that country's wall clock behind a Dubai
 * offset; it is read again in the shipment's country, and stays a wall clock
 * when the country has no single zone.
 */
function scanClock(row: Record<string, unknown>, zone: string | null): { clock: Partial<CarrierEvent>; at: number } {
  const stamped = explicitOffsetTime(row.timestamp);
  if (!stamped) throw new SchemaError(PROVIDER, 'Elite returned an event without its time');
  if (row.__legacy !== true) return { clock: { time: stamped.iso }, at: stamped.timestamp };
  const legacy = DateTime.fromMillis(stamped.timestamp, { zone: LEGACY_CLOCK_ZONE });
  if (!zone) return { clock: { local_time: legacy.toISO({ includeOffset: false, suppressMilliseconds: true })! }, at: stamped.timestamp };
  const { year, month, day, hour, minute, second, millisecond } = legacy;
  const local = firstOccurrence(DateTime.fromObject({ year, month, day, hour, minute, second, millisecond }, { zone }));
  return { clock: { time: local.toISO({ suppressMilliseconds: true })! }, at: local.toMillis() };
}

function projectScan(row: unknown, index: number, zone: string | null): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Elite returned an invalid event');
  const code = text(row, 'type', 64).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new SchemaError(PROVIDER, 'Elite returned an event without its type');
  const { clock, at } = scanClock(row, zone);
  const location = place(plain(row.location));
  return {
    event: { ...clock, description: transcorpLabel(code), ...(location ? { location } : {}), provider_code: code },
    at, index, code,
  };
}

/**
 * The shipment's events, newest first. A pickup is an acceptance only before
 * anything else moved the parcel.
 */
function history(rows: unknown[], zone: string | null): CarrierEvent[] {
  // Equal clocks keep the reply's order, which lists the newest first.
  const oldestFirst = rows.map((row, index) => projectScan(row, index, zone))
    .sort((left, right) => left.at - right.at || right.index - left.index);
  let moved = false;
  for (const scan of oldestFirst) {
    const staged = transcorpStage(scan.code, moved);
    if (staged) Object.assign(scan.event, { stage: staged.stage, stage_source: staged.source });
    if (staged && staged.stage !== 'registered' && staged.stage !== 'pending') moved = true;
  }
  return oldestFirst.reverse().map((scan) => scan.event);
}

/**
 * The country a shipment goes to: the consignee's, else the country whose
 * legacy portal delivers it.
 */
function destination(shipment: Record<string, unknown>, operating: string | null): string | null {
  const consignee = plain(shipment.consignee);
  const own = isRecord(consignee) ? countryCode(text(plain(consignee.location), 'country', 8)) : null;
  if (own) return own;
  return shipment.__legacy === true && text(shipment, 'orderType', 32) === 'DELIVERY' ? operating : null;
}

function project(shipment: Record<string, unknown>): CarrierResult {
  const operating = countryCode(text(shipment, 'operatingCountry', 8));
  const zone = operating ? countryTimeZone(operating) : null;
  const rows = plain(shipment.shipmentTrackingEvents);
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Elite returned a shipment without its events');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'Elite has no events for the shipment yet');
  const events = history(rows, zone);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const weight = weightKg(shipment);
  const serviceCode = text(shipment, 'serviceType', 32);
  const service = SERVICES[serviceCode] ?? (serviceCode ? transcorpLabel(serviceCode) : '');
  const country = destination(shipment, operating);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description ?? null,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(stage === 'delivered' && current?.time ? { delivered_at: current.time } : {}),
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(zone ? { timezone: zone } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The React Server Components reply of
 * `app.elite-co.com/shipments/track?references={number}`. The page renders
 * one component keyed with the reference: the shipment with its events, or
 * the backend's message, "shipment with reference … does not exist" for a
 * number Elite does not know.
 */
export function parseTranscorp(bytes: Uint8Array, contentType: string | null, raw: string): CarrierResult {
  const number = normalizeTranscorpNumber(raw);
  const type = (contentType ?? '').toLowerCase();
  if (!bytes.length) throw new IndeterminateError(PROVIDER, 'Elite returned an empty tracking reply');
  const head = ascii(bytes.subarray(0, 64));
  if (type.includes('text/html') || /^\s*</.test(head)) {
    const page = new TextDecoder().decode(bytes.subarray(0, 64_000));
    if (CHALLENGE.test(page)) throw new ChallengeError(PROVIDER, 'Elite answered with a browser check');
    throw new SchemaError(PROVIDER, 'Elite answered with a web page instead of tracking data');
  }
  if (!type.includes('text/x-component')) throw new SchemaError(PROVIDER, 'Elite returned an unexpected tracking reply');
  const { rows, failures } = flightRows(bytes);
  const found = answers(rows);
  if (!found.length) {
    if (failures.some((digest) => NEXT_CONTROL.test(digest))) throw new SchemaError(PROVIDER, 'Elite redirected or dropped its tracking page');
    if (failures.length) throw new IndeterminateError(PROVIDER, 'Elite could not render the tracking page');
    throw new SchemaError(PROVIDER, 'Elite returned no tracking answer');
  }
  if (found.length > 1) throw new SchemaError(PROVIDER, 'Elite returned several answers');
  const { key, props } = found[0]!;
  if (key !== number) throw new IndeterminateError(PROVIDER, 'Elite answered for another number');

  if (typeof props.error === 'string') {
    const message = clean(props.error, 300);
    if (message === `shipment with reference ${number} does not exist`) throw new NotFoundError(PROVIDER);
    if (/^failed to get shipment$/i.test(message)) throw new IndeterminateError(PROVIDER, 'Elite could not look the shipment up');
    if (/does not exist/i.test(message)) throw new IndeterminateError(PROVIDER, 'Elite answered for another number');
    throw new SchemaError(PROVIDER, 'Elite returned an unknown tracking message');
  }
  const shipment = plain(props.shipment);
  if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'Elite returned an unreadable shipment');
  if (text(shipment, 'houseWaybillNumber', 64) !== number) throw new IndeterminateError(PROVIDER, 'Elite answered for another number');
  return project(shipment);
}
