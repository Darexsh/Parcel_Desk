import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { totalExpressStage } from './status.js';

export const PROVIDER = 'Total Express';
// A long history is under twenty kilobytes.
export const TOTAL_EXPRESS_MAX_BYTES = 512 * 1024;
// Four letters, nine digits and TX, as the tracker writes its AWBs.
const NUMBER = /^[A-Z]{4}\d{9}TX$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An AWB for Total Express's tracker, in upper case; anything else is not one it issues. */
export function normalizeTotalExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Total Express AWBs are four letters, nine digits and TX');
  return number;
}

/** Whether a reply's AWB is the one asked: the tracker writes the TX in lower case. */
function sameNumber(value: unknown, number: string): boolean {
  return typeof value === 'string' && clean(value, 64).toUpperCase() === number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Total Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's wording without the empty separators the tracker leaves around a
 * base's code: `RECEBIDO CD DE: - - SGE` reads `RECEBIDO CD DE: SGE`, and
 * `TRANSFERENCIA PARA:` with no base reads `TRANSFERENCIA PARA`.
 */
export function totalExpressWording(value: string): string {
  return clean(value).replace(/\s*:(?:\s*[-:])+\s*/g, ': ').replace(/[\s:-]+$/, '');
}

/**
 * A scan's clock. `data` and `hora` are a wall clock to the second with no
 * zone, so the clock stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const date = text(row, 'data', 16);
  const time = text(row, 'hora', 16);
  const local = `${date}T${time}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!DATE.test(date) || !CLOCK.test(time) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Total Express returned an invalid scan time');
  }
  return local;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const code = cleanScalar(row.statid, 8);
  if (!/^\d{1,4}$/.test(code)) throw new SchemaError(PROVIDER, 'Total Express returned a scan without its status');
  const description = totalExpressWording(text(row, 'statusDescricao'));
  if (!description) throw new SchemaError(PROVIDER, 'Total Express returned a scan without wording');
  const local = scanClock(row);
  const staged = totalExpressStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description]), event };
}

/**
 * The scans of every layout, newest first. Each milestone lists its scans
 * newest first; the scans of a later milestone come first, so a sort by clock
 * that keeps ties in place puts a later milestone's scan before an earlier
 * one's at the same second.
 */
function scans(layouts: unknown): CarrierEvent[] {
  if (!Array.isArray(layouts)) throw new SchemaError(PROVIDER, 'Total Express returned a shipment without its milestones');
  const milestones: { order: number; rows: unknown[] }[] = [];
  for (const layout of layouts) {
    if (!isRecord(layout) || !Array.isArray(layout.etapas)) throw new SchemaError(PROVIDER, 'Total Express returned invalid milestones');
    for (const milestone of layout.etapas) {
      if (!isRecord(milestone) || !Array.isArray(milestone.listaStatus)) throw new SchemaError(PROVIDER, 'Total Express returned an invalid milestone');
      milestones.push({ order: typeof milestone.ordemNum === 'number' ? milestone.ordemNum : milestones.length, rows: milestone.listaStatus });
    }
  }
  if (milestones.reduce((count, milestone) => count + milestone.rows.length, 0) > MAX_ROWS) {
    throw new SchemaError(PROVIDER, 'Total Express returned an oversized history');
  }
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const milestone of milestones.sort((a, b) => b.order - a.order)) {
    const own = milestone.rows.map((row) => {
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Total Express returned an invalid scan');
      return projectRow(row);
    });
    // A milestone listed oldest first is turned round, with the scans it logged at one second.
    if (own.length > 1 && (own[0]!.event.local_time as string) < (own.at(-1)!.event.local_time as string)) own.reverse();
    for (const scan of own) {
      if (seen.has(scan.key)) continue;
      seen.add(scan.key);
      events.push(scan.event);
    }
  }
  return events.sort((a, b) => (b.local_time as string).localeCompare(a.local_time as string));
}

/** The delivery estimate, a calendar day. */
function estimate(shipment: Record<string, unknown>): string | null {
  const value = text(shipment, 'previsaoEntrega', 32);
  return DATE.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid ? value : null;
}

/** The pickup point the page names: its name, then its address on the following lines. */
function pickupPoint(shipment: Record<string, unknown>): string {
  const pudo = shipment.pudo;
  if (pudo === null || pudo === undefined) return '';
  if (!isRecord(pudo)) throw new SchemaError(PROVIDER, 'Total Express returned an invalid pickup point');
  const point = pudo.pickUp;
  if (point === null || point === undefined) return '';
  if (!isRecord(point)) throw new SchemaError(PROVIDER, 'Total Express returned an invalid pickup point');
  const street = [text(point, 'endereco', 120), cleanScalar(point.enderecoNumero, 16)].filter(Boolean).join(', ');
  return [text(point, 'nome', 120), street, text(point, 'complemento', 120), text(point, 'bairro', 120), text(point, 'cidade', 120)]
    .filter(Boolean).join('\n');
}

/**
 * The reply of the tracking page's `/order-data` for one AWB. The tracker
 * answers an AWB it does not know with HTTP 500, which the adapter settles
 * with the search; a shipment must name the AWB asked.
 */
export function parseTotalExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTotalExpressNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.data)) throw new SchemaError(PROVIDER, 'Total Express returned an invalid envelope');
  const shipment = payload.data.encomenda;
  if (!isRecord(shipment) || typeof shipment.awb !== 'string') throw new SchemaError(PROVIDER, 'Total Express returned a shipment without its AWB');
  if (!sameNumber(shipment.awb, number)) throw new IndeterminateError(PROVIDER, 'Total Express answered for another shipment');

  const newestFirst = scans(payload.data.layouts);
  if (!newestFirst.length) throw new NoHistoryError(PROVIDER);

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const sender = text(isRecord(shipment.cliente) ? shipment.cliente : {}, 'fantasia', 120);
  const pickup = pickupPoint(shipment);
  // Correios' number, when Total Express handed the parcel to it for the delivery.
  const handoff = text(shipment, 'redespachoNumero', 32).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(shipment),
    ...(sender ? { sender_name: sender } : {}),
    ...(pickup ? { pickup_point: pickup } : {}),
    ...(isValidS10TrackingNumber(handoff) ? { delivery_carrier: 'correios-br', delivery_tracking_number: handoff } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The reply of the tracking page's `/basic` search for one AWB: whether the
 * tracker knows it. An empty page of results is the page's not found. The
 * search also matches order and invoice numbers, so only a row with the AWB
 * asked counts.
 */
export function parseTotalExpressSearch(payload: unknown, raw: string): void {
  const number = normalizeTotalExpressNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Total Express returned an invalid search reply');
  if (!payload.data.length) throw new NotFoundError(PROVIDER);
  if (!payload.data.every(isRecord)) throw new SchemaError(PROVIDER, 'Total Express returned an invalid search result');
  if (!payload.data.some((row) => sameNumber(row.awb, number))) throw new IndeterminateError(PROVIDER, 'Total Express answered for another shipment');
}
