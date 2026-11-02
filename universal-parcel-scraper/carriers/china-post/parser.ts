import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, SchemaError, type CarrierError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { chinaPostAirline, chinaPostCountry, chinaPostEnglish, chinaPostPlace, chinaPostStateStatus, chinaPostStatus } from './status.js';

export const PROVIDER = 'China Post';
const SUCCESS = '000000';
const MAX_SCANS = 500;
const MAX_EVENTS = 100;
// Guests receive at most the three newest scans.
const GUEST_SCANS = 3;
// The app's label for an accepted item (state 5).
const ACCEPTED = '已揽收';

/**
 * S10 numbers issued in China, and ZS, ZC or ZA numbers of eleven digits. The
 * service asks for phone digits on them; the public web preview is separate.
 */
export function normalizeChinaPostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^Z[SCA]\d{11}$/.test(number) && (!/^[A-Z]{2}\d{9}CN$/.test(number) || !isValidS10TrackingNumber(number))) {
    throw new InvalidInputError(PROVIDER, 'China Post tracks international postal numbers ending in CN and ZS, ZC or ZA numbers');
  }
  return number;
}

export interface ChinaPostReply {
  code: string;
  msg: string;
  info: unknown;
}

/** The service envelope: `{ code, msg, info }`. */
export function chinaPostReply(payload: unknown): ChinaPostReply {
  if (!isRecord(payload) || typeof payload.code !== 'string' || !/^\d{6}$/.test(payload.code)) {
    throw new SchemaError(PROVIDER, 'China Post returned an invalid tracking envelope');
  }
  return { code: payload.code, msg: clean(payload.msg, 200), info: payload.info };
}

/** A non-success answer. None of them says that the shipment does not exist. */
export function chinaPostRefusal(reply: ChinaPostReply): CarrierError {
  if (/签名验证失败/.test(reply.msg)) return new ChallengeError(PROVIDER, 'China Post refused the application signature');
  // The app reads 200001 and 200002 as an expired sign-in ("登陆过期") and
  // sends the user to log in; the login-only trace says "请登录后再查询".
  if (reply.code === '200001' || reply.code === '200002' || /登录|登陆/.test(reply.msg)) {
    return new ChallengeError(PROVIDER, 'China Post asked for a signed-in account');
  }
  // 600001 ("输入有误") answers a trace request the check step did not open,
  // and a wrong phone suffix: neither is a statement about the parcel.
  if (reply.code === '600001') return new IndeterminateError(PROVIDER, 'China Post did not open the trace for this lookup');
  // The app shows the same "no logistics information" toast for unknown,
  // not-yet-scanned and out-of-scope numbers.
  if (/暂无物流信息/.test(reply.msg)) return new NoHistoryError(PROVIDER, 'China Post has no tracking information for this number yet');
  if (/繁忙|稍后/.test(reply.msg)) return new IndeterminateError(PROVIDER, 'China Post tracking is busy');
  return new IndeterminateError(PROVIDER, 'China Post returned an unexpected tracking answer');
}

/**
 * The check step, mirroring the app: 2 asks for the last four digits of a
 * contact phone, 3 means no information, anything else opens the trace.
 */
export function checkChinaPostGate(payload: unknown): void {
  const reply = chinaPostReply(payload);
  if (reply.code !== SUCCESS) throw chinaPostRefusal(reply);
  if (typeof reply.info !== 'number' || !Number.isInteger(reply.info)) {
    throw new SchemaError(PROVIDER, 'China Post returned an invalid check answer');
  }
  if (reply.info === 2) {
    throw new InputRequiredError(PROVIDER, 'recipient verification', 'China Post asks for the last four digits of a contact phone number');
  }
  if (reply.info === 3) throw new NoHistoryError(PROVIDER, 'China Post has no tracking information for this number yet');
}

// Contact and signature prose: courier names and phones, signers, hotlines.
const PERSONAL = /电话|手机|致电|联系|快递员|投递员|揽投员|揽收员|派送员|派件员|收派员|配送员|司机|签收|签字|收件人|寄件人|收货人|本人|代收|姓名|热线|\d{5,}|\d{3,4}-\d{3,}/;
// Bracketed offices, workshops, exchanges, airports and the cities and
// counties of flight legs end with one of these. 区 is left out: it also ends
// residential compounds (小区). A bare 州 or 省 can end a given name, so only
// an autonomous prefecture's full name counts.
const OFFICE = /(?:局|部|中心|站|所|处|公司|仓|港|场|口岸|海关|网点|营业厅|厅|机场|航空|车间|市|县|自治州)$/;

function safeText(value: string): boolean {
  if (!value || PERSONAL.test(value) || /[【】]/.test(value.replace(/【[^【】]*】/g, ''))) return false;
  return [...value.matchAll(/【([^【】]*)】/g)].every(([, inner]) => OFFICE.test(inner!) || chinaPostCountry(inner!) !== undefined);
}

/**
 * The first clause of a scan's text when it names only offices or countries;
 * otherwise the scan's state label. Later clauses carry courier contacts.
 */
export function chinaPostDescription(operation: unknown, state: unknown): string {
  const first = clean(operation, 500).split(/[，,。;；！!？?:：]/, 1)[0]!.trim().slice(0, 120);
  if (safeText(first)) return first;
  // State labels are short enumerated words ("已签收"), never contact prose.
  const label = clean(state, 40);
  return /^[\u4e00-\u9fff]{1,16}$/.test(label) && !/电话|手机|联系|姓名|员/.test(label) ? label : '';
}

function wallClock(value: unknown): string | undefined {
  const raw = clean(value, 32);
  const parsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? DateTime.fromFormat(raw, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }) : null;
  // UTC only validates the calendar; the service supplies no offset.
  return parsed?.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

const CHINA_ZONE = 'Asia/Shanghai';

/**
 * A scan's wall clock and its instant on China's clock, on which China Post
 * dates its own scans abroad too: read on the destination's clock, a landing
 * would come an hour after the flight left China, and YunExpress states
 * +08:00 for the same arrival at the destination.
 */
export function chinaClock(local: string): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const time = firstOccurrence(DateTime.fromISO(local, { zone: CHINA_ZONE })).toISO({ suppressMilliseconds: true })!;
  return { local_time: local, time, time_zone: CHINA_ZONE, time_zone_basis: 'carrier' };
}

// The destination post's scans the app copies on that post's wall clock, to the
// minute of the post's or UPU's own: arrival at its processing centre (459),
// presentation to import customs (486), customs' hold (493) and release (487),
// departure from the processing centre (460), arrival at the delivery office
// (461), out for delivery (462), delivery (463) and departure from a transit
// office (489).
const DESTINATION_CLOCK = new Set(['459', '460', '461', '462', '463', '486', '487', '489', '493']);

function scanTime(value: unknown): string {
  const time = wallClock(value);
  if (!time) throw new SchemaError(PROVIDER, 'China Post returned an invalid scan time');
  return time;
}

function scanLocation(value: unknown): string | undefined {
  const location = clean(value, 100);
  return location && !PERSONAL.test(location) ? location : undefined;
}


/**
 * Whether one of the destination's own offices made the scan: its code is the
 * country's ("BR") or a UPU office of exchange code that starts with it
 * ("COBOGC"), or its office is named after the country. Airline handovers use
 * codes too ("CF", "HKG"), so no other code counts.
 */
function atDestination(scan: Record<string, unknown>, destination: string | undefined): boolean {
  const office = clean(scan.orgName, 100);
  if (!destination || chinaPostAirline(office)) return false;
  const code = cleanScalar(scan.orgCode, 8).toUpperCase();
  return code === destination || (/^[A-Z]{5}[A-Z0-9]$/.test(code) && code.startsWith(destination)) || chinaPostCountry(office) === destination;
}

/**
 * A scan's office, or the destination country when one of the destination's
 * offices names itself only by code (orgName ""). A country shows in English.
 */
function placeOfScan(scan: Record<string, unknown>, country: string | undefined): string | undefined {
  const office = clean(scan.orgName, 100);
  const place = chinaPostAirline(office) ? undefined : scanLocation(office) ?? country;
  return place && chinaPostPlace(place);
}

interface Scan {
  event: CarrierEvent;
  code: string;
  status: ClassifiedStatus | undefined;
  /** Scanned by one of the destination's own offices. */
  atDestination: boolean;
}

// Inbound processing at the destination: arrival at (459) and departure from
// (460) its processing centre, departure from a transit office (489) and
// arrival at the delivery office (461). Its post can upload these after
// delivering the item.
const LATE_UPLOADS = new Set(['459', '460', '461', '489']);

/**
 * The scan that sets the current status: the newest, unless a delivery is
 * followed only by inbound processing scans of the destination's own offices.
 * Any other scan counts as newer: a state label is coarser than its scan (an
 * attempt can read 运送中), and export customs there starts a way back.
 */
function currentScan(scans: readonly Scan[]): Scan {
  const delivered = scans.findIndex(({ status }) => status?.stage === 'delivered');
  const late = delivered > 0 && scans.slice(0, delivered).every(({ code, atDestination }) => atDestination && LATE_UPLOADS.has(code));
  return scans[late ? delivered : 0]!;
}

/** The whole history's scan count, when the reply states one. */
function scanCount(value: unknown): number | undefined {
  const count = cleanScalar(value, 12);
  return /^\d+$/.test(count) ? Number(count) : undefined;
}

/**
 * The acceptance the collector record dates, for a history whose older scans
 * guests do not receive. Only its time and office are read.
 */
function acceptanceScan(collector: unknown, oldest: CarrierEvent): CarrierEvent | undefined {
  if (!isRecord(collector)) return undefined;
  const time = wallClock(collector.opTime);
  // Acceptance precedes every later scan; an equal or later clock is not one.
  if (!time || !oldest.local_time || time >= oldest.local_time) return undefined;
  const location = scanLocation(collector.orgName);
  return { ...chinaClock(time), description: chinaPostEnglish(ACCEPTED)!, ...(location ? { location } : {}), stage: 'accepted', stage_source: 'carrier_map' };
}

/**
 * Project the trace answer. Only scan time, code, text, state label, office
 * and office code are read, plus the collector's time and office, the scan
 * count and the destination country label; contact, address, courier,
 * signature and map fields are never touched.
 */
export function parseChinaPostTraces(payload: unknown, raw: string): CarrierResult {
  const number = normalizeChinaPostNumber(raw);
  const reply = chinaPostReply(payload);
  if (reply.code !== SUCCESS) throw chinaPostRefusal(reply);
  const mail = isRecord(reply.info) ? reply.info.mail : undefined;
  // Like the app, a null info and a null, blank or empty mail record mean no
  // logistics information. The service writes null fields out, so a missing
  // key stays a malformed reply.
  if (reply.info === null || mail === null || mail === '' || (isRecord(mail) && !Object.keys(mail).length)) {
    throw new NoHistoryError(PROVIDER, 'China Post has no tracking information for this number yet');
  }
  if (!isRecord(mail)) throw new SchemaError(PROVIDER, 'China Post returned no mail record');
  if (clean(mail.mailNo, 40).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'China Post returned a different shipment');
  if (!Array.isArray(mail.mailInfos) || mail.mailInfos.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'China Post returned an invalid scan list');
  const scans: readonly unknown[] = mail.mailInfos;
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'China Post returned no scans for this number');

  const country = clean(mail.receiverCountryName, 80);
  const destination = country ? chinaPostCountry(country) : undefined;
  const kept: Scan[] = [];
  const seen = new Set<string>();
  // Scans arrive oldest first. Reversal keeps the service's order: Chinese
  // and foreign wall clocks cannot be compared to sort them.
  for (const scan of [...scans].reverse()) {
    if (!isRecord(scan)) throw new SchemaError(PROVIDER, 'China Post returned an invalid scan');
    const code = cleanScalar(scan.operationCode, 16);
    const state = clean(scan.stateDesc, 40);
    const description = chinaPostDescription(scan.operation, state);
    if (!description) throw new SchemaError(PROVIDER, 'China Post returned a scan without a readable status');
    const local = atDestination(scan, destination);
    const location = placeOfScan(scan, local ? country : undefined);
    const status = chinaPostStatus(code, state);
    // The destination post's own scan keeps its wall clock alone, for its place to date.
    const time = scanTime(scan.time);
    const clock = local && DESTINATION_CLOCK.has(code) ? { local_time: time } : chinaClock(time);
    // The label shows in English where one is known; the code and state label stage it.
    const event: CarrierEvent = { ...clock, description: chinaPostEnglish(description) ?? description, ...(location ? { location } : {}),
      ...(code ? { provider_code: code } : {}), ...(status ? { stage: status.stage, stage_source: 'carrier_map' } : {}) };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push({ event, code, status, atDestination: local });
  }

  const events = kept.map(({ event }) => event);
  const latest = events[0]!;
  const establishing = currentScan(kept);
  const current = establishing.status ?? chinaPostStateStatus(clean(mail.stateDesc, 40));
  // Guests receive only the newest scans and the count covers the whole
  // history. Without a usable count, a full guest window may hide older scans.
  const count = scanCount(mail.mailInfoCount);
  const hidden = count === undefined ? scans.length >= GUEST_SCANS : count > scans.length;
  const acceptance = count !== undefined && count > scans.length ? acceptanceScan(mail.collector, events.at(-1)!) : undefined;
  const newest = events.slice(0, acceptance ? MAX_EVENTS - 1 : MAX_EVENTS);
  const truncated = hidden || newest.length < events.length;
  return {
    status: current?.status ?? 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: establishing.event.description,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time,
    ...(destination ? { destination_country: destination } : country ? { destination_country_name: country } : {}),
    ...(truncated ? { history_truncated: true } : {}),
    events: acceptance ? [...newest, acceptance] : newest,
  };
}
