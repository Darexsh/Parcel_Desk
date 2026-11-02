import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { eciMappedStage, eciWording } from './status.js';

export const PROVIDER = 'E-Commerce International';
export const CARRIER = 'e-commerce-international';
// A long history is under two kilobytes.
export const ECI_MAX_BYTES = 256 * 1024;
// PL, eleven digits and UA: the parcel number the forwarder prints.
const NUMBER = /^PL\d{11}UA$/;
const CODE = /^\d{9}$/;
// The courier's number beside the service the page links to.
const PARTNER_NUMBER = /^[A-Z0-9]{6,40}$/;
// The couriers the page links to, by the service key it names them with.
const COURIERS: Readonly<Record<string, string>> = {
  nova: 'nova-poshta', ukrp: 'ukrposhta', evri: 'evri-uk', amzn: 'amazon-logistics', dhlexpress: 'dhl-express',
};
// Instants the tracker could have written: from its first year to well ahead.
const EARLIEST = Date.UTC(2015, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);
const MAX_VALUES = 5_000;
const MAX_EVENTS = 300;

/** A parcel number as the tracker matches it; anything else is not one the forwarder prints. */
export function normalizeEciNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'E-Commerce International numbers are PL, eleven digits and UA');
  return number;
}

/**
 * The page's data in a SvelteKit `__data.json` reply: the root layout's node,
 * the language layout's, then the page's, whose `data` is devalue's flat list
 * where objects and arrays name their members by index.
 */
function pageValues(payload: unknown): readonly unknown[] {
  if (isRecord(payload) && payload.type === 'redirect') throw new TransportError(PROVIDER, 'E-Commerce International redirected its tracking lookup');
  if (!isRecord(payload) || payload.type !== 'data' || !Array.isArray(payload.nodes) || payload.nodes.length !== 3) {
    throw new SchemaError(PROVIDER, 'E-Commerce International returned an invalid page reply');
  }
  const node: unknown = payload.nodes[2];
  if (isRecord(node) && node.type === 'error') {
    // The page's load names a number it does not know; any other failure leaves the answer open.
    if (node.status === 404 && isRecord(node.error) && node.error.message === 'Parcel not found') throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'E-Commerce International did not complete the lookup');
  }
  if (!isRecord(node) || node.type !== 'data' || !Array.isArray(node.data) || !node.data.length || node.data.length > MAX_VALUES) {
    throw new SchemaError(PROVIDER, 'E-Commerce International returned an invalid page reply');
  }
  return node.data;
}

/** The value an index names; devalue writes -1 for undefined. */
function at(values: readonly unknown[], index: unknown): unknown {
  if (index === -1) return undefined;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= values.length) {
    throw new SchemaError(PROVIDER, 'E-Commerce International returned an invalid data reference');
  }
  return values[index];
}

/** An optional text field; anything but a string is a changed reply. */
function optionalText(values: readonly unknown[], root: Record<string, unknown>, key: string): string {
  const value = at(values, root[key]);
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `E-Commerce International returned an invalid ${key}`);
  return value.trim();
}

interface Scan { at: number; index: number; event: CarrierEvent }

function scan(values: readonly unknown[], ref: unknown, index: number): Scan {
  const row = at(values, ref);
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'E-Commerce International returned an invalid status');
  const code = at(values, row.number);
  const instant = at(values, row.timestamp);
  if (typeof code !== 'string' || !CODE.test(code)) throw new SchemaError(PROVIDER, 'E-Commerce International returned an invalid status code');
  if (typeof instant !== 'number' || !Number.isInteger(instant) || instant < EARLIEST || instant >= LATEST) {
    throw new SchemaError(PROVIDER, 'E-Commerce International returned an invalid status time');
  }
  const stage = eciMappedStage(code, '');
  const event: CarrierEvent = {
    time: DateTime.fromMillis(instant, { zone: 'utc' }).toISO({ suppressMilliseconds: true })!,
    // The page shows a code it has no text for as nothing; the code stands in.
    description: eciWording(code) ?? `Status ${code}`,
    provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}),
  };
  return { at: instant, index, event };
}

/** The courier the page links to for its service, with the courier's number when it differs from the one asked. */
function onwardCourier(values: readonly unknown[], root: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const service = optionalText(values, root, 'service');
  const reference = normalizeTrackingNumber(optionalText(values, root, 'localtrack')).toUpperCase();
  const courier = Object.hasOwn(COURIERS, service) ? COURIERS[service] : undefined;
  // A courier without its number, or a number without a courier the page links to, is no hand-off.
  if (!courier || !PARTNER_NUMBER.test(reference) || reference === number) return {};
  return { delivery_carrier: courier, delivery_tracking_number: reference };
}

/**
 * The tracking page's data for one parcel number: the number, its statuses
 * newest first, each a code and an instant in milliseconds, and the courier in
 * Ukraine with its own number once the parcel reaches one. A number the
 * tracker does not know fails the page's load with "Parcel not found".
 */
export function parseEci(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEciNumber(raw);
  const values = pageValues(payload);
  const root = values[0];
  if (!isRecord(root)) throw new SchemaError(PROVIDER, 'E-Commerce International returned an invalid page reply');
  const asked = at(values, root.parcelNumber);
  if (typeof asked !== 'string') throw new SchemaError(PROVIDER, 'E-Commerce International returned a reply without the number asked');
  if (normalizeTrackingNumber(asked).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'E-Commerce International answered for another shipment');
  const rows = at(values, root.history);
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'E-Commerce International returned an invalid history');
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'E-Commerce International returned an oversized history');
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Newest first; statuses on one instant keep the reply's order, which lists the newest first.
  const events = rows.map((ref, index) => scan(values, ref, index))
    .sort((a, b) => b.at - a.at || a.index - b.index).map(({ event }) => event);
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
    ...onwardCourier(values, root, number),
    events,
  };
}
