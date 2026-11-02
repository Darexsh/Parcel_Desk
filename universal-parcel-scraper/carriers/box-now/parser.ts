import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { boxNowStatus } from './status.js';

export const PROVIDER = 'BOX NOW';
export const BOX_NOW_MAX_BYTES = 256_000;

/** BOX NOW's partner API manual: a parcel id is always ten digits. */
export function normalizeBoxNowNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'BOX NOW parcel ids are ten digits');
  return number;
}

const code = (value: unknown) => {
  const text = clean(value, 64);
  return /^[a-z]+(?:-[a-z]+)*$/.test(text) ? text : '';
};

// The trackers stop showing the estimate once a parcel waits in its locker or
// its journey has ended; only a parcel still on its way keeps one.
const ON_THE_WAY = new Set<Stage>(['registered', 'accepted', 'in_transit']);
// A parcel bound for one of BOX NOW's transfer hubs, such as the hub that passes Vinted's parcels
// to another country's network: a warehouse whose address reads "transfer", or named as a BOX NOW
// hub. A merchant's warehouse, where a return ends, is neither.
const HANDOVER = { wording: 'Parcel has been handed over at a transfer hub for onward delivery', stage: 'in_transit' as Stage };
const transferHub = (destination: Record<string, unknown> | null) => destination?.type === 'warehouse'
  && (/^transfer$/i.test(clean(destination.addressLine1, 64)) || /^BOX NOW\b.*\bHUB\b/i.test(clean(destination.name, 160)));

export function parseBoxNow(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeBoxNowNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > 10) throw new SchemaError(PROVIDER);
  // The official tracker reads an empty list as a parcel id that does not exist.
  if (!payload.data.length) throw new NotFoundError(PROVIDER);
  const parcel: unknown = payload.data[0];
  if (payload.data.length !== 1 || !isRecord(parcel) || parcel.id !== number) {
    throw new SchemaError(PROVIDER, 'BOX NOW did not identify one matching parcel');
  }
  const state = code(parcel.state);
  if (!state) throw new SchemaError(PROVIDER, 'BOX NOW returned a parcel without a state');
  const rows = parcel.events ?? [];
  if (!Array.isArray(rows) || rows.length > 200) throw new SchemaError(PROVIDER, 'BOX NOW returned an invalid parcel history');
  const destination = isRecord(parcel.destination) ? parcel.destination : null;
  // Delivered into a transfer hub is handed over to the next network, not to the recipient.
  const handover = transferHub(destination);
  const status = (type: string) => (handover && type === 'delivered' ? HANDOVER : boxNowStatus(type));

  const scans: { event: CarrierEvent; at: number; type: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'BOX NOW returned an incomplete scan');
    const type = code(row.type);
    const at = explicitOffsetTime(row.createTime);
    if (!type || !at) throw new SchemaError(PROVIDER, 'BOX NOW returned a scan without a type or clock');
    const { wording, stage } = status(type);
    // A new parcel's place is its sender. Postcodes are left out.
    const location = type === 'new' ? '' : clean(row.locationDisplayName, 160);
    const event: CarrierEvent = { time: at.iso, description: wording, provider_code: type,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); scans.push({ event, at: at.timestamp, type }); }
  }
  // The reply lists scans oldest first; equal clocks keep their order, reversed.
  const ordered = scans.map((scan, index) => ({ ...scan, index }))
    .sort((left, right) => right.at - left.at || right.index - left.index);
  const events = ordered.map(({ event }) => event);

  // The trackers show the newest scan's type while the parcel's state only
  // says it is on its way, and the state otherwise.
  const newest = ordered[0]?.type;
  const shown = newest && ['in-transit', 'in-depot'].includes(state)
    && ['accepted-to-locker', 'accepted-for-return', 'in-depot', 'new', 'wait-for-load'].includes(newest) ? newest : state;
  const current = status(shown);
  const stage = current.stage;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  const deliveredIndex = delivered ? events.indexOf(delivered) : -1;

  // The recipient's locker, by name only, once the parcel waits there or was collected from it.
  const collected = deliveredIndex >= 0 && lastMovement(events.slice(deliveredIndex + 1)) === 'ready_for_pickup';
  const locker = destination?.type === 'apm' && (stage === 'ready_for_pickup' || collected) ? clean(destination.name, 160) : '';
  // A transfer hub's country is not where the parcel is going.
  const country = destination && !handover ? countryCode(destination.country) : null;

  // A parcel handed over at a transfer hub has left BOX NOW's estimate behind.
  const eta = typeof parcel.etaDate === 'string' && stage && ON_THE_WAY.has(stage) && !handover ? explicitOffsetTime(parcel.etaDate) : null;
  // The trackers print the estimate as a day in Athens.
  const expected = eta ? DateTime.fromMillis(eta.timestamp, { zone: 'Europe/Athens' }).toISODate() : null;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.wording,
    ...(events.length ? {} : { provider_code: shown, summary_only: true }),
    last_update: events[0]?.time ?? null,
    expected_delivery: expected,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...(locker ? { pickup_point: locker } : {}),
    ...(country ? { destination_country: country } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
