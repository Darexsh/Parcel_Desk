import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pullmanCargoStage } from './status.js';

export const PROVIDER = 'Pullman Cargo';
// A long history is under three kilobytes.
export const PULLMAN_CARGO_MAX_BYTES = 256 * 1024;
// The tracking page asks for the eleven digits of the transport order (ODT).
const NUMBER = /^\d{11}$/;
// An instant to the second or finer, with the zone suffix Java's ZonedDateTime prints.
const INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?Z\[UTC\]$/;
const MAX_VALUES = 5_000;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** An ODT as the tracker matches it, leading zeroes included; anything else is not one Pullman Cargo issues. */
export function normalizePullmanCargoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Pullman Cargo ODT numbers are eleven digits');
  return number;
}

/**
 * The page's data in a SvelteKit `__data.json` reply: the layout's node, then
 * the page's, whose `data` is devalue's flat list where objects and arrays
 * name their members by index.
 */
function pageValues(payload: unknown): readonly unknown[] {
  if (isRecord(payload) && payload.type === 'redirect') throw new TransportError(PROVIDER, 'Pullman Cargo redirected its tracking lookup');
  if (!isRecord(payload) || payload.type !== 'data' || !Array.isArray(payload.nodes) || payload.nodes.length !== 2) {
    throw new SchemaError(PROVIDER, 'Pullman Cargo returned an invalid page reply');
  }
  const node: unknown = payload.nodes[1];
  // The page's server load failed.
  if (isRecord(node) && node.type === 'error') throw new IndeterminateError(PROVIDER, 'Pullman Cargo did not complete the lookup');
  if (!isRecord(node) || node.type !== 'data' || !Array.isArray(node.data) || !node.data.length || node.data.length > MAX_VALUES) {
    throw new SchemaError(PROVIDER, 'Pullman Cargo returned an invalid page reply');
  }
  return node.data;
}

/** The value an index names; devalue writes -1 for undefined. */
function at(values: readonly unknown[], index: unknown): unknown {
  if (index === -1) return undefined;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= values.length) {
    throw new SchemaError(PROVIDER, 'Pullman Cargo returned an invalid data reference');
  }
  return values[index];
}

/** An optional text field of a row; anything but a string is a changed reply. */
function text(values: readonly unknown[], row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = at(values, row[key]);
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Pullman Cargo returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's `fecha`, an instant in UTC: the former tracker's wall clocks for the
 * same scans sit three hours behind in summer and four in winter, Chile's
 * offsets. The page shows it in the browser's zone.
 */
function scanTime(raw: string): { time: string; at: number } {
  const match = INSTANT.exec(raw);
  const second = match ? DateTime.fromISO(match[1]!, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !second?.isValid || second.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== match[1]) {
    throw new SchemaError(PROVIDER, 'Pullman Cargo returned an invalid scan time');
  }
  const fraction = match[2] ? Number(`0${match[2]}`) * 1000 : 0;
  return { time: `${match[1]}Z`, at: second.toMillis() + fraction };
}

interface Scan { at: number; key: string; event: CarrierEvent }

function projectRow(values: readonly unknown[], ref: unknown, number: string): Scan {
  const row = at(values, ref);
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Pullman Cargo returned an invalid scan');
  const shipment = at(values, row.numeroODT);
  if (typeof shipment !== 'string') throw new SchemaError(PROVIDER, 'Pullman Cargo returned a scan without its ODT');
  if (clean(shipment, 64) !== number) throw new IndeterminateError(PROVIDER, 'Pullman Cargo answered for another shipment');
  const description = text(values, row, 'estadoWeb');
  if (!description) throw new SchemaError(PROVIDER, 'Pullman Cargo returned a scan without wording');
  const { time, at: instant } = scanTime(text(values, row, 'fecha', 64));
  const location = text(values, row, 'agencia', 120);
  const staged = pullmanCargoStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { at: instant, key: JSON.stringify([instant, description, location]), event };
}

/**
 * The tracking page's data for one ODT. `seguimiento` lists its scans newest
 * first, each repeating the shipment's own fields; an empty list is the
 * page's "ODT no encontrada". The page echoes the ODT asked as `odt`, and
 * every scan must name it.
 */
export function parsePullmanCargo(payload: unknown, raw: string): CarrierResult {
  const number = normalizePullmanCargoNumber(raw);
  const values = pageValues(payload);
  const root = values[0];
  if (!isRecord(root)) throw new SchemaError(PROVIDER, 'Pullman Cargo returned an invalid page reply');
  const asked = at(values, root.odt);
  if (typeof asked !== 'string') throw new SchemaError(PROVIDER, 'Pullman Cargo returned a reply without the ODT asked');
  if (asked.trim() !== number) throw new IndeterminateError(PROVIDER, 'Pullman Cargo answered for another ODT');
  const rows = at(values, root.seguimiento);
  if (rows === null || rows === undefined) throw new IndeterminateError(PROVIDER, 'Pullman Cargo did not complete the lookup');
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Pullman Cargo returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pullman Cargo returned an oversized history');
  if (!rows.length) throw new NotFoundError(PROVIDER);

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((ref) => {
    const scan = projectRow(values, ref, number);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  // Newest first; scans on one clock keep the reply's order, turned round when it lists the oldest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((a, b) => b.at - a.at).map((scan) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
