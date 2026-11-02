import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { redpackStage } from './status.js';

export const PROVIDER = 'Redpack';
export const REDPACK_MAX_BYTES = 512_000;
// Redpack's clocks are central Mexico wall time: its tracker page labels the
// same scans -06:00 that this service labels +0000.
const ZONE = 'America/Mexico_City';

/** The service's result codes: a shipment found, and a guide it does not know. */
const FOUND = 1;
const UNKNOWN_GUIDE = 36;

/**
 * Redpack prints nine-digit guide numbers, padded with a leading zero, and its
 * service reads them as integers, so the eight-digit form finds the same guide.
 */
export function normalizeRedpackNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{8,9}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Redpack guide numbers are nine digits');
  return number;
}

const CLOCK = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})$/;

/** A scan clock: the `+0000` label is a central Mexico wall clock; any other offset is the clock's own. */
function scanTime(raw: unknown): { iso: string; timestamp: number } | null {
  const match = CLOCK.exec(clean(raw, 40));
  if (!match) return null;
  const [, wall, offset] = match as unknown as [string, string, string];
  return /^(?:Z|\+00:?00)$/.test(offset) ? isoTime(wall, ZONE) : explicitOffsetTime(`${wall}${offset}`);
}

/** A positive measure the reply gives as a number. */
function measure(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100_000 ? value : undefined;
}

/** Locations that name no place. */
const NO_PLACE = new Set(['', '-', 'INDETERMINADA']);

interface Scan { readonly event: CarrierEvent; readonly timestamp: number; readonly index: number }

/**
 * One scan without the shipment-control notes (`circuit`) it carries: they
 * are internal route and manifest references. The reason of a failed delivery
 * is already in the situation's wording.
 */
function projectScan(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Redpack returned an incomplete scan');
  const description = clean(row.situation, 200) || clean(row.eventDescription, 200);
  const at = scanTime(row.date);
  if (!description || !at) throw new SchemaError(PROVIDER, 'Redpack returned a scan without a situation or clock');
  const code = typeof row.idDesc === 'number' && Number.isSafeInteger(row.idDesc) && row.idDesc > 0 ? String(row.idDesc) : null;
  const location = clean(row.location, 120);
  const stage = redpackStage(code, description);
  return {
    timestamp: at.timestamp, index,
    event: {
      time: at.iso, description,
      ...(code ? { provider_code: code } : {}),
      ...(NO_PLACE.has(location.toUpperCase()) ? {} : { location }),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    },
  };
}

/**
 * The reply of `trackingByNumber` for one guide, without the recipient who
 * signed, the destination's neighbourhood and postcode, the origin postcode or
 * the shipper's references it also carries.
 */
export function parseRedpack(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeRedpackNumber(rawNumber);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new SchemaError(PROVIDER, 'Redpack did not answer for one guide');
  }
  const record = payload[0];
  const results = record.consumptionResultWS;
  if (!Array.isArray(results) || !results.length || results.length > 20 || !results.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Redpack returned a reply without its result');
  }
  const codes = results.map(result => result.status);
  // Any other result is the service failing, as it does for some older guides it holds.
  if (!codes.every(code => code === FOUND || code === UNKNOWN_GUIDE) || (codes.includes(FOUND) && codes.includes(UNKNOWN_GUIDE))) {
    throw new IndeterminateError(PROVIDER, 'Redpack could not complete the lookup');
  }
  if (clean(record.trackingNumber, 40) !== number) throw new SchemaError(PROVIDER, 'Redpack answered for another guide');
  // What the app shows as "no se encontró la guía", a guide Redpack does not know.
  if (codes.includes(UNKNOWN_GUIDE)) throw new NotFoundError(PROVIDER);

  const parcels = record.parcel ?? [];
  if (!Array.isArray(parcels) || parcels.length > 50 || !parcels.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Redpack returned invalid parcels');
  }
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const parcel of parcels) {
    const rows = parcel.situationDetail ?? [];
    if (!Array.isArray(rows) || rows.length > 300) throw new SchemaError(PROVIDER, 'Redpack returned an invalid history');
    for (const row of rows) {
      const scan = projectScan(row, scans.length);
      // A guide with several parcels repeats each scan once per parcel.
      const key = JSON.stringify(scan.event);
      if (seen.has(key)) continue;
      seen.add(key);
      scans.push(scan);
    }
  }
  const events = scans.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index).map(scan => scan.event);

  const last = isRecord(record.lastSituation) ? clean(record.lastSituation.situation, 200) : '';
  const lastCode = isRecord(record.lastSituation) && typeof record.lastSituation.idDesc === 'number' && record.lastSituation.idDesc > 0
    ? String(record.lastSituation.idDesc) : null;
  const stage: Stage | undefined = events.length
    ? events.find(event => event.stage)?.stage as Stage | undefined
    : last ? redpackStage(lastCode, last) : undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  // The latest day the service promises, an estimate to clear once delivered.
  const promised = /^(\d{4}-\d{2}-\d{2})[ T]/.exec(clean(record.maximumDeliveryDate, 40))?.[1];
  const service = isRecord(record.serviceType) ? clean(record.serviceType.service, 60) : '';
  const parcel = parcels.length === 1 ? parcels[0]! : undefined;
  const weight = measure(parcel?.weigth);
  const sides = [parcel?.length, parcel?.width, parcel?.high].map(measure);

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]?.description ?? (last || null),
    ...(events.length ? {} : { summary_only: true }),
    last_update: events[0]?.time ?? null,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    expected_delivery: promised && stage !== 'delivered' ? promised : null,
    ...(service ? { service_name: service } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(sides.every(Boolean) ? { dimensions_text: `${sides.join(' × ')} cm` } : {}),
    timezone: ZONE,
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
