import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { daiPostScanZone } from './clock.js';
import { daiPostStage } from './status.js';

export const PROVIDER = 'DAI Post';
export const DAI_POST_MAX_BYTES = 1_000_000;
const MAX_SCANS = 300;
const MAX_NODES = 250_000;
const ABSENT = "Sorry, we couldn't find your parcel.";
/** Next's notFound() and redirect() travel as error rows, and mean the route changed. */
const NEXT_CONTROL = /^(?:NEXT_NOT_FOUND$|NEXT_HTTP_ERROR_FALLBACK;|NEXT_REDIRECT;)/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/;
const ESTIMATE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * DAI Post tracks the numbers its shippers print, in several formats: an SSCC,
 * NZC and nine digits, a shipper's own prefix and digits. Letters and digits
 * only, so a list separator cannot ask for several parcels at once.
 */
export function normalizeDaiPostNumber(raw: string): string {
  const number = raw.length <= 80 ? normalizeTrackingNumber(raw) : '';
  if (!/^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'DAI Post tracking numbers are 8 to 40 letters and digits');
  }
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
 * error rows. A text row ends where its byte length does, often with the next
 * row on the same line, so rows are read by length, not split at line feeds.
 * Text, hint and module rows are skipped.
 */
export function flightRows(bytes: Uint8Array): { rows: unknown[]; failures: string[] } {
  const rows: unknown[] = [];
  const failures: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (bytes[at] === LINE_FEED) { at += 1; continue; }
    const colon = bytes.indexOf(COLON, at);
    if (colon < 0 || !/^[0-9a-f]{1,8}$/.test(ascii(bytes.subarray(at, Math.min(colon, at + 9))))) {
      throw new SchemaError(PROVIDER, 'DAI Post returned an unreadable page');
    }
    at = colon + 1;
    if (LENGTH_TAGS.has(bytes[at]!)) {
      const comma = bytes.indexOf(COMMA, at);
      const length = comma < 0 ? '' : ascii(bytes.subarray(at + 1, Math.min(comma, at + 10)));
      if (!/^[0-9a-f]{1,8}$/.test(length)) throw new SchemaError(PROVIDER, 'DAI Post returned an unreadable page');
      at = comma + 1 + parseInt(length, 16);
      if (at > bytes.length) throw new SchemaError(PROVIDER, 'DAI Post returned a truncated page');
      continue;
    }
    const end = bytes.indexOf(LINE_FEED, at);
    const stop = end < 0 ? bytes.length : end;
    let row: string;
    try { row = utf8.decode(bytes.subarray(at, stop)); }
    catch (cause) { throw new SchemaError(PROVIDER, 'DAI Post returned an unreadable page', { cause }); }
    at = stop + 1;
    if (row.startsWith('E{')) failures.push(errorDigest(row.slice(1)));
    else if (row.startsWith('[') || row.startsWith('{')) {
      try { rows.push(JSON.parse(row)); }
      catch { /* A row that is not JSON holds neither a parcel nor its absence. */ }
    }
  }
  return { rows, failures };
}

/** A string as Flight writes it. `$$` escapes a dollar; any other `$` value is `$undefined` or a reference. */
function flightText(value: string): string | undefined {
  if (value.startsWith('$$')) return value.slice(1);
  return value.startsWith('$') ? undefined : value;
}

/** An optional text field; `$undefined` and null are absent, references and objects are not text. */
function field(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined || value === '$undefined') return '';
  const text = typeof value === 'string' ? flightText(value) : undefined;
  if (text === undefined) throw new SchemaError(PROVIDER, `DAI Post returned an invalid ${key}`);
  return clean(text, maxLength);
}

/**
 * The tracking view's `trackingresponse` entries, the page's absence heading,
 * and the numbers its search field is filled with. Every page also carries
 * Next's generic 404 template, which says nothing about the number.
 */
function scanRows(rows: unknown[]) {
  const entries = new Map<string, unknown>();
  const echoed = new Set<string>();
  let absent = false;
  const stack: unknown[] = [...rows];
  for (let visited = 0; stack.length; visited += 1) {
    if (visited > MAX_NODES) throw new SchemaError(PROVIDER, 'DAI Post returned an oversized page');
    const node = stack.pop();
    if (Array.isArray(node)) {
      const props = node[0] === '$' && node.length === 4 && isRecord(node[3]) ? node[3] : null;
      if (props && typeof props.children === 'string' && clean(props.children, 200) === ABSENT) absent = true;
      if (props && node[1] === 'input' && props.name === 'tracknbr' && typeof props.defaultValue === 'string') {
        const value = flightText(props.defaultValue);
        if (value !== undefined) echoed.add(returnedTrackingNumber(value));
      }
      for (const child of node) stack.push(child);
    } else if (isRecord(node)) {
      if (Array.isArray(node.trackingresponse)) {
        for (const entry of node.trackingresponse) entries.set(JSON.stringify(entry), entry);
      }
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return { entries: [...entries.values()], absent, echoed: [...echoed] };
}

// When two scans share a clock the page can list the earlier milestone first,
// as an out-for-delivery scan above the delivery at the same minute.
const TIE_RANK: Readonly<Record<Stage, number>> = {
  pending: 0, registered: 0, accepted: 1, in_transit: 2, customs: 2, out_for_delivery: 3, failed_attempt: 4,
  exception: 4, ready_for_pickup: 5, delivered: 6, returned: 6,
};

interface Scan { event: CarrierEvent & { description: string }; wall: string }

function projectScan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DAI Post returned an invalid scan');
  const description = field(row, 'description', 500);
  const wall = field(row, 'eventdate', 40);
  const code = field(row, 'code', 16);
  if (!description || !WALL_CLOCK.test(wall) || (code && !/^[A-Z0-9]{2,8}$/.test(code))) {
    throw new SchemaError(PROVIDER, 'DAI Post returned an incomplete scan');
  }
  const local = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!local.isValid) throw new SchemaError(PROVIDER, 'DAI Post returned an invalid scan clock');
  // An unplaced scan has the country "- ".
  const country = /^[A-Z]{2}$/.test(field(row, 'country', 8)) ? field(row, 'country', 8) : '';
  const city = field(row, 'city', 120);
  const location = [city && city.toUpperCase() !== country ? city : '', country].filter(Boolean).join(', ');
  // The tracker shows every clock as the scan's local time.
  const zone = daiPostScanZone(code, country, city);
  const instant = zone ? isoTime(wall, zone) : null;
  const mapped = daiPostStage(code || null);
  const worded = mapped ? null : classifyWording(description, 'in_transit');
  return {
    wall,
    event: {
      ...(instant ? { time: instant.iso } : { local_time: local.toFormat("yyyy-MM-dd'T'HH:mm:ss") }),
      description,
      ...(location ? { location } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(mapped ? { stage: mapped, stage_source: 'carrier_map' }
        : worded && worded.source !== 'none' ? { stage: worded.stage, stage_source: worded.source } : {}),
    },
  };
}

/**
 * Scans newest first, as the page lists them. Their clocks mix instants and
 * local times, so only scans sharing one wall clock are reordered: the further
 * milestone first, when the page gives every one of them a stage.
 */
function ordered(scans: Scan[]): CarrierEvent[] {
  const events: CarrierEvent[] = [];
  for (let start = 0; start < scans.length;) {
    let end = start + 1;
    while (end < scans.length && scans[end]!.wall === scans[start]!.wall) end += 1;
    const run = scans.slice(start, end);
    if (run.every(scan => scan.event.stage)) {
      run.sort((left, right) => TIE_RANK[right.event.stage as Stage] - TIE_RANK[left.event.stage as Stage]);
    }
    events.push(...run.map(scan => scan.event));
    start = end;
  }
  return events;
}

/** The expected delivery the page shows: one day, or "from to" a day, swapped when reversed. */
function estimate(raw: string): { from?: string; to: string } | null {
  const days = raw.split('to').map(day => day.trim());
  if (days.length > 2 || !days.every(day => ESTIMATE_DAY.test(day) && DateTime.fromISO(day, { zone: 'UTC' }).isValid)) return null;
  const [first, second] = days as [string, string?];
  if (!second || second === first) return { to: first };
  return first < second ? { from: first, to: second } : { from: second, to: first };
}

/**
 * The RSC reply of `daipost.com/track?tracknbr={number}`: the tracking view's
 * entry bound to the requested number, or the page's absence heading with its
 * search field filled with it.
 */
export function parseDaiPost(bytes: Uint8Array, contentType: string | null, raw: string): CarrierResult {
  const number = normalizeDaiPostNumber(raw);
  const type = (contentType ?? '').toLowerCase();
  if (!bytes.length) throw new IndeterminateError(PROVIDER, 'DAI Post returned an empty tracking reply');
  if (type.includes('text/html') || /^\s*</.test(ascii(bytes.subarray(0, 64)))) {
    throw new ChallengeError(PROVIDER, 'DAI Post answered with a web page instead of tracking data');
  }
  if (!type.includes('text/x-component')) throw new SchemaError(PROVIDER, 'DAI Post returned an unexpected tracking reply');
  const { rows, failures } = flightRows(bytes);
  const { entries, absent, echoed } = scanRows(rows);
  if (absent && (entries.length || echoed.length !== 1 || echoed[0] !== number)) {
    throw new SchemaError(PROVIDER, 'DAI Post answered for a different number');
  }
  if (!entries.length) {
    if (absent) throw new NotFoundError(PROVIDER);
    if (failures.some(digest => NEXT_CONTROL.test(digest))) throw new SchemaError(PROVIDER, 'DAI Post redirected or dropped its tracking page');
    if (failures.length) throw new IndeterminateError(PROVIDER, 'DAI Post could not render the tracking page');
    throw new SchemaError(PROVIDER, 'DAI Post returned no tracking data');
  }
  const entry = entries[0];
  if (entries.length > 1 || !isRecord(entry) || normalizeTrackingNumber(field(entry, 'tracknbr', 80)) !== number) {
    throw new SchemaError(PROVIDER, 'DAI Post returned a different or several parcels');
  }
  const rawEvents = entry.trackingevent === '$undefined' || entry.trackingevent === null || entry.trackingevent === undefined
    ? [] : entry.trackingevent;
  if (!Array.isArray(rawEvents) || rawEvents.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'DAI Post returned an invalid history');
  // The page says there are no scans yet or the history was archived, after 180 days.
  if (!rawEvents.length) throw new NoHistoryError(PROVIDER, 'DAI Post lists the parcel without scans');

  const seen = new Set<string>();
  const scans = rawEvents.map(projectScan).filter(scan => {
    const key = JSON.stringify(scan.event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const events = ordered(scans);
  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current : undefined;
  // A set `eddstatus` replaces the day with "Please contact customer service".
  const expected = field(entry, 'eddstatus', 200) ? null : estimate(field(entry, 'estimatedDeliveryDate', 60));
  const settled = stage === 'delivered' || stage === 'returned' || stage === 'ready_for_pickup';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: latest.description ?? null,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    expected_delivery: expected && !settled ? expected.to : null,
    ...(expected?.from && !settled ? { expected_delivery_from: expected.from } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
