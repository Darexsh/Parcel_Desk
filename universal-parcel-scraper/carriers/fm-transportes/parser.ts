import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { fmTransportesStage } from './status.js';

export const PROVIDER = 'FM Transportes';
export const FM_TRANSPORTES_MAX_BYTES = 512 * 1024;
const MAX_EVENTS = 500;
const INSTANT = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;
const FORECAST = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/** Reuse the catalogue's dated own-label rule, including its Zeleris exclusion. */
export function normalizeFmTransportesNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!number || !detectCarrierMatch(number).candidates.includes('fm-transportes')) {
    throw new InvalidInputError(PROVIDER, 'FM Transportes needs a number in its own dated-label format');
  }
  return number;
}

/** The API supplies explicit UTC instants; retain its original millisecond precision. */
function instant(value: unknown): { time: string; timestamp: number } {
  if (typeof value !== 'string' || !INSTANT.test(value)) throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid scan timestamp');
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== value.slice(0, 19)) {
    throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid scan calendar');
  }
  return { time: value, timestamp: parsed.toMillis() };
}

/** The page displays only the calendar day of its offsetless forecast. */
function forecast(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !FORECAST.test(value)) throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid delivery forecast');
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== value) throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid forecast calendar');
  return value.slice(0, 10);
}

function optionalLocation(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid scan location');
  return clean(value, 160);
}

/** The guest lookup's success envelope, for one whole trackingCode and one volume. */
export function parseFmTransportes(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeFmTransportesNumber(rawNumber);
  // An empty HTTP 204 reply, and the API's null/empty success data, prove no identity.
  if (payload === undefined || payload === null) throw new NoHistoryError(PROVIDER);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid tracking envelope');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'FM Transportes did not complete the tracking lookup');
  if (payload.data == null || (isRecord(payload.data) && !Object.keys(payload.data).length)) throw new NoHistoryError(PROVIDER);
  if (!isRecord(payload.data)) throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid shipment');
  const shipment = payload.data;
  if (typeof shipment.trackingCode !== 'string') throw new SchemaError(PROVIDER, 'FM Transportes returned no tracking code');
  // Normalize the whole value before comparison, without display-text truncation.
  if (normalizeTrackingNumber(shipment.trackingCode) !== number) throw new IndeterminateError(PROVIDER, 'FM Transportes answered for a different shipment');
  if (!Array.isArray(shipment.volumes)) throw new SchemaError(PROVIDER, 'FM Transportes returned invalid volumes');
  if (!shipment.volumes.length) throw new NoHistoryError(PROVIDER);
  if (shipment.volumes.length !== 1) throw new IndeterminateError(PROVIDER, 'FM Transportes returned multiple volumes whose completion cannot be combined');
  const volume: unknown = shipment.volumes[0];
  if (!isRecord(volume) || !Array.isArray(volume.events)) throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid volume history');
  if (!volume.events.length) throw new NoHistoryError(PROVIDER);
  if (volume.events.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'FM Transportes returned too many scans');

  const scans: { event: CarrierEvent; timestamp: number; index: number }[] = [];
  const seen = new Set<string>();
  volume.events.forEach((row: unknown, index: number) => {
    if (!isRecord(row) || typeof row.description !== 'string' || row.description.length > 10_000) throw new SchemaError(PROVIDER, 'FM Transportes returned an invalid scan');
    const description = clean(row.description, 500);
    if (!description) throw new SchemaError(PROVIDER, 'FM Transportes returned a scan without wording');
    const at = instant(row.date);
    const location = optionalLocation(row.location);
    const key = JSON.stringify([at.timestamp, description, location]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = fmTransportesStage(description);
    scans.push({ timestamp: at.timestamp, index, event: {
      time: at.time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // The API lists oldest first; ties keep the response's order.
  scans.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = scans.map(scan => scan.event);
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: events[0]!.description!, last_update: events[0]!.time!,
    expected_delivery: forecast(shipment.deliveryForecast), events,
  };
}
