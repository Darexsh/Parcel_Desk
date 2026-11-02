import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { orlenPaczkaStage } from './status.js';

export const PROVIDER = 'ORLEN Paczka';
export const ORLEN_PACZKA_MAX_BYTES = 1_000_000;
const ZONE = 'Europe/Warsaw';
/** The tracker's placeholder for a missing parcel number or history. */
const NO_DATA = 'Brak danych';
const MAX_SCANS = 500;
const MAX_EVENTS = 100;

/**
 * A parcel number as the tracker's own script accepts it: thirteen characters
 * starting 2 or 3. The numbers seen in use, 210 and ten digits, end in a GS1
 * check digit. The script's seven- and ten-digit sending codes are the
 * sender's drop-off codes, not parcel numbers, and are not looked up.
 */
export function normalizeOrlenPaczkaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[23][0-9A-Z]{12}$/.test(number) || (/^210\d{10}$/.test(number) && !hasGs1CheckDigit(number))) {
    throw new InvalidInputError(PROVIDER, 'ORLEN Paczka requires a thirteen-character parcel number');
  }
  return number;
}

/** The reply's JSON, inside the `callback(...)` wrapper the endpoint always adds. */
function payloadOf(body: string): unknown {
  const text = body.replace(/^\uFEFF/, '').trim();
  const json = /^callback\(([\s\S]*)\);?$/.exec(text)?.[1] ?? (text.startsWith('{') ? text : null);
  if (json === null) {
    // The site's firewall answers a request it refuses with an HTML page.
    if (/nie możesz kontynuować|suspiciously similar to automated requests|<title>\s*403 Access Forbidden/i.test(text)) {
      throw new ChallengeError(PROVIDER, 'ORLEN Paczka refused the request as automated');
    }
    throw new SchemaError(PROVIDER, 'ORLEN Paczka returned an unexpected tracking reply');
  }
  try {
    return JSON.parse(json);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'ORLEN Paczka returned invalid tracking JSON', { cause });
  }
}

/**
 * The tracker's clocks are Polish wall time, the zone of the network's points
 * and sorting centres and of the server's own clock. A wall clock the zone
 * skips or repeats stays local.
 */
function clock(raw: unknown): { time?: string; local_time?: string; provider_time_text?: string } {
  if (typeof raw !== 'string') throw new SchemaError(PROVIDER, 'ORLEN Paczka returned a scan without a date');
  const text = clean(raw, 32);
  const match = /^(\d{2})-(\d{2})-(\d{4}), (\d{2}):(\d{2})$/.exec(text);
  const local = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00` : '';
  const parsed = local ? firstOccurrence(DateTime.fromISO(local, { zone: ZONE })) : null;
  if (!parsed?.isValid || parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) !== local) {
    return text ? { provider_time_text: text } : {};
  }
  if (parsed.getPossibleOffsets().length !== 1) return { local_time: local };
  return { time: parsed.toISO({ suppressMilliseconds: true }) };
}

/** The sorting centre a scan's wording names, as in "przyjęta w sortowni Gdańsk". */
function sortingCentre(wording: string): string | undefined {
  return /\bw sortowni (\p{Lu}[\p{L}.' -]{0,60}\p{L})$/u.exec(wording)?.[1];
}

/** A history row the tracker adds when it has nothing: an error code with the placeholder wording. */
function placeholderRow(row: unknown): boolean {
  return isRecord(row) && typeof row.code === 'string' && /^ERR\d{1,6}$/.test(row.code) && clean(row.label, 40) === NO_DATA;
}

/**
 * The tracker's reply for one parcel number. A known parcel names itself in
 * `truckNo` and lists its scans oldest first; an unknown one says it has no
 * data for the number it was asked about.
 */
export function parseOrlenPaczka(body: string, rawNumber: string): CarrierResult {
  const number = normalizeOrlenPaczkaNumber(rawNumber);
  const payload = payloadOf(body);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'ORLEN Paczka returned an invalid tracking reply');
  if (Object.hasOwn(payload, 'err')) {
    // Error 1004 answers some numbers of the current range that have no
    // public history; the tracker shows them as untrackable, which proves
    // neither a parcel nor its absence.
    if (payload.err === 1004) {
      throw new IndeterminateError(PROVIDER, 'ORLEN Paczka does not show tracking for this number', { reason: 'tracking_withheld' });
    }
    throw new IndeterminateError(PROVIDER, 'ORLEN Paczka returned a tracking error');
  }
  // The official page repeats a lookup answered "logged" or "guest".
  if (payload.status === 'logged' || payload.status === 'guest') {
    throw new IndeterminateError(PROVIDER, 'ORLEN Paczka asked for the lookup again');
  }
  if (typeof payload.number !== 'string' || normalizeTrackingNumber(payload.number) !== number) {
    throw new SchemaError(PROVIDER, 'ORLEN Paczka answered for a different number');
  }
  const status = payload.status;
  const parcel = typeof payload.truckNo === 'string' ? clean(payload.truckNo, 64) : '';
  if (!Array.isArray(payload.history) || payload.history.length > MAX_SCANS) {
    throw new SchemaError(PROVIDER, 'ORLEN Paczka returned an invalid parcel history');
  }
  const rows: unknown[] = payload.history;
  if (parcel === NO_DATA && (status === '' || status === 'OK') && rows.every(placeholderRow)) throw new NotFoundError(PROVIDER);
  if (status !== 'OK') {
    throw new IndeterminateError(PROVIDER, 'ORLEN Paczka returned an inconclusive tracking reply');
  }
  if (normalizeTrackingNumber(parcel) !== number) throw new SchemaError(PROVIDER, 'ORLEN Paczka returned a different parcel');
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'ORLEN Paczka returned no parcel history', { reason: 'no_history' });

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // The reply lists scans oldest first; the result lists them newest first,
  // keeping the reply's order between scans of the same minute.
  for (const row of [...rows].reverse()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ORLEN Paczka returned an invalid scan');
    const code = typeof row.code === 'string' || typeof row.code === 'number' ? clean(String(row.code), 16) : '';
    const description = clean(row.label, 300);
    if (!/^[A-Z0-9]{1,16}$/.test(code) || !description) throw new SchemaError(PROVIDER, 'ORLEN Paczka returned a scan without code or wording');
    const stage = orlenPaczkaStage(code, description);
    const location = sortingCentre(description);
    const event: CarrierEvent = { ...clock(row.date), description, provider_code: code, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  const delivered = stage === 'delivered' && typeof latest.time === 'string' ? latest.time : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description ?? null,
    last_update: typeof latest.time === 'string' ? latest.time : null,
    ...(typeof latest.local_time === 'string' ? { last_update_local: latest.local_time } : {}),
    ...(delivered ? { delivered_at: delivered } : {}),
    // The official page shows the whole history only when `full` is true;
    // otherwise it shows the newest scan alone.
    ...(payload.full === false || events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
