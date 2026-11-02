import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bulgarianPostsStage, isBulgarianPostsNotice } from './status.js';

export const PROVIDER = 'Bulgarian Posts';
// A long history is a few kilobytes.
export const BULGARIAN_POSTS_MAX_BYTES = 512 * 1024;

const ZONE = 'Europe/Sofia';
const MAX_ROWS = 500;
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// Thirteen letters and digits starting PS: e-packages and domestic items, as the page describes them.
const DOMESTIC = /^PS[0-9A-Z]{11}$/;
// The tracker's answer to a code it cannot read: one row on an empty date.
const WRONG_CODE = 'Грешен код на пратката';
const BULGARIA = new Set(['BULGARIA', 'БЪЛГАРИЯ']);
const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * A number for Bulgarian Posts' tracker: a UPU S10 code with a valid check
 * digit, its own or another post's, or a thirteen-character PS number.
 */
export function normalizeBulgarianPostsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number) || DOMESTIC.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Bulgarian Posts tracks S10 codes and thirteen-character PS numbers');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Bulgarian Posts returned an invalid ${key}`);
  return clean(value, maxLength);
}

interface Place {
  readonly location: string;
  readonly bulgarian: boolean;
}

/**
 * Where a scan happened. `office_name` is the country, a comma and the office:
 * "BULGARIA, SOFIA LC/AO". Domestic scans write Bulgaria in Bulgarian and put
 * the office's postcode before its name. The English reply leaves the country
 * of Bulgarian delivery offices blank (", PS 9999"), which the Bulgarian reply
 * names as Bulgaria; a blank country is Bulgaria only for such an office. The
 * office's postcode is dropped, and so is a foreign office's name with a digit,
 * which can be its postcode.
 */
function placeOf(office: string): Place {
  const comma = office.indexOf(',');
  const country = comma < 0 ? '' : office.slice(0, comma).trim();
  const facility = (comma < 0 ? office : office.slice(comma + 1)).trim();
  const bulgarian = country ? BULGARIA.has(country.toLocaleUpperCase('bg'))
    : /^PS \d{4}$/.test(facility) || /^[Ѐ-ӿ]/.test(facility);
  if (bulgarian) {
    const name = facility.replace(/(?:^|\s)(?:PS\s*)?\d{4}(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    return { location: /\p{L}/u.test(name) ? `${name}, Bulgaria` : 'Bulgaria', bulgarian };
  }
  const code = countryCode(country);
  const name = code ? ENGLISH_REGIONS.of(code) ?? country : country;
  const kept = /\p{L}/u.test(facility) && !/\d/.test(facility) ? facility : '';
  return { location: [kept, name].filter(Boolean).join(', '), bulgarian };
}

/**
 * A scan's `date_reg`, "2026-09-04T16:46:00": the scanning office's wall clock,
 * as the former tracker's "Local Date and Time" column said, with no zone. A
 * Bulgarian office's is Sofia's; a foreign post's stays local, since the
 * reply never says how its despatch rows are dated. A Sofia clock the zone
 * skips stays local too.
 */
function clockOf(raw: string, bulgarian: boolean): { time: string } | { local_time: string } {
  const wall = CLOCK.exec(raw)?.[1];
  // Parsing in UTC checks the calendar digits only; no offset is assigned.
  const parsed = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!wall || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, 'Bulgarian Posts returned an invalid scan time');
  }
  const placed = bulgarian ? isoTime(wall, ZONE) : null;
  return placed?.iso.startsWith(wall) ? { time: placed.iso } : { local_time: wall };
}

function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Bulgarian Posts returned an invalid scan');
  const name = text(row, 'event_name', 200);
  if (!name) throw new SchemaError(PROVIDER, 'Bulgarian Posts returned a scan without wording');
  // The page shows the detail beside the event, such as the item's customs status.
  const detail = text(row, 'status_name', 120);
  const place = placeOf(text(row, 'office_name', 160));
  const staged = bulgarianPostsStage(name);
  return {
    ...clockOf(text(row, 'date_reg', 40), place.bulgarian),
    ...(place.location ? { location: place.location } : {}),
    description: detail ? `${name}: ${detail}` : name,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of the tracking page's `GET /api/trace/parcel/{number}` for one
 * number. It does not name the item: the request path holds the whole number,
 * and the tracker finds nothing for a number one character short. `parcels`
 * holds the scans oldest first. An empty list is the tracker's answer for a
 * number it holds nothing for, unknown or expired. When `bulpost.is_bulpost`
 * is set the page shows the item on Bulpost's own page instead.
 */
export function parseBulgarianPosts(payload: unknown, rawNumber: string): CarrierResult {
  normalizeBulgarianPostsNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.parcels)) throw new SchemaError(PROVIDER, 'Bulgarian Posts returned an invalid reply');
  if (isRecord(payload.bulpost) && payload.bulpost.is_bulpost === true) {
    throw new IndeterminateError(PROVIDER, 'Bulgarian Posts shows this item on Bulpost’s page');
  }
  const rows = payload.parcels;
  if (!rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Bulgarian Posts returned an oversized history');
  const first: unknown = rows[0];
  if (isRecord(first) && first.event_name === WRONG_CODE && typeof first.date_reg === 'string' && first.date_reg.startsWith('0001-')) {
    if (rows.length !== 1) throw new SchemaError(PROVIDER, 'Bulgarian Posts returned scans beside its wrong-code answer');
    throw new InvalidInputError(PROVIDER, 'Bulgarian Posts says the code is wrong', { reason: 'wrong_number' });
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = scanOf(row);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Newest first, as the reply runs oldest first by wall clock; a newest-first reply stays as it is.
  const clock = (event: CarrierEvent) => String(event.time ?? event.local_time).slice(0, 19);
  if (clock(events[0]!) <= clock(events.at(-1)!)) events.reverse();
  // Oldest first: a notice keeps the stage of the scan before it.
  let previous: Stage | undefined;
  for (const event of [...events].reverse()) {
    if (isBulgarianPostsNotice(event.description!.split(': ')[0]!)) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
      continue;
    }
    previous = (event.stage as Stage | undefined) ?? previous;
  }

  const latest = events[0]!;
  const current = events.find(event => event.stage && event.stage_source !== 'none');
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    // Only a delivery at a Bulgarian office has an instant.
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    events,
  };
}
