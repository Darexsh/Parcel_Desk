/**
 * J&T Express Indonesia through the tracking router of its consumer app.
 *
 * One signed form request asks for one waybill. The reply binds every scan to
 * the waybill it was asked about; anything else is refused as a schema error.
 * Only the scan code, its English label, the scan clock, the scanning town and
 * a whitelisted part of the customer sentence are projected: names, phone
 * numbers, remarks, coordinates and proof-of-delivery links are not. The scan
 * network's code and name are read only to recognize the router's own system
 * network, whose scans name no place.
 */
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  CarrierError, ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError,
  UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jntCodeStatus } from './status.js';

export const JNT_ROUTER = 'https://customerapp.jntexpress.id/jandt-app-ifd-web/router.do';
const PROVIDER = 'j-and-t';
const METHOD = 'order.massOrderTrack';
/** The app release whose request this mirrors. J&T's routers answer code 490 to app versions they no longer serve. */
const APP_VERSION = 'V3.28.0';
const MAX_BYTES = 2_000_000;
// Shared request-signing secret of the J&T Indonesia app, distributed with the maintainer's approval.
export const JNT_SIGNING_SECRET = 'j&t2023app!@#';

/**
 * Prefixes J&T Indonesia issues: JD, JO, JX and JY waybills read back from the
 * router, and JP named by its help centre. Only these can be missing here.
 */
const INDONESIAN_WAYBILL = /^J[DOPXY]\d{10}$/;
/** Shapes the router is asked about: Indonesia's own, and the J&T shapes other networks share with it. */
const ACCEPTED = /^(?:J[A-Z]\d{10}|JT\d{13}|\d{12})$/;

/** A departure names the next stop's town in its scan fields, not the place the parcel leaves. */
const DEPARTURE = '50';
/**
 * The router's own network (code SISTEM01, name DP_AUTO) files automatic holds
 * under its registered town, which says nothing about where the parcel is.
 */
const SYSTEM_NETWORK_CODE = /^SISTEM/i;
const SYSTEM_NETWORK_NAME = /_AUTO$/i;
/** A town followed by one of the facility types the router names. */
const FACILITY = /^(.+) (?:Drop Point|Drop Center|Transit Center)$/;
/** Hold reasons read live. The router picks them from a fixed list; any other is not repeated. */
const HOLD_REASONS: ReadonlySet<string> = new Set([
  'Barang dilarang kirim',
  'Menunggu konfirmasi Untuk Delivery',
  'Pengirim meminta penjadwalan ulang pick up',
  'Pengiriman dihentikan/diterminasi',
  'Reschedule waktu pengiriman',
  'TLC Salah, sehingga paket salah sortir',
  'Telepon tidak diangkat atau non-aktif',
]);

export function normalizeJntNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!ACCEPTED.test(number)) throw new InvalidInputError(PROVIDER, 'J&T Indonesia needs a J&T waybill number');
  return number;
}

/** The waybill shapes J&T Indonesia issues: the only ones whose absence the router can establish. */
export function indonesianJntNumber(raw: string): string {
  const number = normalizeJntNumber(raw);
  if (!INDONESIAN_WAYBILL.test(number)) throw new InvalidInputError(PROVIDER, 'J&T Indonesia does not issue this waybill shape');
  return number;
}

export function jntSign(number: string, time: string, secret: string): string {
  return createHash('md5').update(`interface:${METHOD},time:${time},billCodes:${number},secretKey:${secret}`).digest('hex');
}

function invalid(message = 'J&T returned an invalid tracking reply'): never {
  throw new SchemaError(PROVIDER, message);
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid('J&T returned an invalid scan time');
  return value;
}

/** The scan's wall clock. UTC only validates the calendar: the router gives no zone, and Indonesia has three. */
function scanClock(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.date) || !isRecord(value.time)) invalid('J&T returned an invalid scan time');
  const { date, time } = value;
  const parsed = DateTime.fromObject({
    year: integer(date.year, 2000, 2100), month: integer(date.month, 1, 12), day: integer(date.day, 1, 31),
    hour: integer(time.hour, 0, 23), minute: integer(time.minute, 0, 59), second: integer(time.second ?? 0, 0, 59),
  }, { zone: 'UTC' });
  if (!parsed.isValid) invalid('J&T returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * The customer sentence, kept only in the forms the router is known to write.
 * A facility must be the scan's own town and a facility type, as the router
 * writes it, and a hold reason one read live. The forms that end in a
 * courier's or recipient's name lose that name; any other wording gives way to
 * the scan's English label.
 */
function describe(sentence: string, label: string, town: string): string {
  const text = sentence.replace(/[,.\s]+$/, '');
  const facility = (value: string) => Boolean(town) && FACILITY.exec(value)?.[1] === town;
  const processed = /^Package has been processed at (.+?) by\b/.exec(text);
  if (processed) return facility(processed[1]!) ? `Package has been processed at ${processed[1]}` : label;
  const moved = /^Package (?:will be departed to|has been arrived at) (.+)$/.exec(text);
  if (moved) return facility(moved[1]!) ? text : label;
  if (/^Package will be delivered to\b/.test(text)) return 'Package will be delivered';
  if (/^Package has been delivered to\b/.test(text)) return 'Package has been delivered';
  const delayed = /^Shipment process is being delayed for the reason: (.+)$/.exec(text);
  if (delayed) return HOLD_REASONS.has(delayed[1]!) ? text : 'Shipment process is being delayed';
  return label;
}

function project(row: unknown, number: string): CarrierEvent {
  if (!isRecord(row)) invalid();
  if (row.billCode !== number) invalid('J&T returned a scan of a different waybill');
  const code = typeof row.code === 'number' && Number.isInteger(row.code) && row.code >= 0 ? String(row.code)
    : typeof row.code === 'string' && /^\d{1,6}$/.test(row.code) ? row.code : invalid('J&T returned an invalid scan code');
  const label = clean(row.status, 100);
  const system = SYSTEM_NETWORK_CODE.test(clean(row.scanNetworkCode, 50)) || SYSTEM_NETWORK_NAME.test(clean(row.scanNetworkName, 100));
  // A system scan's town is the network's registered one, so neither its location nor its sentence repeats it.
  const town = system ? '' : clean(row.scanNetworkCity, 100);
  const sentence = clean(row.customerTracking, 500);
  const description = sentence ? describe(sentence, label, town) : label;
  if (!description) invalid('J&T returned an empty scan');
  const location = code === DEPARTURE || system ? ''
    : [town, clean(row.scanNetworkProvince, 100)].filter(Boolean).join(', ');
  const mapped = jntCodeStatus(code);
  return { local_time: scanClock(row.scanTime), description, ...(location ? { location } : {}), provider_code: code,
    ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) };
}

/** Read one router reply for one waybill. */
export function parseJnt(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJntNumber(raw);
  if (!isRecord(payload)) invalid();
  if (payload.code === 617) throw new ChallengeError(PROVIDER, 'J&T refused the request signature');
  // 490 asks the app to update before it can track; it says nothing about the parcel.
  if (payload.code === 490) throw new TransportError(PROVIDER, 'J&T no longer accepts this app version');
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, 'J&T could not complete the tracking request');
  if (payload.success !== true) invalid();
  // The router sends its data as a JSON document inside a string.
  let data: unknown = payload.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { invalid(); }
  }
  if (!isRecord(data) || !Array.isArray(data.bills)) invalid();
  const bills: unknown[] = data.bills;
  if (!bills.length) {
    // The router answers the same for any string it does not hold. Only an
    // Indonesian waybill can be missing here; other shapes may live elsewhere.
    if (INDONESIAN_WAYBILL.test(number)) throw new NotFoundError(PROVIDER);
    // The router still answered, so the reason tells it from an outage.
    throw new IndeterminateError(PROVIDER, 'J&T Indonesia does not hold this waybill', { reason: 'portal_not_found' });
  }
  if (bills.length !== 1) invalid('J&T returned several waybills');
  const bill: unknown = bills[0];
  if (!isRecord(bill) || bill.billCode !== number) invalid('J&T returned a different waybill');
  if (!Array.isArray(bill.details)) invalid();
  if (!bill.details.length) throw new IndeterminateError(PROVIDER, 'J&T returned the waybill without scans');

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of bill.details) {
    const event = project(row, number);
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Scans come newest first. Wall clocks from different zones cannot be
  // sorted, so the router's order stands unless it is plainly reversed.
  if (String(events[0]!.local_time) < String(events.at(-1)!.local_time)) events.reverse();
  const current = events[0]!;
  const mapped = jntCodeStatus(current.provider_code!);
  return {
    status: mapped?.status ?? 'unknown',
    ...(mapped ? { current_stage: mapped.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description, last_update: null, last_update_local: current.local_time,
    events: events.slice(0, 100),
  };
}

export async function readJnt(raw: string, options: {
  fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal; timeoutMs: number;
}): Promise<CarrierResult> {
  const number = normalizeJntNumber(raw);
  const time = String(Date.now());
  const body = new URLSearchParams({ method: METHOD, v: '1.0', format: 'json', sessionid: '',
    data: JSON.stringify({ parameter: JSON.stringify({ billCodes: number, lang: 'en' }) }) }).toString();
  try {
    const { response, bytes } = await fetchBounded(JNT_ROUTER, { method: 'POST', signal: options.signal, body, headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json;charset=utf-8', 'User-Agent': userAgentOf(options.userAgent),
      sign: jntSign(number, time, JNT_SIGNING_SECRET), time, platform: 'Android', version: APP_VERSION, lang: 'en',
    } }, { provider: PROVIDER, maxBytes: MAX_BYTES, timeoutMs: options.timeoutMs, fetcher: options.fetcher, allowHttpStatuses: [401, 403, 404, 410] });
    if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'J&T refused the tracking request');
    if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'J&T tracking router is unavailable', { status: response.status });
    const text = decodeText(bytes).trim();
    if (/^</.test(text)) throw new ChallengeError(PROVIDER, 'J&T answered with a web page instead of tracking data');
    if (!text) throw new IndeterminateError(PROVIDER, 'J&T returned an empty reply');
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { invalid(); }
    return parseJnt(payload, number);
  } catch (error) {
    options.signal.throwIfAborted();
    // Transport errors keep the request, whose headers hold the signature and
    // whose body holds the waybill. Keep the failure kind and drop the rest.
    if (error instanceof UpstreamHttpError || error instanceof UpstreamNetworkError) {
      throw new CarrierError(error.kind, PROVIDER, `J&T tracking failed (${error.kind})`, {
        status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
      });
    }
    if (error instanceof CarrierError) throw error;
    throw new TransportError(PROVIDER, 'J&T tracking request failed');
  }
}

