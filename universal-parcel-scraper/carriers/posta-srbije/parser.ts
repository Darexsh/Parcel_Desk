import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, isoTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postaSrbijeStage } from './status.js';

export const PROVIDER = 'Pošta Srbije';
// A long history is a few kilobytes.
export const POSTA_SRBIJE_MAX_BYTES = 512_000;

const ZONE = 'Europe/Belgrade';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const CODE = /^[A-Z0-9]{1,8}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// A Serbian office: its five-digit number, which is its postcode, then its name.
const OFFICE = /^\d{5}\s+(\S.*)$/;
// A foreign post's office: its country, a dash and the office's code or postcode.
const FOREIGN = /^([A-Z]{2})-/;
// A Serbian office of exchange by its UPU code.
const EXCHANGE = /^RS[A-Z0-9]{4}$/;
// The service's answer to a number it holds no item for, in English and in Serbian.
const NOT_FOUND = new Set([
  'Postal item not found. Please check the accuracy of the number you entered.',
  'Pošiljka nije pronađena. Proverite ispravnost unetog broja.',
]);
// The service's result codes: 0 is an answer, 1 a notice, 3 a refused credential.
const ANSWERED = 0;
const NOTICE = 1;
const REFUSED = 3;
const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });

/** Pošta Srbije tracks UPU S10 items: its own, ending RS, Post Express's among them. */
export function normalizePostaSrbijeNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Pošta Srbije tracks S10 item codes');
}

/** A JSON document the service sends as text inside its answer. */
function embedded(value: unknown, what: string): unknown {
  if (typeof value !== 'string' || value.length > POSTA_SRBIJE_MAX_BYTES) {
    throw new SchemaError(PROVIDER, `Pošta Srbije returned no ${what}`);
  }
  try { return JSON.parse(value); }
  catch (cause) { throw new SchemaError(PROVIDER, `Pošta Srbije returned invalid ${what}`, { cause }); }
}

interface Place { readonly location: string; readonly zone: string | null }

/**
 * Where an event happened. A Serbian office keeps its name without its
 * number, which is its postcode. A foreign post's event names only its
 * country: its office code can be the postcode of the delivery office.
 */
function placeOf(value: unknown): Place {
  const place = clean(value, 120);
  const office = OFFICE.exec(place);
  if (office) return { location: office[1]!, zone: ZONE };
  const foreign = FOREIGN.exec(place) ?? (EXCHANGE.test(place) ? ['', 'RS'] : null);
  if (foreign) {
    const code = countryCode(foreign[1]);
    if (!code) return { location: '', zone: null };
    return { location: ENGLISH_REGIONS.of(code) ?? code, zone: code === 'RS' ? ZONE : countryTimeZone(code) };
  }
  // Any other place keeps its name, without a postcode, and its wall clock.
  return { location: place.replace(/\b\d{5}\b/g, '').replace(/\s+/g, ' ').trim(), zone: null };
}

/**
 * When an event happened: a wall clock without an offset. A Serbian office's
 * is on Belgrade's clock. A foreign post's event comes on its own country's
 * wall clock, as deliveries in the United States at morning hours show, so it
 * is dated on that country's clock when the country keeps one and otherwise
 * stays a local time.
 */
function clockOf(value: unknown, zone: string | null): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const match = CLOCK.exec(clean(value, 40));
  const wall = match?.[1];
  if (!wall || !DateTime.fromISO(wall, { zone: 'UTC' }).isValid) {
    throw new SchemaError(PROVIDER, 'Pošta Srbije returned an event without a valid time');
  }
  const placed = zone ? isoTime(wall, zone) : null;
  return placed ? { time: placed.iso } : { local_time: wall };
}

/** A scan's code: the service's normalized code, else its own; a scan can carry several. */
function codeOf(row: Record<string, unknown>): string {
  const raw = cleanScalar(row.ApiStatusSifra, 40) || cleanScalar(row.StatusSifra, 40);
  const parts = raw.toUpperCase().split(';').map(part => part.trim()).filter(Boolean);
  if (!parts.length || !parts.every(part => CODE.test(part))) {
    throw new SchemaError(PROVIDER, 'Pošta Srbije returned an event without a status code');
  }
  return parts.join(';');
}

interface Scan { readonly event: CarrierEvent; readonly returned: boolean; readonly weight: number | null }

function scanOf(row: unknown, number: string): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Pošta Srbije returned an invalid event');
  if (typeof row.PrijemniBroj !== 'string' || normalizeTrackingNumber(row.PrijemniBroj) !== number) {
    throw new SchemaError(PROVIDER, 'Pošta Srbije answered for a different item');
  }
  const code = codeOf(row);
  const place = placeOf(row.Mesto);
  const event: CarrierEvent = { ...clockOf(row.DatumKretanja, place.zone), description: clean(row.Status, 200) || code,
    provider_code: code, ...(place.location ? { location: place.location } : {}) };
  const weight = typeof row.Masa === 'number' && Number.isInteger(row.Masa) && row.Masa > 0 && row.Masa < 100_000 ? row.Masa : null;
  return { event, returned: clean(row.Retur, 4).toUpperCase() === 'D', weight };
}

/** The history of an item the service answered for: its events, newest first. */
function historyOf(value: unknown, number: string): CarrierResult {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Pošta Srbije returned an invalid item');
  const rows = value.Kretanja ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pošta Srbije returned an invalid item history');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const scan = scanOf(row, number);
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'Pošta Srbije returned the item without events', { reason: 'no_history' });

  for (const { event, returned } of scans) {
    const classified = postaSrbijeStage(event.provider_code!, event.description!);
    if (!classified) continue;
    // A delivery the service marks as a return reaches the sender.
    const stage: Stage = classified.stage === 'delivered' && returned ? 'returned' : classified.stage;
    Object.assign(event, { stage, stage_source: classified.source });
  }

  const newest = scans[0]!.event;
  const stage = newest.stage as Stage | undefined;
  // The counter weighs the item at acceptance, the oldest event.
  const weight = [...scans].reverse().find(scan => scan.weight !== null)?.weight;
  const events = scans.map(scan => scan.event);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time! }),
    expected_delivery: null,
    ...(stage === 'delivered' && newest.time ? { delivered_at: newest.time } : {}),
    ...(weight ? { weight_kg: weight / 1000 } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The tracking service's answer for one number. It wraps the result in an
 * envelope with a result code; the history and any notice come as JSON text.
 * Each event names the item's number, so the answer is bound to it.
 */
export function parsePostaSrbije(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePostaSrbijeNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.Rezultat !== 'number' || !Number.isInteger(payload.Rezultat)) {
    throw new SchemaError(PROVIDER, 'Pošta Srbije did not return a tracking result');
  }
  if (payload.Rezultat === ANSWERED) return historyOf(embedded(payload.StrOut, 'item history'), number);

  const result = embedded(payload.StrRezultat, 'notice');
  const notice = isRecord(result) ? clean(result.PorukaKorisnik, 300) || clean(result.Poruka, 300) : '';
  if (payload.Rezultat === NOTICE && NOT_FOUND.has(notice)) throw new NotFoundError(PROVIDER);
  if (payload.Rezultat === REFUSED) throw new ChallengeError(PROVIDER, 'Pošta Srbije refused the app credential');
  throw new IndeterminateError(PROVIDER, 'Pošta Srbije returned a notice instead of the item history');
}
