import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { domainLogisticsStage } from './status.js';

export const PROVIDER = 'Domain Logistics';
// An order's reply is under a kilobyte.
export const DOMAIN_LOGISTICS_MAX_BYTES = 64 * 1024;
// The page sends whatever is typed. Lookups carry twelve digits and its form's example nine
// letters and digits, so the adapter takes letters and digits with a digit and leaves the
// layout to the service.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// A row's `Date`: the day, a line break and a twelve-hour clock, as "2026-01-02<br/>09:30 PM".
const CLOCK = /^(\d{4}-\d{2}-\d{2})\s*<br\s*\/?>\s*(\d{1,2}):(\d{2})\s*([AP]M)$/i;
// A row's `Estimated`: the day, then nothing, an arrival time or a window.
const ESTIMATE = /^(\d{4}-\d{2}-\d{2})(?:\s*<br\s*\/?>|$)/i;
const FINAL: readonly Stage[] = ['delivered', 'returned'];
const MAX_ROWS = 100;

/** A number for Domain's tracking service, in capitals; anything else is not one it issues. */
export function normalizeDomainLogisticsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Domain Logistics numbers are six to forty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function field(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Domain Logistics returned an invalid ${key}`);
  return value.trim().slice(0, 300);
}

/** A calendar day the reply writes, checked by reading it back. */
function day(value: string): string | null {
  // UTC only checks the calendar digits; the day keeps no zone.
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  return parsed.isValid && parsed.toISODate() === value ? value : null;
}

/**
 * A row's clock. The page prints it as it comes; it reads as Ontario's wall clock, but the
 * reply names no zone, so the clock stays local.
 */
function wallClock(raw: string): string {
  const match = CLOCK.exec(raw);
  const hour = match ? Number(match[2]) : 0;
  if (!match || hour < 1 || hour > 12 || !day(match[1]!)) throw new SchemaError(PROVIDER, 'Domain Logistics returned an invalid status time');
  const hours = (hour % 12) + (match[4]!.toUpperCase() === 'PM' ? 12 : 0);
  const local = `${match[1]}T${String(hours).padStart(2, '0')}:${match[3]}:00`;
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Domain Logistics returned an invalid status time');
  return local;
}

interface Row { event: CarrierEvent; local: string; service: string; estimate: string | null }

function projectRow(row: unknown): Row {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Domain Logistics returned an invalid status row');
  // The page writes each value in as HTML.
  const description = textFromHtml(field(row, 'Status'), 200);
  if (!description) throw new SchemaError(PROVIDER, 'Domain Logistics returned a row without its status');
  const local = wallClock(field(row, 'Date'));
  // `Note` is the page's advice beside a status, about the estimate or the delivery; it is not read.
  field(row, 'Note');
  const estimate = ESTIMATE.exec(field(row, 'Estimated'))?.[1];
  const staged = domainLogisticsStage(description);
  return {
    local,
    service: textFromHtml(field(row, 'Service'), 80),
    estimate: estimate ? day(estimate) : null,
    event: { local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) },
  };
}

/**
 * The reply of `GET api.domainlogistics.ca/domaintracking/api/tracking/{number}`: the order's
 * statuses, newest first, each with the delivery service, its own estimate and its clock. The
 * reply never repeats the number; the request path binds it to the whole number asked. An
 * empty reply is an order without a status yet, which the page asks to check again later.
 */
export function parseDomainLogistics(payload: unknown): CarrierResult {
  if (payload === null || (Array.isArray(payload) && payload.length === 0)) throw new NoHistoryError(PROVIDER);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Domain Logistics returned an invalid reply');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Domain Logistics returned an oversized history');

  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const raw of payload) {
    const row = projectRow(raw);
    const key = JSON.stringify([row.local, row.event.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  // Newest first, as the page lists them; a row keeps its place before an older one at the same minute.
  if (listsNewestFirst(rows.map(({ event }) => event)) === false) rows.reverse();
  rows.sort((a, b) => b.local.localeCompare(a.local));

  const newest = rows[0]!;
  const scanned = rows.find((row) => row.event.stage)?.event;
  const stage = scanned?.stage as Stage | undefined;
  // The newest status's estimate, until the order is delivered or once its day has passed.
  const estimate = stage && FINAL.includes(stage) ? null : newest.estimate;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.event.description!,
    last_update: null,
    last_update_local: newest.local,
    expected_delivery: estimate && estimate >= newest.local.slice(0, 10) ? estimate : null,
    ...(newest.service ? { service_name: newest.service } : {}),
    events: rows.map((row) => row.event),
  };
}
