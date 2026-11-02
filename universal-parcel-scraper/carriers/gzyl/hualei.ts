/**
 * The Hualei (华磊) forwarder platform, which GZYL, Tianhui Hengyuan, JRT,
 * Meiteshun, Mayi Yinfu and BYHD each run as a tenant: a Tomcat tracker on port 8082
 * of a bare IP or the carrier's own domain, plain HTTP only. `selectTrack.htm` is the platform's documented track
 * interface, JSON encoded in GBK; `trackIndex.htm` is the tracking page the
 * carriers' sites open, in HTML. Each carrier keeps its own host and status
 * map; this module holds the requests and parsers they share.
 */
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import type { TrackingContext } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { hualeiScanText } from './text.js';

export { hualeiScanText };

/** One carrier's tenant on the platform. */
export interface HualeiTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The tracker's origin, `http://<address>:8082`. */
  readonly origin: string;
  /** The stage the carrier's map gives a row, by its kind code (null without one) and `normalizeStatusWording` wording. */
  readonly stage: (code: string | null, wording: string) => Stage | undefined;
  /**
   * The English a row the tenant words only in Chinese is shown in, by the same
   * code and wording. The stage still comes from the tenant's own wording.
   */
  readonly english?: (code: string | null, wording: string) => string | undefined;
  /** The wording and place of a row whose text carries both, before the shared cleaning. */
  readonly split?: (content: string, location: string) => { readonly content: string; readonly location: string };
  /** Rows keep their wall clocks: some rows the tracker copies from another carrier come on that carrier's clock. */
  readonly wallClocks?: true;
  /**
   * How a row's clock reads where the record settles it row by row: on the
   * platform's clock, as a wall clock, or as its day alone. It takes the place
   * of `wallClocks`.
   */
  readonly clock?: (row: HualeiRow) => 'platform' | 'wall' | 'day';
  /**
   * Whether a row's wording repeats another's, at the same clock, place and
   * kind, with more around it: the row then counts once, as the other.
   */
  readonly repeats?: (wording: string, other: string) => boolean;
  /**
   * Carriers the tenant hands records to without naming a channel: one takes a
   * record whose transfer number its own high-confidence rule claims whole.
   */
  readonly unlabelledPartners?: readonly CarrierId[];
  /**
   * Carriers a product name names, as JRT's line to Ireland names FedEx: on a
   * record of that product without a channel, the delivery carrier's number is
   * the named carrier's when it takes the number.
   */
  readonly productPartners?: readonly (readonly [RegExp, CarrierId])[];
  /**
   * The tracking page finds an order by the tenant's own number without showing
   * it, only the delivery carrier's number and the shipper's reference: a lone
   * record then answers the one number the page's form echoes back, and the
   * tracking number it shows is the delivery carrier's.
   */
  readonly pageEcho?: true;
  /**
   * The tenant's own numbers. Once the delivery carrier's number has taken
   * `trackingNumber`, the track interface still finds an order by its own
   * number but returns it in no field: a lone record that holds none of the
   * number then answers it, unless its tracking number is another of the
   * tenant's own. A tracking number of another shape is the delivery carrier's.
   */
  readonly ownNumber?: RegExp;
}

/**
 * The zone of the trackers' own clock: it decides when a row written ahead is
 * shown, and every row is read on it, abroad too.
 */
export const HUALEI_ZONE = 'Asia/Shanghai';
export const HUALEI_TRACK_PATH = '/selectTrack.htm';
export const HUALEI_PAGE_PATH = '/trackIndex.htm';
// A record is a few kilobytes, a page a few dozen.
const TRACK_MAX_BYTES = 512 * 1024;
const PAGE_MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The service matches a number or reference exactly as written, dashes included;
// a comma would ask for several.
const NUMBER = /^(?=.{6,40}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// A row's clock can be its destination's, up to six hours ahead of Beijing's: one written more
// than twelve hours before its own clock was written ahead.
const WRITTEN_AHEAD_MS = 12 * 3_600_000;
// The kind of the rows the platform's custom track product (轨迹定制) writes to a script: they
// can have a parcel abroad before it reaches the airport.
const CUSTOM_TRACK = 'CO_C_CR';
// The service's answer when it holds no row for the number: an unknown number,
// or an order whose rows the interface does not list. Only the page tells which.
const NO_TRACK = '未查询到轨迹';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks a firewall or cloud host could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|The requested URL was rejected|<title>\s*(?:滑动验证|验证码|安全验证|访问受限)/i;
// The record's own numbers: tracking number, the shipper's reference, the waybill code and the channel's transfer number.
const IDENTITY_FIELDS = ['trackingNumber', 'referenceNumber', 'business_seqinvoicecode', 'business_channeltransfercode'] as const;
// The page's columns that carry those numbers. The recipient's column is never read.
const PAGE_IDENTITY_COLUMNS = ['参考号', '跟踪号码', '渠道转单号'] as const;
const RECIPIENT_COLUMN = '收件人';

/**
 * Delivery carriers by the channel label a record names in `channel_name`, in
 * `normalizeStatusWording` form. A label the table does not hold names no
 * partner. The labels are Swiss Post's, where GZYL's, Tianhui Hengyuan's and
 * JRT's lines end.
 */
const PARTNERS: Readonly<Record<string, CarrierId>> = {
  'swiss post': 'swiss-post',
  swisspost: 'swiss-post',
  'post ch': 'swiss-post',
  瑞士邮政: 'swiss-post',
};

/**
 * The delivery carrier a record's channel label names, when the table holds the
 * label, that carrier's own detection offers the number and it serves the
 * destination.
 */
export function hualeiPartner(label: string, number: string, destination = ''): CarrierId | undefined {
  const key = normalizeStatusWording(label);
  const carrier = Object.hasOwn(PARTNERS, key) ? PARTNERS[key] : undefined;
  return carrier && takes(carrier, number, destination) ? carrier : undefined;
}

/** Whether a carrier's own detection offers the number and it serves the destination; a carrier listing no country serves all. */
function takes(carrier: CarrierId, number: string, destination: string): boolean {
  if (!/^[A-Z0-9]{4,40}$/.test(number)) return false;
  if (!(detectCarrierMatch(number).candidates as string[]).includes(carrier)) return false;
  const countries: readonly string[] = CARRIER_DEFINITIONS[carrier]?.countries ?? [];
  return !destination || !countries.length || countries.includes(destination);
}

/** A number or reference the tracker can be asked for, upper case; anything else is never sent. */
export function normalizeHualeiNumber(raw: string, provider: string): string {
  const number = raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `${provider} looks parcels up by 6 to 40 letters, digits and dashes`);
  return number;
}

/** A number as identities are compared: the tracker's own numbers can carry dashes. */
const identity = (value: string) => value.toUpperCase().replace(/[\s-]+/g, '');

/** A number's shape with none of its characters: its runs of letters, digits and other signs counted, as "A3D10A2". */
const numberShape = (value: string) => (identity(value).match(/[A-Z]+|\d+|[^A-Z\d]+/g) ?? [])
  .map((run) => `${/^[A-Z]/.test(run) ? 'A' : /^\d/.test(run) ? 'D' : 'X'}${run.length}`).join('');

/** The address of the track interface for one number. */
export function hualeiTrackUrl(tenant: HualeiTenant, raw: string): string {
  const url = new URL(HUALEI_TRACK_PATH, tenant.origin);
  url.searchParams.set('documentCode', normalizeHualeiNumber(raw, tenant.provider));
  return url.toString();
}

/** An optional text field; anything but a string is a changed reply. */
function text(record: JsonObject, key: string, provider: string, maxLength = 500): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A row's wall clock, `yyyy-MM-ddTHH:mm:ss`. */
function wallClock(value: string, provider: string): string {
  const match = CLOCK.exec(value);
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  }
  return local;
}


/**
 * One row as the reply gives it: its wall clock, text, place and kind code, and
 * the platform's clock when it was written, which only the track interface gives.
 */
export interface HualeiRow {
  readonly clock: string; readonly content: string; readonly location: string; readonly code: string; readonly written?: string;
}

/** When the platform wrote a row, on its own clock, which only the track interface says. */
function writtenAt(row: HualeiRow): string | undefined {
  const match = CLOCK.exec(row.written ?? '');
  return match ? isoTime(`${match[1]}T${match[2]}`, HUALEI_ZONE)?.iso : undefined;
}

/** Whether a row was written well before its own clock, as part of a timeline written ahead. */
function writtenAhead(row: HualeiRow, local: string): boolean {
  const match = CLOCK.exec(row.written ?? '');
  if (!match) return false;
  const written = DateTime.fromISO(`${match[1]}T${match[2]}`, { zone: 'UTC' });
  return written.isValid && written.toMillis() + WRITTEN_AHEAD_MS < DateTime.fromISO(local, { zone: 'UTC' }).toMillis();
}

function stageOf(tenant: HualeiTenant, code: string, description: string): { stage: Stage; source: string } | undefined {
  const mapped = tenant.stage(code || null, normalizeStatusWording(description));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'pending');
  return worded.source === 'none' ? undefined : { stage: worded.stage, source: worded.source };
}

/**
 * The rows as scans, newest first. Tenants write whole timelines ahead, from
 * the collection to the delivery: a row written well before its own clock is
 * a forecast, not a scan, and so are a row of the custom track product and a
 * row dated after the lookup on the trackers' clock. Identical rows count
 * once, and so do rows the tenant says repeat another. A row the tenant has
 * English for is staged and deduplicated by its own wording, then shown in
 * English. `ahead` lists the clocks of the rows written ahead and of the
 * custom track's, as the tenant reads them.
 */
function scans(rows: readonly HualeiRow[], tenant: HualeiTenant, readAt: number): { events: CarrierEvent[]; truncated: boolean; ahead: string[] } {
  const seen = new Set<string>();
  const ahead = new Set<string>();
  const kept: { clock: string; index: number; event: CarrierEvent; english?: string }[] = [];
  rows.forEach((row, index) => {
    const local = wallClock(row.clock, tenant.provider);
    const placed = isoTime(local, HUALEI_ZONE)!;
    const reading = tenant.clock?.(row) ?? (tenant.wallClocks ? 'wall' : 'platform');
    if (row.code === CUSTOM_TRACK || writtenAhead(row, local)) {
      ahead.add(reading === 'platform' ? placed.iso : local);
      return;
    }
    if (placed.timestamp > readAt) return;
    const parts = tenant.split?.(row.content, row.location) ?? row;
    const place = hualeiScanText(parts.location, 200);
    const wording = hualeiScanText(parts.content);
    const description = wording || place;
    if (!description) return;
    const location = wording ? place : '';
    const key = JSON.stringify([local, description, location, row.code]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = stageOf(tenant, row.code, description);
    const english = wording ? tenant.english?.(row.code || null, normalizeStatusWording(wording)) : undefined;
    const written = writtenAt(row);
    kept.push({ clock: local, index, ...(english ? { english } : {}), event: {
      ...(reading === 'platform' ? { time: placed.iso } : { local_time: reading === 'day' ? local.slice(0, 10) : local }), description,
      ...(location ? { location } : {}),
      ...(row.code ? { provider_code: row.code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      // Kept with the scan, so that stored rows show which clock a row abroad is on.
      ...(written ? { written_at: written } : {}),
    } });
  });
  const { repeats } = tenant;
  const unrepeated = repeats ? kept.filter((entry) => !kept.some((other) => other !== entry && other.clock === entry.clock
    && other.event.location === entry.event.location && other.event.provider_code === entry.event.provider_code
    && repeats(entry.event.description!, other.event.description!))) : kept;
  // The platform can write a partner's row again, and a copy written after a European clock change
  // reads the partner's clock an hour off: meso-global's DHL rows written in October summer time at
  // 17:09 came again, written after the change, at 18:09. The copy written later goes.
  const unique = unrepeated.filter((entry) => !unrepeated.some((other) => other !== entry
    && other.event.description === entry.event.description && other.event.location === entry.event.location
    && other.event.provider_code === entry.event.provider_code && hourApart(other.clock, entry.clock)
    && Date.parse(other.event.written_at ?? '') < Date.parse(entry.event.written_at ?? '')));
  // Rows come newest first; rows on one clock keep the reply's order.
  unique.sort((a, b) => (a.clock === b.clock ? a.index - b.index : a.clock < b.clock ? 1 : -1));
  const leg = returnLeg(unique.map(({ event }) => event));
  const events = unique.map(({ event, english }, index) => ({ ...event, ...(english ? { description: english } : {}),
    ...(leg[index] ? { stage: 'returned' } : {}) }));
  return { events: events.slice(0, MAX_EVENTS), truncated: events.length > MAX_EVENTS, ahead: [...ahead] };
}

/** Two wall clocks exactly an hour apart. */
const hourApart = (left: string, right: string): boolean => Math.abs(Date.parse(`${left}Z`) - Date.parse(`${right}Z`)) === 3_600_000;

const RETURN_LEG: ReadonlySet<string> = new Set(['in_transit', 'out_for_delivery', 'delivered']);

/**
 * Which scans, newest first, are on the way back: after a row the tenant's map
 * reads as returned, a move or a delivery is the parcel going, or delivered,
 * back to the sender. A return only the shared wording rules read starts none.
 */
function returnLeg(events: readonly CarrierEvent[]): boolean[] {
  const leg = events.map(() => false);
  let back = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const { stage, stage_source: source } = events[index]!;
    if (back && stage && RETURN_LEG.has(stage)) leg[index] = true;
    else if (stage === 'returned' && source === 'carrier_map') back = true;
  }
  return leg;
}

interface Facts {
  readonly number: string;
  readonly tracking: string;
  readonly destination: string;
  readonly service?: string;
  readonly partner?: { readonly carrier: CarrierId; readonly number: string };
  /** The delivery carrier's number, its carrier unnamed. */
  readonly downstream?: string;
}

/**
 * The result. The record's own summary status is not read: it can be ahead
 * of the rows held back.
 */
function result(rows: readonly HualeiRow[], facts: Facts, tenant: HualeiTenant, readAt: number): CarrierResult {
  const { events, truncated, ahead } = scans(rows, tenant, readAt);
  // The order exists, but nothing it holds is due yet. Rows written ahead are named, here and
  // beside the scans kept, so that a provider's copies of them are not taken for scans.
  if (!events.length) {
    throw new NoHistoryError(tenant.provider, `${tenant.provider} has no scans for the shipment yet`,
      ahead.length ? { reason: 'written_ahead', writtenAhead: ahead } : undefined);
  }
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const { partner } = facts;
  // The tracking number is the order's own unless it is the delivery carrier's.
  const canonical = facts.tracking && identity(facts.tracking) !== identity(facts.number)
    && identity(facts.tracking) !== partner?.number ? facts.tracking : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(facts.service ? { service_name: facts.service } : {}),
    ...(/^[A-Z]{2}$/.test(facts.destination) ? { destination_country: facts.destination } : {}),
    ...(canonical ? { canonical_tracking_number: canonical } : {}),
    ...(partner ? { delivery_carrier: partner.carrier } : {}),
    ...(partner && partner.number !== identity(facts.number) ? { delivery_tracking_number: partner.number }
      : facts.downstream && facts.downstream !== identity(facts.number) ? { delivery_tracking_number: facts.downstream } : {}),
    events,
    ...(truncated ? { history_truncated: true } : {}),
    ...(ahead.length ? { written_ahead: ahead } : {}),
  };
}

function trackRow(raw: unknown, provider: string): HualeiRow {
  if (!isRecord(raw)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
  return {
    clock: text(raw, 'track_date', provider, 64), content: text(raw, 'track_content', provider),
    location: text(raw, 'track_location', provider, 200), code: text(raw, 'track_kind', provider, 64),
    // A creation time it cannot read is no evidence either way.
    written: typeof raw.track_createdate === 'string' ? clean(raw.track_createdate, 64) : '',
  };
}

/**
 * The delivery carrier and its number: the channel's transfer number, else the
 * tracking number, which some lines fill with the delivery carrier's. Without
 * a channel, only the transfer number, or the tracking number a tenant's own
 * number shape marks as the delivery carrier's, of a carrier the tenant hands to
 * or the record's product names.
 */
function partnerOf(record: JsonObject, destination: string, tenant: HualeiTenant, downstream = ''): Facts['partner'] {
  const { provider } = tenant;
  const label = text(record, 'channel_name', provider, 100);
  if (!label) {
    for (const number of [identity(text(record, 'business_channeltransfercode', provider, 64)), downstream]) {
      const detected = number ? detectCarrierMatch(number) : undefined;
      const carrier = detected?.confidence === 'high' ? detected.carrier : undefined;
      if (carrier && tenant.unlabelledPartners?.includes(carrier)) return { carrier, number };
    }
    const product = downstream ? text(record, 'productKindName', provider, 100) : '';
    const named = product ? tenant.productPartners?.find(([pattern]) => pattern.test(product))?.[1] : undefined;
    return named && takes(named, downstream, destination) ? { carrier: named, number: downstream } : undefined;
  }
  for (const key of ['business_channeltransfercode', 'trackingNumber']) {
    const number = identity(text(record, key, provider, 64));
    const carrier = number ? hualeiPartner(label, number, destination) : undefined;
    if (carrier) return { carrier, number };
  }
  return undefined;
}

/**
 * The reply of `selectTrack.htm` for one number: the record whose own numbers
 * include the one asked, or null when the service says it holds no row for
 * it. Recipient, sender, signature, fee and weight fields are never read.
 */
export function parseHualeiTrack(payload: unknown, raw: string, tenant: HualeiTenant, readAt = Date.now()): CarrierResult | null {
  const { provider } = tenant;
  const number = normalizeHualeiNumber(raw, provider);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  }
  const reply = payload[0];
  if (reply.ack === 'false') {
    if (reply.message === NO_TRACK && reply.data === undefined) return null;
    throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  }
  if (reply.ack !== 'true') throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  if (!Array.isArray(reply.data) || !reply.data.length || reply.data.length > MAX_RECORDS) {
    throw new SchemaError(provider, `${provider} returned an invalid record list`);
  }
  const records = reply.data.map((record) => {
    if (!isRecord(record)) throw new SchemaError(provider, `${provider} returned an invalid record`);
    return record;
  });
  // The service matches a number in any of the record's own fields; a reference two orders share is no answer.
  const bound = records.filter((record) => IDENTITY_FIELDS.some((key) => identity(text(record, key, provider, 64)) === identity(number)));
  const own = (value: string) => Boolean(tenant.ownNumber?.test(value));
  const trackingOf = (record: JsonObject) => identity(text(record, 'trackingNumber', provider, 64));
  if (!bound.length) {
    // The names of the fields that still carry the number, a list such as a child parcel's included, or eight
    // characters or more of it, never their values, tell a number the platform moved from another shipment or wrote
    // shorter. Failing both, the shapes of the record's own numbers tell a re-issued order from a hand-off.
    const fields = (holds: (value: string) => boolean, nested = false) => [...new Set(records.flatMap((record) => Object.entries(record)
      .filter(([, value]) => typeof value === 'string' ? holds(identity(value))
        : nested && typeof value === 'object' && value !== null && holds(identity(JSON.stringify(value))))
      .map(([key]) => key.slice(0, 40))))].slice(0, 4);
    const whole = fields((value) => value.includes(identity(number)), true);
    const part = whole.length ? [] : fields((value) => value.length >= 8 && identity(number).includes(value));
    // A tenant's own number the record holds nowhere is the one the interface found it by, once the delivery
    // carrier's number has taken its tracking number.
    if (own(number) && records.length === 1 && !whole.length && !part.length && !own(trackingOf(records[0]!))) {
      bound.push(records[0]!);
    } else {
      const shapes = whole.length || part.length ? [] : [...new Set(records.flatMap((record) => IDENTITY_FIELDS
        .map((key) => [key, text(record, key, provider, 64)] as const)
        .filter(([, value]) => value)
        .map(([key, value]) => `${key} ${numberShape(value)}`)))].slice(0, 4);
      throw new IndeterminateError(provider, `${provider} answered with another shipment${whole.length ? `; its ${whole.join(', ')} holds the number`
        : part.length ? `; its ${part.join(', ')} holds part of the number` : shapes.length ? `; its numbers read ${shapes.join(', ')}` : ''}`);
    }
  }
  if (new Set(bound.map(trackingOf)).size > 1) {
    throw new IndeterminateError(provider, `${provider} holds several shipments under the number`);
  }
  const record = bound[0]!;
  const details = record.trackDetails ?? [];
  if (!Array.isArray(details) || details.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an invalid history`);
  const destination = text(record, 'consigneeCountry', provider, 8).toUpperCase();
  const tracking = trackingOf(record);
  // On a tenant that names its own numbers, a tracking number of another shape is the delivery carrier's.
  const downstream = tenant.ownNumber && tracking && !own(tracking) ? tracking : '';
  return result(details.map((row) => trackRow(row, provider)), {
    number, destination, partner: partnerOf(record, destination, tenant, downstream),
    tracking: downstream ? '' : tracking, ...(downstream ? { downstream } : {}),
    service: text(record, 'productKindName', provider, 100) || undefined,
  }, tenant, readAt);
}

interface PageWaybill {
  readonly pieces: string | null;
  readonly cells: ReadonlyMap<string, string>;
  readonly rows: readonly HualeiRow[];
}

function pageWaybill($: CheerioAPI, block: Parameters<CheerioAPI>[0], provider: string): PageWaybill {
  const heading = clean($(block).find('.danhao').first().text(), 1000);
  const pieces = /件数\s*[:：]\s*【([^】]*)】/.exec(heading)?.[1]?.trim() ?? null;
  const lists = $(block).find('.menu_ ul');
  const headers = lists.eq(0).children('li').toArray().map((item) => clean($(item).text(), 100));
  const values = lists.eq(1).children('li').toArray();
  if (lists.length !== 2 || !headers.length || headers.length !== values.length) {
    throw new SchemaError(provider, `${provider} returned an invalid waybill`);
  }
  const cells = new Map<string, string>();
  headers.forEach((header, index) => {
    if (header !== RECIPIENT_COLUMN) cells.set(header, clean($(values[index]).text(), 500));
  });
  const rows = $(block).find('.difmeam table tr').toArray().map((tr) => {
    const row = $(tr).children('td').toArray().map((td) => clean($(td).text(), 500));
    if (row.length !== 3) throw new SchemaError(provider, `${provider} returned an invalid scan`);
    return { clock: row[0]!, location: row[1]!, content: row[2]!, code: '' };
  });
  return { pieces, cells, rows };
}

/**
 * The page's answer for a number it holds nothing for: one waybill that only
 * echoes the number as a reference, without pieces, destination, clock,
 * tracking number or history.
 */
function isUnknown(waybill: PageWaybill, number: string): boolean {
  const { cells } = waybill;
  return waybill.pieces === '' && !waybill.rows.length && !cells.has('跟踪号码')
    && identity(cells.get('参考号') ?? '') === identity(number)
    && !cells.get('目的地') && !cells.get('当地时间') && !cells.get('渠道转单号');
}

/**
 * The tracking page `trackIndex.htm` for one number. It finds an order by its
 * tracking number or the shipper's reference, and shows the platform's own row
 * for an order without scans, which the track interface leaves out.
 */
export function parseHualeiPage(html: string, raw: string, tenant: HualeiTenant, readAt = Date.now()): CarrierResult {
  const { provider } = tenant;
  const number = normalizeHualeiNumber(raw, provider);
  const $ = load(html);
  const blocks = $('div.div_canta div.div_cont').toArray();
  if (!blocks.length || blocks.length > MAX_RECORDS) throw new SchemaError(provider, `${provider} returned a page without its results`);
  const waybills = blocks.map((block) => pageWaybill($, block, provider));
  if (waybills.length === 1 && isUnknown(waybills[0]!, number)) throw new NotFoundError(provider);
  const shown = (waybill: PageWaybill) => Boolean(waybill.pieces || waybill.rows.length || waybill.cells.get('目的地'));
  const bound = waybills.filter((waybill) => shown(waybill)
    && PAGE_IDENTITY_COLUMNS.some((column) => identity(waybill.cells.get(column) ?? '') === identity(number)));
  // The page shows one block per number its form echoes back, one per line: on
  // a tenant that hides the number it found an order by, a lone record answers
  // the only number echoed.
  const echo = ($('input#codes').attr('value') ?? '').split(/[\r\n]+/).map(identity).filter(Boolean);
  const echoed = tenant.pageEcho && !bound.length && waybills.length === 1 && shown(waybills[0]!)
    && echo.length === 1 && echo[0] === identity(number);
  if (echoed) bound.push(waybills[0]!);
  if (bound.length !== 1) throw new IndeterminateError(provider, `${provider} did not show the number as one shipment`);
  const waybill = bound[0]!;
  if (waybill.rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an invalid history`);
  const tracking = identity(waybill.cells.get('跟踪号码') ?? '');
  // The numbers such a tenant's page shows are the delivery carrier's, never its own.
  const downstream = tenant.pageEcho ? identity(waybill.cells.get('渠道转单号') ?? '') || tracking : '';
  return result(waybill.rows, {
    number, tracking: tenant.pageEcho ? '' : tracking, ...(downstream ? { downstream } : {}),
    destination: (waybill.cells.get('目的地') ?? '').toUpperCase(),
  }, tenant, readAt);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

/** The track interface's body: GBK unless the reply says UTF-8. */
function trackText(response: Response, bytes: Uint8Array): string {
  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]?.toLowerCase();
  return decodeText(bytes, charset === 'utf-8' || charset === 'utf8' ? 'utf-8' : 'gbk').replace(/^\uFEFF/, '');
}

/** One lookup on a tenant's tracker, sent once more after a network failure. */
export class HualeiTracker {
  constructor(private readonly tenant: HualeiTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The HTTP statuses that are not the service's answer. */
  private refuse(response: Response): void {
    const { provider } = this.tenant;
    if (response.status === 429) throw new RateLimitedError(provider, retryAfterMs(response));
    if (REDIRECTS.includes(response.status)) throw new TransportError(provider, `${provider} redirected its tracking lookup`);
    if (GONE.includes(response.status)) throw new TransportError(provider, `${provider} tracking lookup is unavailable`);
  }

  private async track(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult | null> {
    const { provider } = this.tenant;
    const { response, bytes } = await fetchBounded(hualeiTrackUrl(this.tenant, number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider, timeoutMs, maxBytes: TRACK_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    this.refuse(response);
    const body = trackText(response, bytes);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (cause) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a block page`, { cause });
      throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
    }
    return parseHualeiTrack(payload, number, this.tenant, Date.now());
  }

  private async page(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { provider } = this.tenant;
    const { response, bytes } = await fetchBounded(new URL(HUALEI_PAGE_PATH, this.tenant.origin), { method: 'POST', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ documentCode: number }) }, { provider, timeoutMs, maxBytes: PAGE_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    this.refuse(response);
    const html = decodeText(bytes);
    if (!html.includes('div_canta')) {
      if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a block page`);
      throw new SchemaError(provider, `${provider} returned a page without its results`);
    }
    return parseHualeiPage(html, number, this.tenant, Date.now());
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHualeiNumber(raw, this.tenant.provider);
    // The track interface first; its "no row" answer is settled by the page,
    // which tells an unknown number from an order without scans.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      return await this.track(number, signal, left()) ?? await this.page(number, signal, left());
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: this.tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}
