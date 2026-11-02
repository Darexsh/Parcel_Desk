import { DateTime } from 'luxon';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { burdMappedStage, burdWording } from './status.js';

export const PROVIDER = 'Burd Delivery';
// A parcel's statuses are a few hundred bytes each.
export const BURD_MAX_BYTES = 256 * 1024;
// Denmark's zone, in which the tracking page shows each status to a visitor there.
const ZONE = 'Europe/Copenhagen';
// The reply's clocks are UTC instants, to the ten-millionth of a second.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const STATUS_TYPE = /^[A-Za-z]{1,40}$/;
const MAX_ROWS = 200;

/**
 * Burd's shipment number: eighteen digits by its tracking page's own script,
 * an SSCC with its check digit. A label prints it behind the GS1 identifier
 * `(00)`, which the tracker does not take, so that is dropped. Anything else
 * is not a number Burd issues.
 */
export function normalizeBurdNumber(raw: string): string {
  const typed = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const number = /^00\d{18}$/.test(typed) ? typed.slice(2) : typed;
  if (!/^\d{18}$/.test(number) || !hasGs1CheckDigit(number)) {
    throw new InvalidInputError(PROVIDER, 'Burd shipment numbers are eighteen-digit SSCCs');
  }
  return number;
}

/** A status's moment, an instant in UTC, at Denmark's offset to the second. */
function instant(value: unknown): { iso: string; timestamp: number } {
  const parsed = typeof value === 'string' && INSTANT.test(value) ? DateTime.fromISO(value, { setZone: true }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'Burd returned an invalid status time');
  const second = parsed.startOf('second');
  return { iso: second.setZone(ZONE).toISO({ suppressMilliseconds: true })!, timestamp: second.toMillis() };
}

/**
 * The reply of `TrackAndTraceStatuses?number=`, which Burd's tracking page
 * reads: the parcel's statuses, each naming the parcel's `barcode`. Every one
 * must name the number asked. The webshop's order number and Burd's name for
 * the webshop beside each status are not kept: the order number, with the
 * parcel's code, opens the parcel's page in Burd's emails.
 */
export function parseBurd(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBurdNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Burd returned an invalid envelope');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Burd returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; event: CarrierEvent }[] = [];
  for (const row of payload) {
    if (!isRecord(row) || typeof row.barcode !== 'string') throw new SchemaError(PROVIDER, 'Burd returned a status without its parcel');
    if (normalizeTrackingNumber(row.barcode) !== number) throw new IndeterminateError(PROVIDER, 'Burd answered for another parcel');
    const code = typeof row.statusType === 'string' ? cleanScalar(row.statusType, 40) : '';
    if (!STATUS_TYPE.test(code)) throw new SchemaError(PROVIDER, 'Burd returned an invalid status type');
    const clock = instant(row.created);
    const key = JSON.stringify([clock.timestamp, code.toLowerCase()]);
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = burdMappedStage(code);
    scans.push({ timestamp: clock.timestamp, event: {
      time: clock.iso,
      description: burdWording(code),
      provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } });
  }
  // The page reads an empty list as no parcel, but the service did not say so.
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page sorts them; statuses of one second keep the reply's order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((a, b) => b.timestamp - a.timestamp).map((scan) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    events,
  };
}
