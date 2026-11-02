import { DateTime, IANAZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { speedxStatus } from './status.js';

const PROVIDER = 'SpeedX';
const MAX_SCANS = 500;
const MAX_NODES = 250_000;
/**
 * A Flight row holding JSON: a hex row id, a colon, then an array, object or
 * string. Flight leaves U+2028 and U+2029 raw inside strings, so only a line
 * feed ends a row.
 */
const JSON_ROW = /^[0-9a-f]{1,8}:([[{"][\s\S]*)$/;
/** A Flight error row: a component that threw while the server rendered it. */
const ERROR_ROW = /^[0-9a-f]{1,8}:E(\{[\s\S]*\})$/;
/** Next's notFound() and redirect() also travel as error rows, and mean the route changed. */
const NEXT_CONTROL = /^(?:NEXT_NOT_FOUND$|NEXT_HTTP_ERROR_FALLBACK;|NEXT_REDIRECT;)/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ABSENT = 'No tracking information for';

/** SPX, the three-letter hub, then 12 or 18 digits. The page answers any path, so nothing else is sent. */
export function normalizeSpeedxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^SPX[A-Z]{3}(?:\d{12}|\d{18})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'SpeedX requires SPX, three letters and 12 or 18 digits');
  }
  return number;
}

/** A string as Flight writes it. `$$` escapes a dollar; any other `$` value is `$undefined` or a reference. */
function flightText(value: string): string | undefined {
  if (value.startsWith('$$')) return value.slice(1);
  return value.startsWith('$') ? undefined : value;
}

/** An optional scalar field; `$undefined` and null are absent, references and objects are not text. */
function field(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined || value === '$undefined') return '';
  if (typeof value === 'number') return cleanScalar(value, maxLength);
  const text = typeof value === 'string' ? flightText(value) : undefined;
  if (text === undefined) throw new SchemaError(PROVIDER, `SpeedX returned an invalid ${key}`);
  return clean(text, maxLength);
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
 * The JSON rows of a React Server Components reply, and the digests of its
 * error rows. Hint, module and text rows are skipped.
 */
function flightRows(body: string): { rows: unknown[]; failures: string[] } {
  const rows: unknown[] = [];
  const failures: string[] = [];
  for (const line of body.split('\n')) {
    const failure = ERROR_ROW.exec(line)?.[1];
    if (failure !== undefined) {
      failures.push(errorDigest(failure));
      continue;
    }
    const json = JSON_ROW.exec(line)?.[1];
    if (json === undefined) continue;
    try {
      rows.push(JSON.parse(json));
    } catch {
      // A row that is not JSON holds neither a shipment nor its absence.
    }
  }
  return { rows, failures };
}

/** The text an element renders: its children's strings and nested elements, never its other props. */
function childText(node: unknown, depth = 0): string {
  if (depth > 32) return '';
  if (typeof node === 'string') return flightText(node) ?? '';
  if (!Array.isArray(node)) return '';
  if (node[0] === '$' && node.length === 4) return isRecord(node[3]) ? childText(node[3].children, depth + 1) : '';
  return node.map((child) => childText(child, depth + 1)).join(' ');
}

/**
 * The tracking view's `data` objects, and the numbers the page's absence
 * sentence names. Every page also carries Next's generic 404 template, which
 * says nothing about the number and is not read.
 */
function scanRows(rows: unknown[]): { shipments: Record<string, unknown>[]; absent: string[] } {
  const shipments = new Map<string, Record<string, unknown>>();
  const absent = new Set<string>();
  const stack: unknown[] = [...rows];
  for (let visited = 0; stack.length; visited += 1) {
    if (visited > MAX_NODES) throw new SchemaError(PROVIDER, 'SpeedX returned an oversized page');
    const node = stack.pop();
    if (Array.isArray(node)) {
      const props = node[0] === '$' && node.length === 4 && isRecord(node[3]) ? node[3] : null;
      const children = props?.children;
      if (Array.isArray(children) && typeof children[0] === 'string' && clean(children[0]) === ABSENT) {
        const named = /^No tracking information for (\S+) is available at this time\b/.exec(clean(childText(children), 2_000))?.[1];
        if (!named) throw new SchemaError(PROVIDER, 'SpeedX changed its unknown-number message');
        absent.add(named);
      }
      for (const child of node) stack.push(child);
    } else if (isRecord(node)) {
      if (isRecord(node.data) && 'trackingNumber' in node.data && 'events' in node.data) {
        shipments.set(JSON.stringify(node.data), node.data);
      }
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return { shipments: [...shipments.values()], absent: [...absent] };
}

interface Scan { event: CarrierEvent & { time: string; description: string }; timestamp: number; status?: ClassifiedStatus }

/** The scan's UTC instant, written in the zone the page shows it in when that zone is a real one. */
function scanTime(row: Record<string, unknown>): ParsedTime {
  const ts = field(row, 'ts', 64);
  const instant = UTC_INSTANT.test(ts) ? explicitOffsetTime(ts) : null;
  if (!instant) throw new SchemaError(PROVIDER, 'SpeedX returned a scan without a UTC time');
  const zone = field(row, 'timeZone', 64);
  if (!IANAZone.isValidZone(zone)) return instant;
  return { iso: DateTime.fromMillis(instant.timestamp, { zone }).toISO({ suppressMilliseconds: true })!, timestamp: instant.timestamp };
}

function projectScan(row: unknown): { id: string; scan: Scan } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SpeedX returned an invalid scan');
  const time = scanTime(row);
  const code = field(row, 'eventCode', 16);
  const status = speedxStatus(code, field(row, 'category', 64));
  // The page prints the wording, then the scan's note. A delivery's note says
  // where the parcel was left, so a delivery keeps its wording alone.
  const delivered = status?.stage === 'delivered';
  const wording = field(row, 'eventDescription');
  const note = delivered ? '' : field(row, 'eventSupplementalInfo');
  const description = wording ? [wording, note].filter(Boolean).join('. ') : delivered ? 'Delivered' : field(row, 'description');
  if (!description) throw new SchemaError(PROVIDER, 'SpeedX returned a scan without wording');
  // The town of the scan. Coordinates, postcodes and references are never read:
  // a delivery's coordinates are the recipient's door.
  const location = field(row, 'location', 200) || [field(row, 'city', 100), field(row, 'state', 20)].filter(Boolean).join(', ');
  const event = { time: time.iso, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
    ...(status ? { stage: status.stage, stage_source: 'carrier_map' } : {}) };
  return { id: field(row, 'eventId', 128), scan: { event, timestamp: time.timestamp, ...(status ? { status } : {}) } };
}

/**
 * The RSC reply of `tracking.speedx.io/{number}`: the shipment view's `data`
 * object, bound to the requested number, or the page's absence sentence
 * naming it. Recipient address, merchant, references and proof of delivery in
 * the same object are never read.
 */
export function parseSpeedx(body: string, contentType: string | null, raw: string): CarrierResult {
  const number = normalizeSpeedxNumber(raw);
  if (!body.trim()) throw new IndeterminateError(PROVIDER, 'SpeedX returned an empty tracking reply');
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('text/html') || /^\s*</.test(body)) {
    throw new ChallengeError(PROVIDER, 'SpeedX answered with a web page instead of tracking data');
  }
  if (!type.includes('text/x-component')) throw new SchemaError(PROVIDER, 'SpeedX returned an unexpected tracking reply');
  const { rows, failures } = flightRows(body);
  const { shipments, absent } = scanRows(rows);
  if (absent.length && (shipments.length || absent.some((named) => named !== number))) {
    throw new SchemaError(PROVIDER, 'SpeedX answered for a different number');
  }
  if (!shipments.length) {
    if (absent.length) throw new NotFoundError(PROVIDER);
    // A component that threw on the server leaves an error row where the view
    // would be. A failed side component never hides a view that did render.
    if (failures.some((digest) => NEXT_CONTROL.test(digest))) throw new SchemaError(PROVIDER, 'SpeedX redirected or dropped its tracking page');
    if (failures.length) throw new IndeterminateError(PROVIDER, 'SpeedX could not render the tracking page');
    throw new SchemaError(PROVIDER, 'SpeedX returned no tracking data');
  }
  if (shipments.length > 1) throw new SchemaError(PROVIDER, 'SpeedX returned several shipments');
  const data = shipments[0]!;
  if (data.trackingNumber !== number) throw new SchemaError(PROVIDER, 'SpeedX returned a different shipment');
  if (!Array.isArray(data.events) || data.events.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'SpeedX returned an invalid history');
  if (!data.events.length) throw new IndeterminateError(PROVIDER, 'SpeedX returned no scans for the shipment');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of data.events as unknown[]) {
    const { id, scan } = projectScan(row);
    const key = id || JSON.stringify(scan.event);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  // The page lists scans newest first. Instants order them; equal ones keep the page's order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.timestamp - left.timestamp);
  const newest = scans[0]!;
  const current = newest.status;
  // The country of the recipient's postcode, which the page's proof-of-delivery check uses.
  const country = field(data, 'country', 8);
  return {
    status: current?.status ?? 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.event.description,
    last_update: newest.event.time,
    expected_delivery: null,
    ...(current?.stage === 'delivered' ? { delivered_at: newest.event.time } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events: scans.slice(0, 100).map((scan) => scan.event),
  };
}
