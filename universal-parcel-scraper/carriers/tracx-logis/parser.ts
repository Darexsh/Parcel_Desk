import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tracxHandoff } from './partners.js';
import { tracxStage } from './status.js';

export const PROVIDER = 'TracX Logis';
// The action's reply re-renders the tracking page with its result: under a hundred kilobytes.
export const TRACX_MAX_BYTES = 1_000_000;

const NUMBER = /^QSP\d{9}$/;
const MAX_SCANS = 500;
const MAX_EVENTS = 100;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenge-platform|awswaf|captcha/i;
/** Next's notFound() and redirect() travel as error rows, and mean the route changed. */
const NEXT_CONTROL = /^(?:NEXT_NOT_FOUND$|NEXT_HTTP_ERROR_FALLBACK;|NEXT_REDIRECT;)/;
// The fields of the parcel's summary; every one is null for a number the tracker does not know.
const SUMMARY_FIELDS = ['ShippingNo', 'DeliveryNo', 'TrackingNo', 'InputNo', 'LastmileShippingCompany', 'StartNationCd', 'DeliveryNationCd'];

/**
 * The tracker no longer has the action the request named: it answered with
 * Next's reply for an unknown action, or with its page.
 */
export class UnknownActionError extends SchemaError {
  constructor() {
    super(PROVIDER, 'TracX Logis no longer knows the action asked: the tracking lookup changed');
    this.name = 'UnknownActionError';
  }
}

/** Whether a page is a CDN's or firewall's browser check. */
export function isChallengePage(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

/** TracX Logis's own numbers, QSP and nine digits, as its tracker prints them; anything else is not one it issues. */
export function normalizeTracxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TracX Logis numbers are QSP and nine digits');
  return number;
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

function decode(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'TracX Logis returned an unreadable reply', { cause });
  }
}

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
    // Hint rows (`:HL[…]`) have no id.
    if (id !== '' && !/^[0-9a-f]{1,8}$/.test(id)) throw new SchemaError(PROVIDER, 'TracX Logis returned an unreadable reply');
    if (colon < 0) throw new SchemaError(PROVIDER, 'TracX Logis returned an unreadable reply');
    at = colon + 1;
    if (id !== '' && LENGTH_TAGS.has(bytes[at]!)) {
      const comma = bytes.indexOf(COMMA, at);
      const length = comma < 0 ? '' : ascii(bytes.subarray(at + 1, Math.min(comma, at + 10)));
      if (!/^[0-9a-f]{1,8}$/.test(length)) throw new SchemaError(PROVIDER, 'TracX Logis returned an unreadable reply');
      const end = comma + 1 + parseInt(length, 16);
      if (end > bytes.length) throw new SchemaError(PROVIDER, 'TracX Logis returned a truncated reply');
      if (bytes[at] === 0x54) rows.set(id, { kind: 'text', text: decode(bytes.subarray(comma + 1, end)) });
      at = end;
      continue;
    }
    const end = bytes.indexOf(LINE_FEED, at);
    const stop = end < 0 ? bytes.length : end;
    const row = decode(bytes.subarray(at, stop));
    at = stop + 1;
    if (id === '') continue;
    if (row.startsWith('E{')) rows.set(id, { kind: 'error', digest: errorDigest(row.slice(1)) });
    else if (/^(?:[[{"\d-]|null$|true$|false$)/.test(row)) rows.set(id, { kind: 'json', json: row });
  }
  return rows;
}

function parsedRow(row: Row | undefined): unknown {
  if (row?.kind !== 'json') return undefined;
  try {
    return JSON.parse(row.json);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'TracX Logis returned an unreadable reply', { cause });
  }
}

/**
 * What the page's server action returned. Row 0 names the row that holds it,
 * as `{"a":"$@1",…}`; a thrown action leaves an error row there instead. The
 * result is plain JSON whose strings Flight escapes: `$$` for a leading
 * dollar, `$undefined` for an absent value, and a text row for a long string.
 */
export function actionResult(bytes: Uint8Array): unknown {
  const rows = flightRows(bytes);
  const head = parsedRow(rows.get('0'));
  const pointer: unknown = isRecord(head) ? head.a : Array.isArray(head) ? (head as unknown[])[0] : undefined;
  const target = typeof pointer === 'string' ? /^\$@([0-9a-f]{1,8})$/.exec(pointer)?.[1] : undefined;
  if (target === undefined) throw new SchemaError(PROVIDER, 'TracX Logis returned a reply without its lookup result');
  const found = rows.get(target);
  if (found?.kind === 'error') {
    if (NEXT_CONTROL.test(found.digest)) throw new SchemaError(PROVIDER, 'TracX Logis redirected or dropped its tracking page');
    throw new IndeterminateError(PROVIDER, 'TracX Logis could not complete the lookup');
  }
  if (found?.kind !== 'json') throw new SchemaError(PROVIDER, 'TracX Logis returned a reply without its lookup result');
  let nodes = 0;
  const resolve = (node: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 50_000 || depth > 16) throw new SchemaError(PROVIDER, 'TracX Logis returned an oversized reply');
    if (typeof node === 'string') {
      if (!node.startsWith('$')) return node;
      if (node.startsWith('$$')) return node.slice(1);
      if (node === '$undefined') return undefined;
      const text = rows.get(/^\$([0-9a-f]{1,8})$/.exec(node)?.[1] ?? '');
      if (text?.kind === 'text') return text.text;
      // A Date, a reference to an object or any other Flight value is not what this lookup returns.
      throw new SchemaError(PROVIDER, 'TracX Logis returned an unexpected value');
    }
    if (Array.isArray(node)) return node.map((child: unknown) => resolve(child, depth + 1));
    if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, resolve(child, depth + 1)]));
    return node;
  };
  return resolve(parsedRow(found), 0);
}

/**
 * The action's reply as the transport read it: a Flight stream, or a page in
 * its place. A page is a browser check, or Next's answer to an action it no
 * longer has.
 */
export function readActionReply(bytes: Uint8Array, contentType: string | null): unknown {
  if (!/^text\/x-component\b/i.test(contentType ?? '')) {
    const head = decode(bytes.subarray(0, 64_000));
    if (isChallengePage(head)) throw new ChallengeError(PROVIDER, 'TracX Logis answered with a browser check');
    if (/^\s*</.test(head)) throw new UnknownActionError();
    throw new SchemaError(PROVIDER, 'TracX Logis returned an unexpected reply');
  }
  return actionResult(bytes);
}

/** An optional text field; anything but a string is a changed reply. */
function text(record: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TracX Logis returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Markup the page renders in a scan's note, as plain text. */
function plain(html: string): string {
  return clean(html.replace(/<br\s*\/?>/gi, '. ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'"))
    .replace(/(?:\s*\.)+\s*$/, '').replace(/\s*\.\s*\.\s*/g, '. ');
}

function projectScan(row: Record<string, unknown>): { key: string; timestamp: number; event: CarrierEvent } {
  const code = text(row, 'Status', 16).toUpperCase();
  const reason = text(row, 'Reason', 16).toUpperCase();
  const wording = text(row, 'StatusDesc');
  if (!wording) throw new SchemaError(PROVIDER, 'TracX Logis returned a scan without wording');
  const why = plain(text(row, 'ReasonDesc', 500));
  const description = why && why.toLowerCase() !== wording.toLowerCase() ? `${wording}: ${why}` : wording;
  const stamp = text(row, 'UTCDate', 40);
  const instant = INSTANT.test(stamp) ? explicitOffsetTime(stamp) : null;
  if (!instant) throw new SchemaError(PROVIDER, 'TracX Logis returned an invalid scan time');
  const location = text(row, 'Location', 120);
  const providerCode = code && reason ? `${code}:${reason}` : code;
  const staged = tracxStage(providerCode, wording);
  const event: CarrierEvent = {
    time: instant.iso,
    description,
    ...(location ? { location } : {}),
    ...(providerCode ? { provider_code: providerCode } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([instant.timestamp, providerCode, description, location]), timestamp: instant.timestamp, event };
}

/**
 * The result of the tracking page's `getTrackingHistory` action for one
 * number: `dataInfo`, the parcel's summary, and `history`, its scans. A
 * number the tracker does not know comes back with every summary field null
 * and no scans. The tracker also finds a parcel by its last-mile or delivery
 * number, so the parcel counts only when its own number is the one asked.
 * The recipient's name, the order's reference, the courier in charge of each
 * scan and a scan's details, flight times in several local clocks, are left out.
 */
export function parseTracx(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTracxNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.dataInfo) || !Array.isArray(payload.history)) {
    throw new SchemaError(PROVIDER, 'TracX Logis returned an invalid envelope');
  }
  const summary = payload.dataInfo;
  const rows = payload.history;
  if (rows.length === 0 && SUMMARY_FIELDS.every(key => summary[key] === null)) throw new NotFoundError(PROVIDER);
  const shipping = text(summary, 'ShippingNo', 64);
  if (!shipping) throw new SchemaError(PROVIDER, 'TracX Logis returned a parcel without its number');
  if (normalizeTrackingNumber(shipping) !== number) throw new IndeterminateError(PROVIDER, 'TracX Logis answered for another parcel');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'TracX Logis returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'TracX Logis returned an invalid scan');
    const scan = projectScan(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((left, right) => right.timestamp - left.timestamp).map(scan => scan.event);

  const newest = events[0]!;
  const staged = events.find(event => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const destination = text(summary, 'DeliveryNationCd', 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    ...tracxHandoff(text(summary, 'LastmileShippingCompany', 80), text(summary, 'TrackingNo', 64), number),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
