import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fargoUzStage } from './status.js';

export const PROVIDER = 'Fargo';
// A long history is a few kilobytes.
export const FARGO_UZ_MAX_BYTES = 512 * 1024;

const ZONE = 'Asia/Tashkent';
const MAX_SCANS = 500;
// The track ID the tracker's field shows as its example: TEZ and a serial,
// six digits there; longer serials are taken too.
const NUMBER = /^TEZ\d{6,10}$/;
// An instant with its offset: "2026-10-02T10:18:21.000Z".
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
// The page's own words for a code the reply gives no wording.
const LABELS: ReadonlyMap<string, string> = new Map([['created', 'Order created']]);

/**
 * A Fargo track ID, as the tracker's field asks for it. The tracker also finds
 * an order by the shop's own order number, but its reply names neither, so only
 * the track ID's own layout is sent.
 */
export function normalizeFargoUzNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Fargo track IDs are TEZ and six or more digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Fargo returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The facility the page shows for a scan: the warehouse's name and its town. */
function locationOf(row: Record<string, unknown>): string {
  const warehouse = row.warehouse;
  if (warehouse !== null && warehouse !== undefined && !isRecord(warehouse)) throw new SchemaError(PROVIDER, 'Fargo returned an invalid warehouse');
  const name = warehouse ? text(warehouse, 'name', 160) : '';
  const town = text(row, 'current_city_name', 80);
  return [...new Set([name, town].filter(Boolean))].join(' · ');
}

interface Scan { event: CarrierEvent; order: number; index: number }

/**
 * One history item. Its `date` is an instant, which the page shows on
 * Tashkent's clock. The courier, and any field the page does not show, is not read.
 */
function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Fargo returned an invalid scan');
  const code = typeof row.status === 'string' ? row.status.trim() : '';
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'Fargo returned a scan without a status');
  const raw = text(row, 'date', 40);
  const instant = INSTANT.test(raw) ? DateTime.fromISO(raw, { setZone: true }) : null;
  if (!instant?.isValid || instant.year < 2000) throw new SchemaError(PROVIDER, 'Fargo returned an invalid scan time');
  const description = text(row, 'status_desc', 200) || LABELS.get(code) || code.replace(/_/g, ' ');
  const location = locationOf(row);
  const staged = fargoUzStage(code, description);
  const event: CarrierEvent = {
    time: instant.setZone(ZONE).toISO({ suppressMilliseconds: true })!,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, order: instant.toMillis(), index };
}

/**
 * The reply of the tracker's `history_items` lookup for one track ID: the
 * order's history items, newest first. An unknown ID is a 404 the adapter
 * reads before this. The reply names no order, so the lookup itself binds it
 * to the ID asked; the tracker matches the whole ID exactly.
 */
export function parseFargoUz(payload: unknown, raw: string): CarrierResult {
  normalizeFargoUzNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Fargo returned an invalid reply');
  if (payload.status === 'error' && payload.code === 'order_not_found') throw new NotFoundError(PROVIDER);
  if (payload.status !== 'success' || !isRecord(payload.data)) throw new SchemaError(PROVIDER, 'Fargo returned an invalid reply');
  const { list, total } = payload.data;
  if (!Array.isArray(list)) throw new SchemaError(PROVIDER, 'Fargo returned an order with invalid history');
  if (list.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Fargo returned an oversized history');
  if (!list.length) throw new NoHistoryError(PROVIDER);

  const seen = new Set<string>();
  const scans: Scan[] = [];
  list.forEach((row, index) => {
    const scan = scanOf(row, index);
    // An item the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  // Newest first; items at the same instant keep the reply's order, which puts
  // the outcome of a delivery attempt above the attempt.
  const events = scans.sort((left, right) => right.order - left.order || left.index - right.index).map(({ event }) => event);
  // The page passes over a bare update for the current status.
  const latest = events.find((event) => event.provider_code !== 'update') ?? events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: events[0]!.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    ...(typeof total === 'number' && total > list.length ? { history_truncated: true } : {}),
    events,
  };
}
