import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { nipostStage } from './status.js';

export const PROVIDER = 'NIPOST';
// A long history is a few tens of kilobytes; the page that a stale lookup returns is smaller.
export const NIPOST_MAX_BYTES = 1_000_000;

const MAX_SCANS = 500;
const MAX_NODES = 100_000;
const MAX_DEPTH = 32;
/** The lookup's whole answer for a number it does not know. */
const ABSENT = 'Tracking number not found';
/** Next's notFound() and redirect() travel as error rows, and mean the route changed. */
const NEXT_CONTROL = /^(?:NEXT_NOT_FOUND$|NEXT_HTTP_ERROR_FALLBACK;|NEXT_REDIRECT;)/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;
const OFFSET_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,9})?$/;

/**
 * The tracker no longer has the action the request named: it answered with its
 * page, or with Next's reply for an unknown action.
 */
export class UnknownActionError extends SchemaError {
  constructor() {
    super(PROVIDER, 'NIPOST no longer knows the action asked: the tracking lookup changed');
    this.name = 'UnknownActionError';
  }
}

/** Whether a page is a CDN's or firewall's browser check. */
export function isChallengePage(html: string): boolean {
  return CHALLENGE.test(html);
}

/**
 * NIPOST's tracker takes UPU S10 item codes: its own, ending NG, and those of
 * the posts that send mail to Nigeria. The code needs a valid check digit,
 * and a comma, which would ask for several items at once, is never sent.
 */
export function normalizeNipostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'NIPOST tracks S10 item codes');
}

// Row tags whose payload gives its length in bytes, as hex before a comma, and
// ends without a line feed: text, and typed arrays.
const LENGTH_TAGS = new Set([...'TAOoUSsLlGgMmV'].map(tag => tag.charCodeAt(0)));
const COLON = 0x3a;
const COMMA = 0x2c;
const LINE_FEED = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

type Row = { kind: 'json'; json: string } | { kind: 'text'; text: string } | { kind: 'error'; digest: string };

/** The digest of an error row; an unreadable one is an empty digest, never a Next signal. */
function errorDigest(json: string): string {
  try {
    const error: unknown = JSON.parse(json);
    return isRecord(error) && typeof error.digest === 'string' ? error.digest : '';
  } catch {
    return '';
  }
}

function decode(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'NIPOST returned an unreadable reply', { cause });
  }
}

/**
 * The rows of a React Server Components reply by id. A text row ends where its
 * byte length does, so rows are read by length, not split at line feeds. Hint
 * and module rows are skipped.
 */
function flightRows(bytes: Uint8Array): Map<string, Row> {
  const rows = new Map<string, Row>();
  let at = 0;
  while (at < bytes.length) {
    if (bytes[at] === LINE_FEED) { at += 1; continue; }
    const colon = bytes.indexOf(COLON, at);
    const id = colon < 0 ? '' : ascii(bytes.subarray(at, Math.min(colon, at + 9)));
    if (!/^[0-9a-f]{1,8}$/.test(id)) throw new SchemaError(PROVIDER, 'NIPOST returned an unreadable reply');
    at = colon + 1;
    if (LENGTH_TAGS.has(bytes[at]!)) {
      const comma = bytes.indexOf(COMMA, at);
      const length = comma < 0 ? '' : ascii(bytes.subarray(at + 1, Math.min(comma, at + 10)));
      if (!/^[0-9a-f]{1,8}$/.test(length)) throw new SchemaError(PROVIDER, 'NIPOST returned an unreadable reply');
      const end = comma + 1 + parseInt(length, 16);
      if (end > bytes.length) throw new SchemaError(PROVIDER, 'NIPOST returned a truncated reply');
      if (bytes[at] === 0x54) rows.set(id, { kind: 'text', text: decode(bytes.subarray(comma + 1, end)) });
      at = end;
      continue;
    }
    const end = bytes.indexOf(LINE_FEED, at);
    const stop = end < 0 ? bytes.length : end;
    const row = decode(bytes.subarray(at, stop));
    at = stop + 1;
    if (row.startsWith('E{')) rows.set(id, { kind: 'error', digest: errorDigest(row.slice(1)) });
    else if (/^(?:[[{"\d-]|null$|true$|false$)/.test(row)) rows.set(id, { kind: 'json', json: row });
  }
  return rows;
}

/** A Date the reply sent as one; Flight writes it as its UTC instant. */
class FlightDate {
  constructor(readonly iso: string) {}
}

/** Any other Flight value, such as a symbol or a server reference: present, but never data the parser reads. */
class Opaque {}

/**
 * Flight values as plain ones: `$$` escapes a dollar, `$undefined` is absent,
 * `$D` is a Date, and `$` with a hex id refers to another row.
 */
function resolver(rows: Map<string, Row>) {
  let nodes = 0;
  const parsed = new Map<string, unknown>();
  const open = new Set<string>();
  const row = (id: string, depth: number): unknown => {
    const found = rows.get(id);
    if (!found || found.kind === 'error' || open.has(id)) throw new SchemaError(PROVIDER, 'NIPOST returned an unreadable reply');
    if (found.kind === 'text') return found.text;
    if (!parsed.has(id)) {
      try {
        parsed.set(id, JSON.parse(found.json));
      } catch (cause) {
        throw new SchemaError(PROVIDER, 'NIPOST returned an unreadable reply', { cause });
      }
    }
    open.add(id);
    try {
      return value(parsed.get(id), depth + 1);
    } finally {
      open.delete(id);
    }
  };
  const value = (node: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new SchemaError(PROVIDER, 'NIPOST returned an oversized reply');
    if (typeof node === 'string') {
      if (!node.startsWith('$')) return node;
      if (node.startsWith('$$')) return node.slice(1);
      if (node === '$undefined') return undefined;
      if (node.startsWith('$D')) return new FlightDate(node.slice(2));
      const reference = /^\$@?([0-9a-f]{1,8})$/.exec(node)?.[1];
      return reference === undefined ? new Opaque() : row(reference, depth);
    }
    if (Array.isArray(node)) return node.map((child: unknown) => value(child, depth + 1));
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = value(child, depth + 1);
      return out;
    }
    return node;
  };
  return row;
}

/**
 * What the page's server action returned: row 0 names the row that holds it.
 * A thrown action leaves an error row there instead.
 */
function actionResult(rows: Map<string, Row>): unknown {
  const head = rows.get('0');
  let target: string | undefined;
  try {
    const parsed: unknown = head?.kind === 'json' ? JSON.parse(head.json) : null;
    target = Array.isArray(parsed) && typeof parsed[0] === 'string' ? /^\$@([0-9a-f]{1,8})$/.exec(parsed[0])?.[1] : undefined;
  } catch {
    target = undefined;
  }
  if (target === undefined) throw new SchemaError(PROVIDER, 'NIPOST returned a reply without its lookup result');
  const found = rows.get(target);
  if (found?.kind === 'error') {
    if (NEXT_CONTROL.test(found.digest)) throw new SchemaError(PROVIDER, 'NIPOST redirected or dropped its tracking page');
    throw new IndeterminateError(PROVIDER, 'NIPOST could not complete the lookup');
  }
  return resolver(rows)(target, 0);
}

/** An optional text field; anything but a string is a changed reply. */
function text(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `NIPOST returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional nested object; anything but an object or null is a changed reply. */
function record(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = parent[key];
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || value instanceof FlightDate || value instanceof Opaque) {
    throw new SchemaError(PROVIDER, `NIPOST returned an invalid ${key}`);
  }
  return value;
}

type Clock = { time: string; timestamp: number } | { local_time: string; timestamp: number };

/**
 * A clock as the reply gives it. One with an offset, or a Date, is an instant.
 * One without names a wall clock in no stated zone: the tracker relays scans
 * from Nigerian offices and from the posts that send mail there alike, so it
 * stays `local_time`, to the second.
 */
function clockOf(value: unknown): Clock | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = value instanceof FlightDate ? value.iso : typeof value === 'string' ? clean(value, 64) : '';
  if (OFFSET_CLOCK.test(raw)) {
    const instant = explicitOffsetTime(raw);
    if (instant) return { time: instant.iso, timestamp: instant.timestamp };
  } else if (!(value instanceof FlightDate)) {
    const [, day, minute] = WALL_CLOCK.exec(raw) ?? [];
    const local = day && minute ? `${day}T${minute}` : '';
    // Parsing in UTC checks the calendar fields only; no offset is assigned.
    const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
    if (parsed?.isValid && parsed.toFormat(minute!.length > 5 ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm") === local) {
      return { local_time: local, timestamp: parsed.toMillis() };
    }
  }
  throw new SchemaError(PROVIDER, 'NIPOST returned an invalid scan time');
}

/** The page's own rendering of a status key, such as IN_TRANSIT as "In Transit". */
function keyWording(key: string): string {
  return key.toLowerCase().split('_').filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

interface Scan { event: CarrierEvent & { description: string }; timestamp: number; index: number }

function scanOf(raw: unknown, index: number): Scan {
  if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'NIPOST returned an invalid scan');
  const status = record(raw, 'status');
  const key = status ? text(status, 'key', 64).toUpperCase() : '';
  if (key && !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new SchemaError(PROVIDER, 'NIPOST returned an invalid status key');
  // The page prints the scan's description under its key; a key alone reads as the page labels it.
  const description = text(raw, 'description', 300) || (status ? text(status, 'value', 200) : '') || (key ? keyWording(key) : '');
  if (!description) throw new SchemaError(PROVIDER, 'NIPOST returned a scan without wording');
  const clock = clockOf(raw.timestamp);
  if (!clock) throw new SchemaError(PROVIDER, 'NIPOST returned a scan without a time');
  // The page shows `location_description`; `notes` repeats it with a label.
  const location = text(raw, 'location_description', 200);
  const staged = nipostStage(key, description);
  const { timestamp, ...when } = clock;
  const event = {
    ...when,
    ...(location ? { location } : {}),
    description,
    ...(key ? { provider_code: key } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, timestamp, index };
}

/** The reply's entry for the number, by the field the page names it with. */
function entryFor(data: unknown[], number: string): Record<string, unknown> {
  if (data.length !== 1) throw new SchemaError(PROVIDER, 'NIPOST returned several items for one code');
  const entry = data[0];
  if (!isRecord(entry)) throw new SchemaError(PROVIDER, 'NIPOST returned an invalid item');
  const named = text(entry, 'tracking_number', 64) || text(entry, 'code', 64);
  if (!named) throw new SchemaError(PROVIDER, 'NIPOST returned an item without its code');
  if (normalizeTrackingNumber(named) !== number) throw new SchemaError(PROVIDER, 'NIPOST answered for a different item');
  return entry;
}

/** The country the item is bound for, when the reply gives its ISO code. */
function destinationCountry(entry: Record<string, unknown>): string {
  const destination = record(entry, 'destination');
  const country = destination ? record(destination, 'country') : null;
  const code = country ? text(country, 'code', 8).toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

/**
 * The reply of the tracking page's server action for one code:
 * `{ data, error }`, where `data` lists the items the code names, each with
 * its scans. An unknown code is `data: null` with the error "Tracking number
 * not found". Origin, customs payment details and their payment link are
 * never read.
 */
export function parseNipost(body: Uint8Array | string, contentType: string | null, rawNumber: string): CarrierResult {
  const number = normalizeNipostNumber(rawNumber);
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const head = new TextDecoder().decode(bytes.subarray(0, 64_000));
  if (!head.trim()) throw new IndeterminateError(PROVIDER, 'NIPOST returned an empty reply');
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('text/html') || /^\s*</.test(head)) {
    if (CHALLENGE.test(head)) throw new ChallengeError(PROVIDER, 'NIPOST answered with a browser check');
    // An action id the deployed page no longer has gets the page itself back.
    if (head.includes('/_next/static/')) throw new UnknownActionError();
    throw new ChallengeError(PROVIDER, 'NIPOST answered with a web page instead of tracking data');
  }
  if (/^\s*Server action not found/i.test(head)) throw new UnknownActionError();
  if (!type.includes('text/x-component')) throw new SchemaError(PROVIDER, 'NIPOST returned an unexpected tracking reply');

  const payload = actionResult(flightRows(bytes));
  if (!isRecord(payload) || !('data' in payload)) throw new SchemaError(PROVIDER, 'NIPOST returned an invalid reply');
  const error = payload.error;
  if (error !== null && error !== undefined) {
    if (typeof error !== 'string') throw new SchemaError(PROVIDER, 'NIPOST returned an invalid error');
    const message = clean(error, 200);
    if (message === ABSENT && payload.data === null) throw new NotFoundError(PROVIDER);
    if (/too many|rate limit/i.test(message)) throw new RateLimitedError(PROVIDER);
    // Any other message is the tracker's own failure, which says nothing of the item.
    throw new IndeterminateError(PROVIDER, 'NIPOST could not complete the lookup');
  }
  if (payload.data === null || payload.data === undefined) throw new IndeterminateError(PROVIDER, 'NIPOST returned no item for the code');
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'NIPOST returned an invalid reply');
  if (!payload.data.length) throw new IndeterminateError(PROVIDER, 'NIPOST returned no item for the code');
  const entry = entryFor(payload.data, number);
  const scans = entry.events ?? [];
  if (!Array.isArray(scans)) throw new SchemaError(PROVIDER, 'NIPOST returned an item with invalid scans');
  if (scans.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'NIPOST returned an oversized history');
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'NIPOST returned the item without scans');

  const seen = new Set<string>();
  const kept: Scan[] = [];
  scans.forEach((raw: unknown, index) => {
    const scan = scanOf(raw, index);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    kept.push(scan);
  });
  // Newest first, as the page lists them. Wall clocks order as read in UTC; a
  // tie shows the later of the reply's scans first, as the page does.
  kept.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const events = kept.map(({ event }) => event);

  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? clockOf(entry.date_delivered) : null;
  const country = destinationCountry(entry);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(delivered && 'time' in delivered ? { delivered_at: delivered.time } : {}),
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
