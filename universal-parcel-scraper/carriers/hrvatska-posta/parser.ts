import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { isValidSscc } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime, postalOfficeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { hrvatskaPostaStage } from './status.js';

export const PROVIDER = 'Hrvatska pošta';
// A page with a long history is a few dozen kilobytes.
export const HRVATSKA_POSTA_MAX_BYTES = 1_000_000;

const MAX_ROWS = 500;
const HOME_ZONE = 'Europe/Zagreb';
// The page's label for the number it answers for, in English, the language the adapter asks for.
const NUMBER_LABEL = 'Item number';
// The English page's notice for a number without data. It reads like a format
// error, but the Croatian page words the same notice "Nema podataka za uneseni
// prijamni broj pošiljke", no data for the number entered.
const NO_DATA = 'Invalid barcode format';
// The notice for a number the tracker does not accept.
const BAD_FORMAT = 'Invalid shipment number format';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile/i;
const STAMP = /^(\d{2}\.\d{2}\.\d{4}) (\d{2}:\d{2}:\d{2})$/;
// A Croatian post office or parcel locker comes with its five-digit number, which is a postcode.
const OFFICE_NUMBER = /^\d{5}\s+/;
// A facility abroad comes with its UPU office code before its name ("GBLALA LANGLEY HWDC").
const FOREIGN_OFFICE = /^([A-Z]{2}[A-Z]{3}[A-Z0-9])\s+\S/;
const WEIGHT = /^(\d{1,7}) g$/;

/**
 * The numbers the tracker's own form accepts: an S10 item code, a 3S code, a
 * twelve-digit 2-of-5 barcode, an SSCC, an MH10 code starting J and a BAT
 * code. S10 codes and SSCCs must pass their check digit.
 */
export function normalizeHrvatskaPostaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (isValidS10TrackingNumber(number) || /^3S[A-Z0-9]{1,13}$/.test(number) || /^\d{12}$/.test(number)
    || (/^00\d{18}$/.test(number) && isValidSscc(number)) || /^J[A-Z0-9]{15,34}$/.test(number)
    || /^BAT\d{1,12}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Hrvatska pošta tracks S10 item codes and the barcodes its tracking form accepts');
}

/** The scan's date and time ("30.06.2026 10:15:45") as a wall clock. They carry no offset. */
function wallClock(stamp: string): string | null {
  const match = STAMP.exec(stamp);
  if (!match) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(`${match[1]} ${match[2]}`, 'dd.MM.yyyy HH:mm:ss', { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * The clock of a foreign post's scan, relayed through the postal union: its
 * facility's, which the facility's UPU office code settles when it names a
 * country keeping one civil time, else none. Undefined for an office that is
 * not abroad.
 */
export function hrvatskaPostaForeignZone(office: string): string | null | undefined {
  const code = FOREIGN_OFFICE.exec(office)?.[1];
  return code ? postalOfficeZone(code) : undefined;
}

/** The clock of the office that scanned: Zagreb's for a numbered Croatian office or locker, else a foreign facility's. */
function officeZone(office: string): string | null {
  if (OFFICE_NUMBER.test(office)) return HOME_ZONE;
  return hrvatskaPostaForeignZone(office) ?? null;
}

/**
 * When the scan happened, on its office's clock. A scan without a place or
 * whose office's clock is not settled stays a local time, as does a wall clock
 * that is ambiguous at a change of summer time.
 */
function clockOf(wall: string, zone: string | null): { time: string } | { local_time: string } {
  if (zone && DateTime.fromISO(wall, { zone }).getPossibleOffsets().length === 1) {
    const placed = isoTime(wall, zone);
    if (placed?.iso.startsWith(wall)) return { time: placed.iso };
  }
  return { local_time: wall };
}

/** The office, locker or foreign facility, without the number of a Croatian one. */
function place(raw: string): string {
  return clean(raw, 200).replace(OFFICE_NUMBER, '');
}

function weightKg(raw: string): number | undefined {
  const grams = WEIGHT.exec(raw)?.[1];
  // An item without a measured weight shows 0 g.
  return grams && Number(grams) > 0 ? Number(grams) / 1000 : undefined;
}

/**
 * The tracker's English page for one number: its scans, grouped under the
 * page's milestones, each with its date and time, wording and, mostly, the
 * office. The page names the number it answers for; a number without data
 * comes back with a notice instead of scans.
 */
export function parseHrvatskaPosta(html: string, rawNumber: string): CarrierResult {
  const number = normalizeHrvatskaPostaNumber(rawNumber);
  const $ = load(html);
  const roots = $('div.track__n__trace');
  if (roots.length !== 1) {
    // The site's error page, which it can serve with HTTP 200 for a while for an item it knows.
    if ($('div.not__found').length) throw new IndeterminateError(PROVIDER, 'Hrvatska pošta answered with its error page');
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Hrvatska pošta answered with a block page');
    throw new SchemaError(PROVIDER, 'Hrvatska pošta did not return a tracking page');
  }
  const root = roots.first();
  const header = root.find('div.track__n__trace-header');
  const named = header.find('h5');
  const label = clean(named.first().prev('span').text(), 40);
  if (header.length !== 1 || named.length !== 1 || label !== NUMBER_LABEL) {
    throw new SchemaError(PROVIDER, 'Hrvatska pošta did not answer in English');
  }
  if (returnedTrackingNumber(named.text()) !== number) {
    throw new SchemaError(PROVIDER, 'Hrvatska pošta answered for a different number');
  }

  const groups = root.find('div.track__n__trace-events-content > div.event__status__item');
  if (!groups.length) {
    const notices = root.find('div.address__change__wrapper h4');
    const notice = notices.length === 1 ? clean(notices.text(), 200) : '';
    // Only the tracker's "no data" notice is a missing item.
    if (notice === NO_DATA) throw new NotFoundError(PROVIDER);
    if (notice === BAD_FORMAT) throw new InvalidInputError(PROVIDER, 'Hrvatska pošta does not accept the number', { reason: 'wrong_number' });
    throw new IndeterminateError(PROVIDER, 'Hrvatska pošta returned no scans for the number');
  }

  // The desktop rows; the page repeats each scan in a mobile row, which is not read.
  const rows = groups.find('div.event__status__item-content > div.row');
  if (!rows.length || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Hrvatska pošta returned an invalid item history');
  const scans: { event: CarrierEvent; wall: string; index: number }[] = [];
  const seen = new Set<string>();
  rows.each((index, node) => {
    const columns = $(node).children('div');
    if (columns.length !== 2) throw new SchemaError(PROVIDER, 'Hrvatska pošta history columns changed');
    const time = wallClock(clean(columns.eq(0).children('span').first().text(), 40));
    const spans = columns.eq(1).children('span');
    const description = clean(spans.eq(0).text(), 300);
    if (!time || !description || spans.length > 2) throw new SchemaError(PROVIDER, 'Hrvatska pošta returned a scan without a clock or wording');
    const office = spans.length === 2 ? clean(spans.eq(1).text(), 200) : '';
    const location = place(office);
    const event: CarrierEvent = { ...clockOf(time, officeZone(office)), description, ...(location ? { location } : {}) };
    // A parcel can repeat a scan with the same clock, place and wording.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, wall: time, index });
  });
  // The page groups scans by milestone, so their clocks can interleave across
  // groups. Newest first; equal clocks keep the page's order.
  scans.sort((left, right) => right.wall > left.wall ? 1 : right.wall < left.wall ? -1 : left.index - right.index);
  const events = scans.map(({ event }) => event);

  // Oldest first: an acceptance after the item moved on is a facility abroad
  // receiving it, and a delivery once it was sent back reaches its sender.
  let moved = false;
  let returning = false;
  for (const event of [...events].reverse()) {
    const classified = hrvatskaPostaStage(event.description!);
    if (!classified) continue;
    let stage: Stage = classified.stage;
    if (stage === 'accepted' && moved) stage = 'in_transit';
    if (stage === 'delivered' && returning) stage = 'returned';
    if (stage !== 'registered' && stage !== 'accepted') moved = true;
    if (stage === 'returned') returning = true;
    Object.assign(event, { stage, stage_source: classified.source });
  }

  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  // The office or locker an item waits at is its pickup point. A delivered
  // item was collected there when it waited there last before the delivery.
  const earlier = events.slice(1);
  const waiting = stage === 'ready_for_pickup' ? latest
    : stage === 'delivered' && lastMovement(earlier) === 'ready_for_pickup'
      ? earlier.find(event => event.stage === 'ready_for_pickup')
      : undefined;
  const point = waiting?.location ?? '';
  // The header's value next to its "Weight" label.
  const weights = header.find('span.Text-Style-4').filter((_, node) => clean($(node).text(), 40) === 'Weight');
  const weight = weights.length === 1 ? weightKg(clean(weights.next('span').text(), 40)) : undefined;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time! }),
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events,
  };
}
