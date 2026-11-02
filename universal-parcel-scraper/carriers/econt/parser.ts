import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { econtCourierStage, econtScan, econtSummaryStage, RECEIPT_CODE } from './status.js';

export const PROVIDER = 'Econt';
export const ECONT_MAX_BYTES = 256_000;
// The tracker prints its backend's clocks, which read in Sofia time.
const ZONE = 'Europe/Sofia';

/** Every Econt shipment number seen on its tracker is thirteen digits; the tracking service reads it as an integer. */
export function normalizeEcontNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[1-9]\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Econt shipment numbers are thirteen digits');
  return number;
}

const CLOCK = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/;

/** A Sofia wall clock as an instant, or kept as local time in the hour a clock change skips or repeats. */
function scanClock(raw: unknown): { wall: string; clock: Pick<CarrierEvent, 'time'> | { local_time: string } } | null {
  const text = clean(raw, 32);
  const match = CLOCK.exec(text);
  if (!match) return null;
  const wall = `${match[1]}T${match[2]}`;
  const parsed = zonedTime(text, 'yyyy-MM-dd HH:mm:ss', ZONE);
  if (!parsed) return null;
  const unique = DateTime.fromISO(wall, { zone: ZONE }).getPossibleOffsets().length === 1;
  return { wall, clock: parsed.iso.startsWith(wall) && unique ? { time: parsed.iso } : { local_time: wall } };
}

/** The whole shipment number the reply echoes, as a JSON integer or a string. */
function echoedNumber(value: unknown): string {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return typeof value === 'string' ? value.trim() : '';
}

interface Scan {
  readonly event: CarrierEvent;
  readonly code: string;
  readonly receipt: boolean;
  /** The office's Bulgarian name, to match the office storing the parcel. */
  readonly office: string;
  readonly wall: string;
  readonly index: number;
}

/**
 * One scan as the tracker shows it, without the names it carries for people:
 * the recipient on a delivery and the courier on a courier scan. An order
 * changing the delivery terms keeps its subject, not its number.
 */
function projectScan(row: Record<string, unknown>, code: string): Omit<Scan, 'wall' | 'index' | 'event'> & { event: Omit<CarrierEvent, 'time'> } {
  const name = clean(row.name, 200);
  const text = clean(row.nameLatin, 200) || name;
  const scan = econtScan(code);
  let description = scan.wording;
  let location = '';
  if (code === 'office') location = text;
  else if (code === 'courier_direction' && text) description = `${scan.wording}: ${text}`;
  else if (code === 'instruction') {
    const subject = /\bfor:\s*(.{1,120})$/i.exec(clean(row.nameLatin, 200)) ?? /\bза:\s*(.{1,120})$/i.exec(name);
    if (subject) description = `${scan.wording}: ${subject[1]!.trim()}`;
  } else if (code === 'failed_delivery') {
    const reason = /\(([^()]{1,80})\)\s*$/.exec(text);
    if (reason) description = `${scan.wording} (${reason[1]!.trim()})`;
    // "Върната от куриер в офис <office>, поради ...": the office the courier brought it back to.
    location = /\s(?:офис|office)\s+([^,]{1,120}),/i.exec(text)?.[1]?.trim() ?? '';
  }
  const receipt = row.isReceipt === true;
  return {
    code, receipt, office: code === 'office' ? name : '',
    event: {
      description: receipt ? `Return receipt: ${description}` : description,
      provider_code: receipt ? RECEIPT_CODE : code,
      ...(location ? { location } : {}),
    },
  };
}

/** Scans that put the parcel in Econt's network, after which a courier delivers it. */
const NETWORK = new Set(['office', 'courier_direction', 'redirect', 'failed_delivery']);

export function parseEcont(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeEcontNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  // The tracker shows its general "no information" message for this status; it is not the per-shipment not found.
  if (payload.status === 'error') throw new IndeterminateError(PROVIDER, 'Econt could not complete the lookup');
  if (payload.status !== 'ok' || !Array.isArray(payload.tracks)) throw new SchemaError(PROVIDER);
  const track: unknown = payload.tracks[0];
  if (payload.tracks.length !== 1 || !isRecord(track) || echoedNumber(track.waybillNumber) !== number) {
    throw new SchemaError(PROVIDER, 'Econt did not identify one matching shipment');
  }
  // What the tracker shows as "a shipment with this number could not be found".
  if (track.isFound === false) throw new NotFoundError(PROVIDER);
  if (track.isFound !== true) throw new SchemaError(PROVIDER, 'Econt returned a shipment without its found flag');
  const rows = track.trace ?? [];
  if (!Array.isArray(rows) || rows.length > 300) throw new SchemaError(PROVIDER, 'Econt returned an invalid shipment history');

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Econt returned an incomplete scan');
    // The tracker leaves out rows without a kind.
    if (row.event === null || row.event === undefined || row.event === '') return;
    const code = typeof row.event === 'string' && /^[a-z][a-z_]{0,40}$/.test(row.event) ? row.event : '';
    const at = scanClock(row.time);
    if (!code || !at) throw new SchemaError(PROVIDER, 'Econt returned a scan without a kind or clock');
    const projected = projectScan(row, code);
    const event: CarrierEvent = { ...at.clock, ...projected.event };
    const key = JSON.stringify(event);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push({ ...projected, event, wall: at.wall, index });
  });

  // Every clock is a Sofia wall clock, so they order as written; equal clocks keep the reply's order.
  const oldestFirst = [...scans].sort((left, right) => left.wall.localeCompare(right.wall) || left.index - right.index);
  let inNetwork = false;
  for (const scan of oldestFirst) {
    const stage = scan.receipt ? undefined
      : scan.code === 'courier' ? econtCourierStage(inNetwork) : econtScan(scan.code).stage;
    if (stage) Object.assign(scan.event, { stage, stage_source: 'carrier_map' });
    if (!scan.receipt && NETWORK.has(scan.code)) inNetwork = true;
  }
  const ordered = oldestFirst.reverse();
  const events = ordered.map(scan => scan.event);

  const summary = clean(track.shortDeliveryStatus, 120);
  const storage = clean(track.storage, 200);
  // The office storing the parcel, named as one of its own office scans.
  const store = storage ? ordered.find(scan => !scan.receipt && scan.code === 'office' && scan.office === storage) : undefined;
  const stage: Stage | undefined = (summary ? econtSummaryStage(summary, Boolean(store)) : undefined)
    ?? (events.find(event => event.stage)?.stage as Stage | undefined);
  const delivery = stage === 'delivered' ? ordered.find(scan => !scan.receipt && scan.code === 'client') : undefined;
  const pickupPoint = stage === 'ready_for_pickup' ? store?.event.location : undefined;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: clean(track.shortDeliveryStatusLatin, 120) || summary || events[0]?.description || null,
    ...(events.length ? {} : { summary_only: true }),
    last_update: events[0]?.time ?? null,
    ...(delivery?.event.time ? { delivered_at: delivery.event.time } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    timezone: ZONE,
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
