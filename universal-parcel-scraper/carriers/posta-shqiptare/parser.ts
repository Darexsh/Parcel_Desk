import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postaShqiptareStage } from './status.js';

export const PROVIDER = 'Posta Shqiptare';
// A long history is a few kilobytes.
export const POSTA_SHQIPTARE_MAX_BYTES = 256 * 1024;
const ZONE = 'Europe/Tirane';
const MAX_ROWS = 500;
// The tracker's wall clock, with no offset.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// The notices the tracker's page shows for a code it does not have.
const MISSING = new Set(['Pakoja nuk ekziston', 'package_not_found']);
// Between a scan's Albanian wording and the IPS event name in English that
// Posta Shqiptare's own scans add: "Pranim objekti nga klienti / Receive item from customer".
const HALVES = /^(.*?)\s*\/(?:\s+(.*))?$/;
// A delivery's wording, which could go on to name who took the item.
const DELIVERY = /^(?:dorëzuar|dorezuar|objekti u dorëzua|objekti u dorezua)(?=$|[\s,;:.\-–])/i;
// A run of four digits or more, as a postcode is written, names the delivery area.
const POSTCODE = /\d{4,}/;
const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
const ALBANIAN_REGIONS = new Intl.DisplayNames(['sq'], { type: 'region' });
/** A name compared without case, accents or spacing differences. */
const nameKey = (name: string) => name.normalize('NFD').replace(/\p{Mn}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
// The country names the tracker writes for a foreign post's scans, in Albanian ("Gjermani").
const ALBANIAN_COUNTRIES: ReadonlyMap<string, string> = new Map(
  Array.from({ length: 26 * 26 }, (_, index) => String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)))
    .filter(code => countryCode(code) === code)
    .map(code => [nameKey(ALBANIAN_REGIONS.of(code) ?? code), code] as const),
);

/** Posta Shqiptare's tracker follows S10 item codes: its own, ending AL, and those other posts send to Albania. */
export function normalizePostaShqiptareNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Posta Shqiptare tracks S10 item codes');
}

/** A text field the reply may leave out or null; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Posta Shqiptare returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * The scan's wording as the page shows it, without an empty English half. A
 * delivery keeps only its own words, as anything after them could name who
 * took the item. `own` is true for Posta Shqiptare's own scans, the ones that
 * add the IPS event name in English.
 */
function wordingOf(raw: string): { description: string; own: boolean } {
  const halves = HALVES.exec(raw);
  const albanian = halves ? halves[1]! : raw;
  const english = halves?.[2] ?? '';
  const delivery = DELIVERY.exec(albanian);
  const own = delivery ? delivery[0] : albanian;
  return { description: english ? `${own} / ${english}` : own, own: Boolean(english) };
}

/** The scan's place: a foreign post's country by its English name, else the office as the tracker names it. */
function placeOf(office: string): string {
  const code = ALBANIAN_COUNTRIES.get(nameKey(office)) ?? countryCode(office);
  if (code) return ENGLISH_REGIONS.of(code) ?? office;
  return POSTCODE.test(office) ? '' : office;
}

/**
 * When the scan happened. Posta Shqiptare's own scans are on Tirana's clock.
 * The scans it relays from a foreign post or a courier carry a clock hours
 * off that partner's own, so they keep their wall clock without an offset, as
 * does a wall clock the clocks skip or repeat in Albania.
 */
function clockOf(raw: string, own: boolean): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const wall = WALL_CLOCK.exec(raw)?.[1] ?? '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so the clock must read back unchanged.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!wall || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Posta Shqiptare returned an invalid scan time');
  }
  if (own && DateTime.fromISO(wall, { zone: ZONE }).getPossibleOffsets().length === 1) {
    const placed = isoTime(wall, ZONE);
    if (placed?.iso.startsWith(wall)) return { time: placed.iso };
  }
  return { local_time: wall };
}

function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Posta Shqiptare returned an invalid scan');
  const { description, own } = wordingOf(text(row, 'description', 300));
  if (!description) throw new SchemaError(PROVIDER, 'Posta Shqiptare returned a scan without wording');
  const clock = clockOf(text(row, 'date', 40), own);
  const location = placeOf(text(row, 'office', 120));
  const staged = postaShqiptareStage(description);
  return {
    ...clock,
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of the e-Posta tracker's `getTrackApi` for one item: its scans,
 * newest first, each with a wall clock, the wording and the office or the
 * foreign post's country. The reply does not repeat the number; the request's
 * address holds the whole of it. A code without scans gets an empty list,
 * which the page reports as having no events, and the page's own notices for
 * a missing item are read the same way.
 */
export function parsePostaShqiptare(payload: unknown, raw: string): CarrierResult {
  normalizePostaShqiptareNumber(raw);
  if (typeof payload === 'string' && MISSING.has(payload.trim())) throw new NotFoundError(PROVIDER);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Posta Shqiptare returned an invalid reply');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Posta Shqiptare returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of payload) {
    const event = scanOf(row);
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  const wall = (event: CarrierEvent) => (event.time ?? event.local_time) as string;
  if (wall(events[0]!).slice(0, 19) < wall(events.at(-1)!).slice(0, 19)) events.reverse();

  const latest = events[0]!;
  const scanned = events.find(event => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    events,
  };
}
