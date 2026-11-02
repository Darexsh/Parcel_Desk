import { DateTime } from 'luxon';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, sharedClockZone, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { DPD_AT_SHOP_COLLECTION, dpdAtShopCollectionStage, dpdAtStage } from './status.js';

export const PROVIDER = 'DPD Austria';
// A long history is under ten kilobytes.
export const DPD_AT_MAX_BYTES = 512 * 1024;
const ZONE = 'Europe/Vienna';
// DPD Austria's depot list: 0620 to 0630, 0632 to 0635, 0643 to 0645 and 0649.
const AUSTRIAN_DEPOT = /^06(?:2\d|3[02-5]|4[3-59])$/;
const DEPOT = /^\d{4}$/;
const CLOCK = /^\d{14}$/;
const NAME = /^[A-Z0-9_]{1,40}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** The fourteen-digit parcel number myDPD takes, with or without DPD's check character; anything else is not one it issues. */
export function dpdAtNumber(raw: string): string {
  const number = raw.length <= 64 ? dpdParcelNumber(normalizeTrackingNumber(raw)) : null;
  if (!number) throw new InvalidInputError(PROVIDER, 'DPD Austria parcel numbers are fourteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `myDPD returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** `YYYYMMDDHHmmss` as a wall clock, `YYYY-MM-DDTHH:mm:ss`. */
function wallClock(value: string): string {
  const wall = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!CLOCK.test(value) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'myDPD returned an invalid scan time');
  }
  return wall;
}

interface Scan {
  wall: string;
  depot: string;
  place: string;
  country: string;
  code: string;
  description: string;
}

function readScan(entry: unknown): Scan {
  if (!isRecord(entry) || !isRecord(entry.state)) throw new SchemaError(PROVIDER, 'myDPD returned an invalid scan');
  const state = entry.state;
  const depot = text(entry, 'depot', 8);
  if (depot && !DEPOT.test(depot)) throw new SchemaError(PROVIDER, 'myDPD returned an invalid depot');
  const data = entry.depotData ?? null;
  if (data !== null && !Array.isArray(data)) throw new SchemaError(PROVIDER, 'myDPD returned an invalid depot');
  const place = data && typeof data[0] === 'string' ? clean(data[0], 120) : '';
  const named = data && typeof data[1] === 'string' ? clean(data[1], 8).toUpperCase() : '';
  const name = text(state, 'name', 40).toUpperCase();
  const qualifier = text(state, 'additionalInfo', 40).toUpperCase();
  // The page shows the state's text, then details from `infoData` once the
  // parcel is verified: a shop, who took the parcel, where it was left. Those
  // are not read.
  const description = text(state, 'text') || text(state, 'textShort');
  if (!description) throw new SchemaError(PROVIDER, 'myDPD returned a scan without wording');
  return {
    wall: wallClock(text(entry, 'datetime', 16) || text(state, 'datetime', 16)),
    depot,
    place,
    country: /^[A-Z]{2}$/.test(named) ? named : '',
    code: NAME.test(name) ? (NAME.test(qualifier) ? `${name}/${qualifier}` : name) : '',
    description,
  };
}

/**
 * A scan's clock. `datetime` is a wall clock without a zone. A scan in a
 * country that keeps Vienna's civil time at that moment, Austria or Germany
 * for instance, reads the same whichever of the two clocks the service
 * keeps, so it is read in Vienna; any other stays local.
 */
function scanClock(wall: string, country: string): { time: string } | { local_time: string } {
  const zone = country ? countryTimeZone(country) : null;
  const shared = zone ? sharedClockZone([ZONE, zone], wall) : null;
  const instant = shared ? zonedTime(wall, "yyyy-MM-dd'T'HH:mm:ss", shared) : null;
  return instant ? { time: instant.iso } : { local_time: wall };
}

/** What a myDPD reply says about the requested parcel, and the country of its newest scan when the reply shows it. */
export interface DpdAtReading {
  result: CarrierResult;
  country: string | null;
}

/**
 * The reply of myDPD's `parcel/search` for one number. It answers
 * `{"state":"failure"}` for a number it does not know, which the page reports
 * as not found, unless the reply carries a message for the page to show. A
 * parcel must name the number asked.
 */
export function readDpdAt(payload: unknown, raw: string): DpdAtReading {
  const number = dpdAtNumber(raw);
  if (!isRecord(payload) || typeof payload.state !== 'string') throw new SchemaError(PROVIDER, 'myDPD returned an invalid envelope');
  if (payload.state !== 'success') {
    if (payload.state !== 'failure') throw new SchemaError(PROVIDER, 'myDPD returned an unknown answer');
    if (payload.popup) throw new IndeterminateError(PROVIDER, 'myDPD did not complete the lookup');
    throw new NotFoundError(PROVIDER);
  }
  const parcels = Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
  if (!parcels.length || parcels.length !== (payload.data as unknown[]).length) {
    throw new SchemaError(PROVIDER, 'myDPD returned an invalid parcel list');
  }
  const parcel = parcels.find((item) => (text(item, 'parcelno', 32) || text(item, 'pno', 32)) === number);
  if (!parcel) throw new IndeterminateError(PROVIDER, 'myDPD answered for another parcel');
  const lifecycle = parcel.lifecycle ?? null;
  if (lifecycle === null) throw new NoHistoryError(PROVIDER);
  if (!isRecord(lifecycle)) throw new SchemaError(PROVIDER, 'myDPD returned an invalid history');
  const entries = lifecycle.entries ?? [];
  if (!Array.isArray(entries)) throw new SchemaError(PROVIDER, 'myDPD returned an invalid history');
  if (entries.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'myDPD returned an oversized history');

  // Oldest first, as the page lists them; a scan sharing its clock with
  // another keeps its place in the reply.
  const scans = entries.map(readScan).sort((left, right) => left.wall.localeCompare(right.wall));
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // The reply names a depot's town and country on the first scan there only.
  const countries = new Map<string, string>();
  for (const scan of scans) if (scan.depot && scan.country && !countries.has(scan.depot)) countries.set(scan.depot, scan.country);
  const countryOf = (scan: Scan) => scan.country || countries.get(scan.depot) || (AUSTRIAN_DEPOT.test(scan.depot) ? 'AT' : '');
  const places = new Map<string, string>();
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let previous: Stage | undefined;
  let waited = false;
  for (const scan of scans) {
    const country = countryOf(scan);
    if (scan.place) places.set(scan.depot, country ? `${scan.place}, ${country}` : scan.place);
    const location = scan.place ? places.get(scan.depot)! : (scan.depot && places.get(scan.depot)) || '';
    const staged = scan.code.toUpperCase() === DPD_AT_SHOP_COLLECTION
      ? { stage: dpdAtShopCollectionStage(waited, previous), source: 'carrier_map' as const } : dpdAtStage(scan.code, scan.description);
    if (staged) previous = staged.stage;
    if (staged?.stage === 'ready_for_pickup') waited = true;
    const key = JSON.stringify([scan.wall, scan.code, scan.description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      ...scanClock(scan.wall, country),
      ...(location ? { location } : {}),
      description: scan.description,
      ...(scan.code ? { provider_code: scan.code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  const newestFirst = events.reverse();
  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? newestFirst.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    result: {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
      last_status_text: newest.description!,
      last_update: newest.time ?? null,
      ...(newest.time ? {} : { last_update_local: newest.local_time }),
      expected_delivery: null,
      ...(delivered ? { delivered_at: delivered } : {}),
      events: newestFirst.slice(0, MAX_EVENTS),
      ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
    },
    country: countryOf(scans.at(-1)!) || null,
  };
}

export function parseDpdAt(payload: unknown, raw: string): CarrierResult {
  return readDpdAt(payload, raw).result;
}
