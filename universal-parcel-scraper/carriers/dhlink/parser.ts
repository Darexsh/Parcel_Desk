import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence, isoTime, usStateTimeZone } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { countryZones } from '../../places/zones.js';
import { DHLINK_RECORD_ZONE as RECORD_ZONE, usClockCopy } from './clock.js';
import { dhlinkEnglish, dhlinkStage, FLIGHT_BOOKED } from './status.js';

export const PROVIDER = 'DHLink';
// A long history is a few dozen kilobytes.
export const DHLINK_MAX_BYTES = 512 * 1024;
// DHLink numbers, waybills and line providers' numbers: letters and digits, with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The earliest instant a wall clock can stand for: a row still after the read at UTC+14 is written ahead of its time.
const EARLIEST = FixedOffsetZone.instance(14 * 60);
// Some scanners run early.
const CLOCK_SKEW_MS = 3_600_000;
// Stages of a parcel on its way, after which a receipt is no new acceptance.
const MOVED = new Set(['in_transit', 'customs', 'out_for_delivery']);
// A US post office: its state, then the ZIP code ("NY 10001", "NY;10001", "NY, US 10001").
const US_OFFICE = /\b([A-Z]{2})(?:[ ,;]+US)?[ ,;]+\d{5}(?:-\d{4})?\b/;
// A US hub: its town, state and country ("Sampleville, IL, US").
const US_HUB = /,\s*([A-Z]{2})\s*,\s*US$/;
// DHLink's node for the last-mile partner taking the parcel over.
const LAST_MILE_PICKUP = 'TQ001';
// States whose places keep different clocks, so a state does not settle a clock's zone.
const SPLIT_STATES = new Set(['AK', 'AZ', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// DHLink's own number, FC and thirteen digits.
const DHLINK_NUMBER = /^FC\d{13}$/;
const STATE_NOT_FOUND = 1;
const STATE_DELIVERED = 3;
const CJK = /[㐀-鿿豈-﫿]/;
// China's provinces and the cities DHLink's lines leave from, as a place part
// writes them in Latin letters, spaced or not ("SHENZHEN", "shen zhen").
const CHINA_NAMES = new RegExp(`^(?:${[
  'anhui', 'beijing', 'chongqing', 'fujian', 'gansu', 'guangdong', 'guangxi', 'guizhou', 'hainan', 'hebei', 'heilongjiang',
  'henan', 'hubei', 'hunan', 'jiangsu', 'jiangxi', 'jilin', 'liaoning', 'shaanxi', 'shandong', 'shanghai', 'shanxi',
  'sichuan', 'tianjin', 'yunnan', 'zhejiang', 'chengdu', 'dongguan', 'foshan', 'fuzhou', 'guangzhou', 'hangzhou', 'huizhou',
  'jinhua', 'nanjing', 'ningbo', 'putian', 'qingdao', 'quanzhou', 'shantou', 'shenzhen', 'suzhou', 'wenzhou', 'wuhan',
  'xiamen', 'yiwu', 'zhengzhou', 'zhongshan', 'zhuhai',
].join('|')})(?:shi|city)?$`);
const COUNTRY = /^[A-Z]{2}$/;
const PLACEHOLDERS = new Set(['', '.', '-', 'none', 'null', 'unknown']);
// A state with its ZIP code, as relayed USPS rows name the office: the state stays.
const STATE_ZIP = /\b([A-Z]{2})[ ,;]+\d{5}(?:-\d{4})?\b/g;
// British and Canadian postcodes.
const POSTCODE = /\b(?:[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|[A-Z]\d[A-Z] ?\d[A-Z]\d)\b/g;
// Contact or signature details a relayed post can append: the scan's wording is what comes before.
const CONTACT = /(?:投递员|快递员|派送员|联系电话|电话[:：]|手机[:：]|签收人[:：]|代收人[:：]|收件人[:：]|signed (?:for )?by\b|signature[:：]|\btel(?:ephone)?[:.：]|\bphone[:：])[\s\S]*$/i;

/**
 * DHLink's last-leg partners. The reply gives the last leg's number
 * (`lastTurnNo`) but names no partner, so the partner is read from the
 * number's whole layout. A number no layout fits gives no hand-off.
 * `beijingClock` marks a partner whose scans DHLink relays on its own
 * Beijing clock rather than the scan's, and `hubClockPickup` one whose pickup
 * DHLink's node copies from the partner's first scan, on its hub's clock.
 */
export const DHLINK_LAST_LEGS: readonly {
  readonly carrier: string; readonly number: RegExp; readonly beijingClock?: true; readonly hubClockPickup?: true;
}[] = [
  // SwiftX's own numbers: SWX and eighteen digits, the layout `swiftx-1` claims. Its
  // relayed rounds and deliveries are recorded before a US reading of their clocks.
  { carrier: 'swiftx', number: /^SWX\d{18}$/, beijingClock: true },
  // GOFO's US waybills: GFUS and fourteen digits, the layout `gofo-1` claims. Its relayed
  // scans come twelve hours after GOFO's own on a US reading. DHLink's pickup node gives
  // GOFO's arrival at its regional hub, the same clock and town as GOFO's own scan.
  { carrier: 'gofo', number: /^GFUS\d{14}$/, beijingClock: true, hubClockPickup: true },
  // DPD Switzerland's parcel numbers: fourteen digits from its depots 0600 to 0619.
  { carrier: 'dpd', number: /^06[01]\d{11}$/ },
];

/** A number DHLink's tracker can be asked for; anything else is not sent. */
export function normalizeDhlinkNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DHLink tracking numbers are 8 to 40 letters and digits');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `DHLink returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

function withoutPostcodes(value: string): string {
  return value.replace(STATE_ZIP, '$1').replace(POSTCODE, '').replace(/\s+/g, ' ').trim();
}

function wordingOf(info: string): string {
  return withoutPostcodes(info.replace(CONTACT, '')).replace(/[\s,，;；:：(（]+$/, '');
}

/** The words of a place part before the first one holding a digit: a postcode or a street number. */
function beforeDigits(part: string): string {
  const words = part.split(' ');
  const index = words.findIndex((word) => /\d/.test(word));
  return (index < 0 ? words : words.slice(0, index)).join(' ');
}

/**
 * A row's place without its postcode or placeholder, and whether it is in
 * China. Feeds append the destination's code to Chinese places ("广州市,GB",
 * "SHENZHEN, US"), and a code alone names no place.
 */
function placeOf(raw: string): { location: string; china: boolean } {
  const parts = withoutPostcodes(raw).split(/[,;]/).map((part) => beforeDigits(part.trim()))
    .filter((part) => !PLACEHOLDERS.has(part.toLowerCase()));
  const china = CJK.test(raw) || parts.some((part) => CHINA_NAMES.test(part.toLowerCase().replace(/\s+/g, '')));
  const kept = china ? parts.filter((part) => !COUNTRY.test(part)) : parts;
  return { location: kept.every((part) => COUNTRY.test(part)) ? '' : [...new Set(kept)].join(', '), china };
}

interface Scan {
  stamp: string;
  event: CarrierEvent;
  /** Ranks the rows that share a clock: DHLink's node, English, a place, a stage, then the longer wording. */
  rank: readonly number[];
  /** A place in China. */
  china: boolean;
  /** The zone of the US state a post office's row names, unless the state spans several. */
  state: string | null;
  /** DHLink's node for the last-mile partner's pickup, naming the partner's US hub by its state. */
  hub: boolean;
  /** When DHLink recorded the row, or the read when it does not say. */
  recorded: number;
}

/** The instant DHLink recorded a row, on its Beijing clock; null when the reply does not say. */
function recordedAt(row: Record<string, unknown>): number | null {
  const wall = WALL_CLOCK.exec(text(row, 'createDate', 64));
  return wall ? isoTime(`${wall[1]}T${wall[2]}`, RECORD_ZONE)?.timestamp ?? null : null;
}

/**
 * The zone a scan's clock keeps, where DHLink's record shows it. Places in
 * China and every row of a parcel whose last leg relays on Beijing time keep
 * Beijing time, but a pickup that names a hub on the partner's clock. A US
 * post office's row, or that pickup, keeps its state's when the row was
 * recorded after that reading. A row recorded before its clock could have
 * struck at the destination, in any of its zones, keeps DHLink's own Beijing
 * time. Null when either clock could be the row's.
 */
function scanZone(scan: Scan, destination: string, beijingClock: boolean): string | null {
  const fits = (zone: string) => {
    const time = isoTime(scan.stamp, zone);
    return time !== null && time.timestamp <= scan.recorded + CLOCK_SKEW_MS;
  };
  if (scan.china || beijingClock) return fits(RECORD_ZONE) ? RECORD_ZONE : null;
  if (scan.state && fits(scan.state)) return scan.state;
  const away = scan.state ? [scan.state] : countryZones(destination);
  return away.length && !away.includes(RECORD_ZONE) && !away.some(fits) && fits(RECORD_ZONE) ? RECORD_ZONE : null;
}

function projectRow(row: unknown, readAt: number): Scan | 'ahead' | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DHLink returned an invalid scan');
  const stamp = text(row, 'trackTime', 64);
  const wall = WALL_CLOCK.exec(stamp);
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  const earliest = local ? firstOccurrence(DateTime.fromISO(local, { zone: EARLIEST })) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!earliest?.isValid || earliest.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'DHLink returned an invalid scan time');
  // A row dated after the read is not a scan yet.
  if (earliest.toMillis() > readAt) return 'ahead';
  const info = text(row, 'info');
  // DHLink's nodes can end their wording with the row's own clock ("Shipment has delivered at …").
  const said = wordingOf(info);
  const description = said.endsWith(` at ${stamp}`) ? said.slice(0, -` at ${stamp}`.length).trim() : said;
  if (!description || FLIGHT_BOOKED.test(description)) return null;
  const code = text(row, 'nodeCode', 32);
  const name = text(row, 'nodeName', 64);
  const place = text(row, 'place', 200);
  const { location, china } = placeOf(place);
  const staged = dhlinkStage(code, name, description);
  // The clock is set once the scan's rows are pooled.
  const event: CarrierEvent = {
    description: dhlinkEnglish(description) ?? description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  const rank = [name ? 1 : 0, CJK.test(description) ? 0 : 1, location ? 1 : 0, staged ? 1 : 0, description.length];
  // USPS names the office in the place, or else at the end of its wording; the pickup node names the partner's hub.
  const hub = code === LAST_MILE_PICKUP ? (US_OFFICE.exec(place.toUpperCase()) ?? US_HUB.exec(place.toUpperCase()))?.[1] : undefined;
  const office = hub ?? (US_OFFICE.exec(place.toUpperCase()) ?? US_OFFICE.exec(info))?.[1];
  const state = office && !SPLIT_STATES.has(office) ? usStateTimeZone(office) : null;
  return { stamp: local, event, rank, china, state, hub: usStateTimeZone(hub) !== null,
    recorded: Math.min(recordedAt(row) ?? readAt, readAt) };
}

function outranks(left: readonly number[], right: readonly number[]): boolean {
  const index = left.findIndex((value, position) => value !== right[position]);
  return index >= 0 && left[index]! > right[index]!;
}

/** The last leg, when its number's whole layout is one the table maps. */
function lastLeg(entry: Record<string, unknown>): { leg: (typeof DHLINK_LAST_LEGS)[number]; number: string } | null {
  const number = normalizeTrackingNumber(text(entry, 'lastTurnNo', 64));
  const leg = number ? DHLINK_LAST_LEGS.find((candidate) => candidate.number.test(number)) : undefined;
  return leg ? { leg, number } : null;
}

/**
 * The reply of `POST /stage-api/trbiz/track/queryTrack` for one number. The
 * search finds a parcel by its tracking number, and by other numbers of the
 * parcel too, so the parcel counts only when the number asked is its tracking
 * number or its DHLink number. Each scan comes once per feed that relays it,
 * in English or Chinese and sometimes in two formats: the rows that share a
 * clock are one scan. The order id, the feeds' ids and the row ids are not read.
 */
export function parseDhlink(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeDhlinkNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'DHLink returned an invalid envelope');
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, 'DHLink did not complete the lookup');
  const list = isRecord(payload.data) ? payload.data.trackList : undefined;
  if (!Array.isArray(list) || list.length !== 1 || !isRecord(list[0])) throw new SchemaError(PROVIDER, 'DHLink returned an invalid parcel list');
  const entry = list[0];
  const tracking = normalizeTrackingNumber(text(entry, 'trackno', 64));
  const own = normalizeTrackingNumber(text(entry, 'logisticsNo', 64));
  const rows = entry.trackinfoList;
  // The tracker answers a number it does not know with an empty parcel and counts it not found.
  if (entry.state === STATE_NOT_FOUND && !tracking && !own && (rows === null || rows === undefined)) {
    // It answers a parcel's DHLink number the same way when the parcel has another tracking
    // number, and its last leg's number always: for those layouts the answer settles nothing,
    // but the reason tells it from an outage.
    if (DHLINK_NUMBER.test(number)) {
      throw new IndeterminateError(PROVIDER, 'DHLink finds a parcel by its DHLink number only when that is its tracking number', { reason: 'portal_not_found' });
    }
    if (DHLINK_LAST_LEGS.some((leg) => leg.number.test(number))) {
      throw new IndeterminateError(PROVIDER, 'DHLink does not find a parcel by the number of its last leg', { reason: 'portal_not_found' });
    }
    throw new NotFoundError(PROVIDER);
  }
  if (tracking !== number && own !== number) throw new IndeterminateError(PROVIDER, 'DHLink answered with another parcel');
  if (rows === null || rows === undefined) throw new IndeterminateError(PROVIDER, 'DHLink has no scans for the parcel yet');
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'DHLink returned a parcel without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DHLink returned an oversized history');

  const scans = new Map<string, Scan>();
  let ahead = false;
  for (const row of rows) {
    const scan = projectRow(row, readAt);
    if (scan === 'ahead') ahead = true;
    if (!scan || scan === 'ahead') continue;
    const held = scans.get(scan.stamp);
    // The rows of one scan pool what they show of its clock: a place, and the earliest record.
    const kept = !held || outranks(scan.rank, held.rank) ? scan : held;
    scans.set(scan.stamp, held ? { ...kept, china: held.china || scan.china, state: held.state ?? scan.state,
      hub: held.hub || scan.hub, recorded: Math.min(held.recorded, scan.recorded) } : kept);
  }
  const code = text(entry, 'destCountryCode', 8).toUpperCase();
  // DHLink writes Britain's code as UK.
  const destination = code === 'UK' ? 'GB' : code;
  const last = lastLeg(entry);
  // Newest first, as the tracking page lists them; the clocks sort as written.
  const dated = [...scans.values()].sort((left, right) => (left.stamp < right.stamp ? 1 : left.stamp > right.stamp ? -1 : 0))
    .map((scan) => {
      const zone = scanZone(scan, destination, last?.leg.beijingClock === true && !(scan.hub && last.leg.hubClockPickup));
      return { scan, zone, time: zone ? isoTime(scan.stamp, zone) : null };
    });
  // Beside DHLink's own record of a partner's scan on Beijing time, the partner's copy can come
  // on its US wall clock: the same wording, at the instant of DHLink's row on a US reading.
  // Without a partner known to be relayed on Beijing time, DHLink's row must be read on it.
  const copies = destination === 'US' ? dated.filter(({ scan }) => dated.some((other) =>
    other.scan !== scan && other.time && (last?.leg.beijingClock || other.zone === RECORD_ZONE)
    && other.scan.event.description === scan.event.description && usClockCopy(scan.stamp, other.time.timestamp))) : [];
  // A place naming only the destination country is the parcel's, not the scan's: a Canada line's
  // airline hand-over in China reads "Canada".
  const events = dated.filter((entry) => !copies.includes(entry))
    .map(({ scan, time }): CarrierEvent => {
      const { location, ...event } = scan.event;
      const placed = location && !(destination && countryCode(location) === destination) ? { location } : {};
      return { ...(time ? { time: time.iso } : { local_time: scan.stamp }), ...event, ...placed };
    });
  if (!events.length) throw new IndeterminateError(PROVIDER, 'DHLink has no scans for the parcel yet');
  // A receipt after DHLink moved the parcel on, at another warehouse or the post a line hands it
  // to, takes the parcel along its way: no step back.
  let moved = false;
  for (const event of [...events].reverse()) {
    if (event.stage === 'accepted' && moved) Object.assign(event, { stage: 'in_transit', stage_source: 'carrier_map' });
    else if (event.stage && MOVED.has(event.stage)) moved = true;
  }

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  let stage = current?.stage as Stage | undefined;
  let source = current?.stage_source;
  // DHLink counts the parcel delivered even when the last feed's wording says less,
  // unless rows were written ahead of the read: then the count may be too.
  if (entry.state === STATE_DELIVERED && !ahead && stage !== 'delivered' && stage !== 'returned') {
    stage = 'delivered';
    source = 'carrier_map';
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && newest.stage === 'delivered' && newest.time ? { delivered_at: newest.time } : {}),
    ...(last && ![number, tracking, own].includes(last.number) ? { delivery_carrier: last.leg.carrier, delivery_tracking_number: last.number } : {}),
    ...(COUNTRY.test(destination) ? { destination_country: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
