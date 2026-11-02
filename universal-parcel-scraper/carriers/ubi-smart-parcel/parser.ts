import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ubiStage } from './status.js';

export const PROVIDER = 'UBI Smart Parcel';
// A parcel's reply is about ten kilobytes: two dozen scans.
export const UBI_MAX_BYTES = 1024 * 1024;

// The tracker looks up any letters and digits: UBI's own numbers and those of
// the carriers it hands parcels to.
const NUMBER = /^[A-Z0-9]{6,40}$/;
const PARTNER_NUMBER = /^[A-Z0-9]{4,40}$/;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const GMT_LABEL = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/;
// Zone names a partner in North America gives its scans. Ambiguous names
// (CST is also China's) stay unread.
const ZONE_NAMES: Readonly<Record<string, string>> = {
  NDT: '-02:30', ADT: '-03:00', EDT: '-04:00', EST: '-05:00', CDT: '-05:00', MDT: '-06:00', MST: '-07:00', PDT: '-07:00', PST: '-08:00',
};
// The service's own clock, which its hubs in China share.
const CHINA = '+08:00';
// How far a partner's scan may seem to come after the service recorded it.
const RECORDING_MARGIN_MS = 15 * 60_000;
const CODE = /^[A-Z0-9-]{1,16}$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number as the tracker looks it up: upper case, letters and digits only. */
export function normalizeUbiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'UBI Smart Parcel tracks six to forty letters and digits');
  return number;
}

/** An optional text field; an object, array or other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `UBI Smart Parcel returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A list of numbers in the reply's head. */
function numbers(data: Record<string, unknown>, key: string): string[] {
  const value = data[key] ?? [];
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== 'string')) {
    throw new SchemaError(PROVIDER, `UBI Smart Parcel returned an invalid ${key}`);
  }
  return value.map((item: string) => normalizeTrackingNumber(item.slice(0, 64)));
}

/** A `YYYY-MM-DD HH:mm:ss` reading as an ISO wall clock, checked field by field. */
function wallOf(value: string): string | null {
  const match = WALL_CLOCK.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00'] = match;
  // Luxon accepts hour 24.
  if (!calendarDay(Number(year), Number(month), Number(day)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/** The offset a zone label names, or null for one it does not settle. */
function offsetOf(label: string): string | null {
  if (Object.hasOwn(ZONE_NAMES, label)) return ZONE_NAMES[label]!;
  const match = GMT_LABEL.exec(label);
  if (!match) return null;
  const [, sign = '+', hours = '0', minutes = '00'] = match;
  if (Number(hours) > 14 || !['00', '30', '45'].includes(minutes)) return null;
  return `${sign}${hours.padStart(2, '0')}:${minutes}`;
}

/** The instant a wall clock names at an offset. */
function instantOf(wall: string, offset: string): number {
  const parsed = explicitOffsetTime(`${wall}${offset}`);
  if (!parsed) throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned an invalid clock');
  return parsed.timestamp;
}

interface Scan {
  readonly event: CarrierEvent;
  /** The labelled instant, or the wall clock on the service's clock: for ordering only. */
  readonly at: number;
  readonly index: number;
  readonly code: string;
}

/**
 * Whether a scan's zone label names its instant. The service labels its own
 * scans with the zone of the place, but abroad the label does not follow
 * daylight saving time, so only its hubs' scans on China's clock keep their
 * offset. A partner's scan relayed under its own zone keeps it once the
 * service recorded it after that instant; one relayed under China's label is
 * the partner's wall clock.
 */
function labelHolds(offset: string | null, at: number, relayed: boolean, recordedAt: number | null): boolean {
  if (!offset) return false;
  if (!relayed) return offset === CHINA;
  return offset !== CHINA && recordedAt !== null && at <= recordedAt + RECORDING_MARGIN_MS;
}

/** The scan's place. A part holding a digit could be a street or a postcode, so it is left out. */
function placeOf(row: Record<string, unknown>): string {
  return text(row, 'location', 200).split(',').map((part) => part.trim())
    .filter((part) => part && !/\d/.test(part)).join(', ');
}

/**
 * One scan: its clock, the wording the page shows, UBI's event code and the
 * place. A partner's scan relayed in UBI's words also carries the partner's
 * own wording in `sourceActivity`, which the page does not show: it only
 * tells relayed scans from UBI's own.
 */
function scanOf(row: unknown, index: number): Scan & { readonly number: string; readonly relayed: boolean } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned an invalid scan');
  const source = text(row, 'sourceActivity');
  const description = text(row, 'activity') || source;
  const wall = wallOf(text(row, 'eventTime', 40));
  if (!description || !wall) throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned a scan without its wording or clock');
  const offset = offsetOf(text(row, 'localTimeZone', 16).toUpperCase());
  const at = instantOf(wall, offset ?? CHINA);
  const recorded = wallOf(text(row, 'dateCreated', 40));
  const relayed = source !== '';
  const clock = labelHolds(offset, at, relayed, recorded ? instantOf(recorded, CHINA) : null)
    ? { time: explicitOffsetTime(`${wall}${offset}`)!.iso } : { local_time: wall };
  const rawCode = text(row, 'eventCode', 16).toUpperCase();
  const code = CODE.test(rawCode) ? rawCode : '';
  const location = placeOf(row);
  const staged = ubiStage(code, description);
  const event: CarrierEvent = { ...clock, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  const number = normalizeTrackingNumber(text(row, 'trackingNo', 64));
  return { event, at, index, code, number: PARTNER_NUMBER.test(number) ? number : '', relayed };
}

/** The carrier whose site the tracker links for the parcel, when every link names the same one. */
function partnerOf(sites: unknown): string | undefined {
  if (sites === null || sites === undefined) return undefined;
  if (!Array.isArray(sites) || sites.length > 20) throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned invalid partner links');
  const ids = new Set(sites.map((site) => (isRecord(site) ? carrierIdFromPartner('', text(site, 'webSite', 300)) : undefined)));
  const [id] = ids;
  return ids.size === 1 && id && id !== 'ubi-smart-parcel' ? id : undefined;
}

/** A reply read for one number, and whether that number is the partner's rather than UBI's. */
export interface UbiReply {
  readonly result: CarrierResult;
  /** The tracker found the parcel by the number its delivering partner tracks it under. */
  readonly partnerNumber: boolean;
}

/**
 * The reply of `POST /api/aggregator/v1/track/trackParcel`. The head lists the
 * numbers asked for and those the tracker does not know; each parcel found
 * names the number it was asked by. A parcel's scans carry the number they
 * were made under: UBI's own, and the partner's for its scans and for UBI's
 * scans once the parcel has its label. The partner's own number is the other
 * one on the parcel's scans, and its site in `webSites` names it. The site's
 * description holds opening hours and is never read.
 */
export function readUbiReply(payload: unknown, raw: string, readAt: number): UbiReply {
  const number = normalizeUbiNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned an unexpected reply');
  // The service turns down a request it cannot read with HTTP 200 and an error code.
  if (payload.success !== true || text(payload, 'code', 16) !== '0') {
    throw new IndeterminateError(PROVIDER, 'UBI Smart Parcel refused the tracking request');
  }
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.trackParcelEvents) || data.trackParcelEvents.length > 50) {
    throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned a reply without its parcels');
  }
  if (!numbers(data, 'queryTrackingNos').includes(number)) throw new SchemaError(PROVIDER, 'UBI Smart Parcel answered for another number');
  const missing = numbers(data, 'missTrackingNos').includes(number);
  const parcels = data.trackParcelEvents.filter((parcel) => isRecord(parcel)
    && normalizeTrackingNumber(text(parcel, 'trackingNo', 64)) === number) as Record<string, unknown>[];
  if (!parcels.length && missing && !data.trackParcelEvents.length) throw new NotFoundError(PROVIDER);
  if (parcels.length !== 1 || missing) throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned no single parcel for the number');
  const parcel = parcels[0]!;
  const rows = parcel.events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned an invalid parcel history');

  const all = rows.map(scanOf);
  // A parcel's scans under its two numbers can repeat one another; identical
  // ones are kept once. UBI lists the flight it books from its hub ahead of
  // time (the page's milestone is "Planning Depart"): it counts once its time comes.
  const seen = new Set<string>();
  const scans = all.filter((scan) => {
    if (scan.code === 'LHL' && scan.at > readAt) return false;
    const key = JSON.stringify([scan.event.time ?? scan.event.local_time, scan.at, scan.code, scan.event.description, scan.event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by labelled instant; equal ones keep the reply's order.
  scans.sort((left, right) => right.at - left.at || left.index - right.index);

  const others = new Set(all.map((scan) => scan.number).filter((other) => other && other !== number));
  const relayedHere = all.some((scan) => scan.relayed && scan.number === number);
  const delivery = others.size === 1 && !relayedHere ? [...others][0] : undefined;
  const countries = new Set(rows.map((row) => (isRecord(row) ? text(row, 'destCountry', 8).toUpperCase() : '')).filter(Boolean));
  const [country = ''] = countries;

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  // A partner's pre-advice after UBI took the parcel is no step back.
  const current = events.find((event) => event.stage && event.stage !== 'registered')
    ?? events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const partner = partnerOf(parcel.webSites);
  const result: CarrierResult = {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(delivery ? { delivery_tracking_number: delivery } : {}),
    ...(countries.size === 1 && /^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
  return { result, partnerNumber: others.size > 0 && relayedHere };
}

/** The tracking result of a reply read for one number. */
export function parseUbi(payload: unknown, raw: string, readAt: number): CarrierResult {
  return readUbiReply(payload, raw, readAt).result;
}
