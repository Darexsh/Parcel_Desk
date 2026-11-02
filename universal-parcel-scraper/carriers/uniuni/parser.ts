import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { canadaProvinceTimeZone, epochSecondsTime, isoTime, settleGuessedClocks, sharedClockZone, usStateTimeZone, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { uniuniDropOffStage, uniuniPartnerStatus, uniuniStatus } from './status.js';

const PROVIDER = 'UniUni';

export function normalizeUniuniNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{8,35}$/.test(number)) throw new InvalidInputError(PROVIDER, 'UniUni requires an alphanumeric tracking reference');
  return number;
}

/** Discovery only probes formats confirmed for individual parcels. */
export function normalizeUniuniRecognitionNumber(raw: string): string {
  const number = normalizeUniuniNumber(raw);
  if (!/^(?:UUS[A-Z0-9]{16}|UUSC\d{12}|U\d{15}|UR\d{17}|4C\d{9}US|[A-Z]{2}\d{2}(?:CA|US)A0[A-Z]\d{9}|JY\d{2}CA\d{2}A\d{9})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'UniUni recognition requires a supported parcel format');
  }
  return number;
}

function clock(raw: unknown): Pick<CarrierEvent, 'time'> & { local_time?: string; provider_time_text?: string } {
  if (raw == null) return {};
  if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'UniUni returned an invalid scan clock');
  // dateTime.ts is corrected epoch seconds. pathTime encodes local wall-clock
  // digits as UTC seconds and is not an instant, despite its numeric shape.
  if (raw.ts != null) {
    if (typeof raw.ts !== 'number' || !Number.isSafeInteger(raw.ts) || raw.ts < 1_000_000_000 || raw.ts >= 10_000_000_000) {
      throw new SchemaError(PROVIDER, 'UniUni returned invalid corrected scan seconds');
    }
    const time = epochSecondsTime(raw.ts);
    if (!time) throw new SchemaError(PROVIDER, 'UniUni returned an invalid corrected scan time');
    return { time: time.iso };
  }
  if (raw.localTime != null && typeof raw.localTime !== 'string') throw new SchemaError(PROVIDER, 'UniUni returned an invalid local scan clock');
  const text = clean(raw.localTime, 64);
  if (!text) return {};
  const parsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? DateTime.fromFormat(text, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }) : null;
  // UTC validates calendar digits only. Without corrected seconds, preserve
  // the provider's clock instead of choosing an offset or borrowing a scan.
  return parsed?.isValid && parsed.toFormat('yyyy-MM-dd HH:mm:ss') === text
    ? { local_time: parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) }
    : { provider_time_text: text };
}

/**
 * A scan without corrected seconds read on the zone UniUni names for it, when
 * its province keeps that clock then. A scan with corrected seconds is always
 * on the zone named with it, but a cross-border shipper's can name another
 * country's (London for a scan in Quebec), and one with no province names no
 * place to check the zone against.
 */
function namedZoneTime(raw: unknown, province: unknown, local: string | undefined): ParsedTime | null {
  if (!local || !isRecord(raw) || typeof raw.timezone !== 'string' || raw.timezone.length > 80) return null;
  const place = usStateTimeZone(province) ?? canadaProvinceTimeZone(province);
  const zone = place ? sharedClockZone([raw.timezone, place], local) : null;
  return zone ? isoTime(local, zone) : null;
}

export function parseUniuni(payload: unknown, rawNumber: string, readAt = new Date()): CarrierResult {
  const number = normalizeUniuniNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.status !== 'string') throw new SchemaError(PROVIDER);
  if (payload.status !== 'SUCCESS') throw new IndeterminateError(PROVIDER, 'UniUni returned an inconclusive lookup response');
  if (!isRecord(payload.data) || !Array.isArray(payload.data.valid_tno) || payload.data.valid_tno.length > 25
    || !payload.data.valid_tno.every(isRecord) || typeof payload.data.invalid_tno !== 'string' || payload.data.invalid_tno.length > 1000) {
    throw new SchemaError(PROVIDER);
  }
  const valid = payload.data.valid_tno;
  const invalid = payload.data.invalid_tno.split(',').map(value => value.trim()).filter(Boolean);
  if (invalid.length === 1 && invalid[0] === number && !valid.length) throw new NotFoundError(PROVIDER);
  if (!valid.length && !invalid.length) throw new IndeterminateError(PROVIDER, 'UniUni returned no tracking result');
  if (invalid.length || valid.length !== 1 || valid[0]!.tno !== number) {
    throw new SchemaError(PROVIDER, 'UniUni did not return one unambiguous matching parcel');
  }
  const item = valid[0]!;
  if (item.is_master != null && item.is_master !== true && item.is_master !== false
    && item.is_master !== 0 && item.is_master !== 1 && item.is_master !== '0' && item.is_master !== '1') {
    throw new SchemaError(PROVIDER, 'UniUni returned an unrecognized parcel type');
  }
  // A master reference can include unfinished pieces alongside a delivered
  // one. Only an independently identified single parcel is supported here.
  if (item.is_master === true || item.is_master === 1 || item.is_master === '1' || item.master_tno
    || (item.orders_list !== undefined && (!Array.isArray(item.orders_list) || item.orders_list.length))) {
    throw new IndeterminateError(PROVIDER, 'UniUni returned a multi-piece shipment');
  }
  if (!Array.isArray(item.spath_list) || item.spath_list.length > 500) throw new SchemaError(PROVIDER);
  const events: CarrierEvent[] = [];
  const statuses: (ClassifiedStatus | undefined)[] = [];
  const guesses: (ParsedTime | null)[] = [];
  const seen = new Set<string>();
  const scans: unknown[] = item.spath_list;
  // The public client displays this oldest-first list in reverse. Keep that
  // sequence when the newest clock is incomplete, including equal-time scans.
  for (const scan of [...scans].reverse()) {
    if (!isRecord(scan)) throw new SchemaError(PROVIDER, 'UniUni returned an incomplete scan');
    // A partner courier's scans after a handover, and a Uni Store drop-off,
    // come without UniUni's English summary: their only wording is that
    // party's own scan text. A drop-off row has no status code either.
    const partner = scan.description_en === undefined && scan.code === undefined && typeof scan.pathInfo === 'string';
    const description = clean(partner ? scan.pathInfo : scan.description_en, partner ? 200 : 500);
    const state = typeof scan.state === 'number' && Number.isSafeInteger(scan.state) && scan.state >= 0 ? scan.state : undefined;
    if (!description || (state === undefined && !(partner && scan.state === undefined))) {
      throw new SchemaError(PROVIDER, 'UniUni returned a scan without status or public wording');
    }
    const mapped = state === undefined ? uniuniDropOffStage(description) : partner ? uniuniPartnerStatus(state, description) : uniuniStatus(state);
    const location = [clean(scan.city, 100), clean(scan.province, 20)].filter(Boolean).join(', ');
    // UniUni's own detailed pathInfo, addresses, coordinates, operators and POD
    // data can contain recipient or courier information; retain its English summary.
    const read = clock(scan.dateTime);
    const event: CarrierEvent = { description, ...(state === undefined ? {} : { provider_code: String(state) }), ...read,
      ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) {
      seen.add(key); events.push(event); statuses.push(mapped);
      guesses.push(namedZoneTime(scan.dateTime, scan.province, read.local_time));
    }
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, 'UniUni returned no parcel history');
  // That reading stands only in the list's order against the scans with corrected seconds, and not after the lookup.
  settleGuessedClocks(events.map((event, index) => ({
    known: event.time ? { iso: event.time, timestamp: Date.parse(event.time) } : null, guesses: [guesses[index]!],
  })), readAt.getTime()).forEach((settled, index) => {
    const event = events[index]!;
    if (event.time || !settled) return;
    event.time = settled.iso;
    delete event.local_time;
  });
  const latest = events[0]!;
  const mapped = statuses[0];
  // UniUni delivers within the United States and Canada; the parcel names which.
  const country = item.country === 'US' || item.country === 'CA' ? item.country : undefined;
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: null, ...(mapped?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(country ? { destination_country: country } : {}), events: events.slice(0, 100) };
}
