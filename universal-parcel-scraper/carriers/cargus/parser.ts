import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cargusScanStage, cargusSummaryStage, type CargusStage } from './status.js';

export const CARGUS = 'Cargus';
const MAX_SCANS = 500;
/** A wall clock without an offset, with up to seven fractional digits. */
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,7}))?$/;

/**
 * Cargus's AWB numbers are digits. The service answers letters with the same
 * empty reply as an unknown number, so they are looked up rather than refused.
 */
export function normalizeCargusNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[0-9A-Z]{8,20}$/.test(number)) throw new InvalidInputError(CARGUS, 'Cargus requires an AWB number');
  return number;
}

function invalid(message = 'Cargus returned an invalid tracking response'): never {
  throw new SchemaError(CARGUS, message);
}

function text(value: unknown, max: number): string {
  if (value == null) return '';
  if (typeof value !== 'string') invalid();
  return clean(value, max);
}

interface Scan {
  event: CarrierEvent;
  stage?: CargusStage;
  /** The full clock with its fraction, which orders scans of the same second. */
  order: string;
  index: number;
}

function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) invalid();
  const match = typeof row.date === 'string' ? CLOCK.exec(row.date) : null;
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) invalid('Cargus returned an invalid scan clock');
  const description = text(row.event, 300);
  if (!description) invalid('Cargus returned an empty scan');
  const locality = text(row.localityName, 120);
  const county = text(row.countyName, 120);
  // The town, then its county unless they are the same name.
  const location = [locality, county.toLowerCase() === locality.toLowerCase() ? '' : county].filter(Boolean).join(', ');
  const stage = cargusScanStage(description);
  const local = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
  return {
    event: { description, local_time: local, ...(location ? { location } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) },
    ...(stage ? { stage } : {}), order: `${local}.${(match[5] ?? '').padEnd(7, '0')}`, index,
  };
}

/**
 * One parcel from the app service's ShortTrace reply. The reply also names
 * who signed for the parcel with a delivery PIN, a sender's reference, piece
 * counts and colours; none of them is read.
 */
export function parseCargus(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCargusNumber(raw);
  if (!isRecord(payload)) invalid();
  if (typeof payload.awbBarcode !== 'string' || normalizeTrackingNumber(payload.awbBarcode) !== number) {
    invalid('Cargus returned a different AWB');
  }
  const rows = payload.events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) invalid();
  const summary = text(payload.statusMessage, 120);
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = scanOf(row, index);
    // The service repeats a scan within the same second; only exact copies go.
    const key = JSON.stringify(scan.event);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  // The service lists scans oldest first; scans of the same clock keep that order, reversed.
  scans.sort((left, right) => (left.order === right.order ? right.index - left.index : left.order < right.order ? 1 : -1));
  const newest = scans[0];
  if (!newest) {
    if (!summary) invalid('Cargus returned an AWB without a status');
    const stage = cargusSummaryStage(summary);
    return { status: stage ? languageStageStatus(stage.stage) : 'unknown',
      ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
      last_status_text: summary, last_update: null, summary_only: true, expected_delivery: null, events: [] };
  }
  const { stage } = newest;
  return { status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: newest.event.description!, last_update: null, last_update_local: newest.event.local_time,
    expected_delivery: null, events: scans.slice(0, 100).map(({ event }) => event) };
}
