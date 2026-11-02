import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { DPD_IE_DRIVER_COLLECTION, DPD_IE_POINT_COLLECTION, DPD_IE_POINT_DROP_OFF, dpdIeScanStage, isDpdIeNotice } from './status.js';

export const PROVIDER = 'DPD Ireland';

export const DPD_IE_ZONE = 'Europe/Dublin';
// The consignment numbers DPD Ireland's tracker shows have nine digits;
// lookups archived from it also use ten.
const NUMBER = /^\d{9,10}$/;
// The fourteen-digit parcel number DPD networks print, which the tracker also finds.
const PARCEL = /^\d{14}$/;
const HEADERS = ['Status', 'Location', 'Date & Time'];
// "07/9/2026 at 1:41": day, month without its zero, year, then the hour without its zero.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) at (\d{1,2}):(\d{2})$/;
// DPD Ireland's own depots, in the Republic and in Northern Ireland, and its
// head office and website. Their clocks are Irish wall time. Another
// network's scan names its town and country, as "<town> - <country>".
const IRISH_PLACE = /^(?:Dpd [A-Za-z][A-Za-z .&'-]{0,60}|Head Office|Web)$/i;
// Labels of DPD Ireland's systems rather than places.
const NOT_PLACES = new Set(['head office', 'web']);
const VAN = 'Your parcel is on a van and due for delivery';
// The scan's text ends with the delivery window, cut to the field's length.
const VAN_WINDOW = new RegExp(`^(${VAN}), between\\b.*$`);
// The headline of a parcel on the van, with the whole window.
const VAN_HEADLINE = new RegExp(`^${VAN}\\. Expected delivery time (\\d{2}):(\\d{2}) - (\\d{2}):(\\d{2})$`);
const MAX_ROWS = 500;
const same = (left: string, right: string) => normalizeStatusWording(left) === normalizeStatusWording(right);
const MAX_EVENTS = 100;

/**
 * A DPD Ireland consignment number, nine or ten digits, or a DPD parcel
 * number, fourteen digits without the check character labels print after them.
 */
export function normalizeDpdIeNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (NUMBER.test(number)) return number;
  const parcel = dpdParcelNumber(number);
  if (!parcel) throw new InvalidInputError(PROVIDER, 'DPD Ireland tracks nine- or ten-digit consignment numbers and fourteen-digit parcel numbers');
  return parcel;
}

/** Whether a normalized number is a DPD parcel number rather than a consignment number. */
export function isDpdIeParcelNumber(number: string): boolean {
  return PARCEL.test(number);
}

/** Cloudflare's challenge page in place of the tracker. Its passive script on ordinary pages is not one. */
export function isDpdIeChallenge(html: string): boolean {
  return /<title>\s*Just a moment|_cf_chl_opt|cf-turnstile/i.test(html);
}

/**
 * The page the tracker sends an unknown consignment to. A redirect to it is
 * the tracker's only answer for a number it does not have, so its notice must
 * be the not-found one.
 */
export function parseDpdIeAbsence(html: string): never {
  const $ = load(html);
  $('script, style, noscript').remove();
  const notice = clean($('body').text(), 400);
  if (/^We couldn't locate the consignment number\.\s*It may not have reached our sorting hub yet, or it might be older than six months\.$/
    .test(notice.replace(/[’‘]/g, "'"))) {
    throw new NotFoundError(PROVIDER);
  }
  if (isDpdIeChallenge(html)) throw new ChallengeError(PROVIDER, 'DPD Ireland asked for a browser check');
  throw new IndeterminateError(PROVIDER, 'DPD Ireland returned an error page without its not-found notice');
}

interface Clock { day: string; time: string; text: string }

function clockOf(text: string): Clock | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  // UTC only checks the calendar fields. The zone is assigned per row.
  const parsed = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day), hour: Number(hour),
    minute: Number(minute) }, { zone: 'UTC' });
  if (!parsed.isValid) return null;
  return { day: parsed.toFormat('yyyy-MM-dd'), time: parsed.toFormat('HH:mm:ss'), text };
}

function irishTime(day: string, time: string): string | null {
  const parsed = firstOccurrence(DateTime.fromISO(`${day}T${time}`, { zone: DPD_IE_ZONE }));
  return parsed.isValid ? parsed.toISO({ suppressMilliseconds: true }) : null;
}

/** The delivery window the headline gives a parcel on the van, on the day of its van scan. */
function vanWindow(headline: string, van: CarrierEvent): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> | null {
  const match = VAN_HEADLINE.exec(headline);
  if (!match || !van.time) return null;
  const day = DateTime.fromISO(van.time, { setZone: true }).toFormat('yyyy-MM-dd');
  const from = irishTime(day, `${match[1]}:${match[2]}:00`);
  const to = irishTime(day, `${match[3]}:${match[4]}:00`);
  if (!from || !to || Date.parse(from) >= Date.parse(to) || Date.parse(to) < Date.parse(van.time)) return null;
  return { expected_delivery_from: from, expected_delivery: to };
}

/**
 * The tracker's result for one consignment: its scans, oldest first, and a
 * headline with the current status. A consignment of several parcels repeats
 * each scan once per parcel.
 */
export function parseDpdIe(html: string, raw: string): CarrierResult {
  const number = normalizeDpdIeNumber(raw);
  const $ = load(html);
  const root = $('div.status-container');
  if (root.length !== 1) {
    if (isDpdIeChallenge(html)) throw new ChallengeError(PROVIDER, 'DPD Ireland asked for a browser check');
    throw new IndeterminateError(PROVIDER, 'DPD Ireland did not return a consignment');
  }
  const info = root.find('.tracking-status-info p').filter((_, node) => /^Consignment\b/.test(clean($(node).text(), 80)));
  // A parcel number finds its consignment, which the page names instead.
  const consignment = clean(info.find('strong').text(), 40);
  if (info.length !== 1 || info.find('strong').length !== 1 || (isDpdIeParcelNumber(number) ? !NUMBER.test(consignment) : consignment !== number)) {
    throw new SchemaError(PROVIDER, 'DPD Ireland returned a different consignment');
  }
  const lists = root.find('ul.history-list');
  if (lists.length !== 1) throw new SchemaError(PROVIDER, 'DPD Ireland tracking history changed');
  // Wording is mapped in English, the tracker's only language.
  const headers = lists.find('li.header-list h4').map((_, node) => clean($(node).text(), 40)).get();
  if (headers.join('|') !== HEADERS.join('|')) throw new SchemaError(PROVIDER, 'DPD Ireland history columns changed');
  const rows = lists.children('li').not('.header-list');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DPD Ireland returned too many scans');

  const scans: { wording: string; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  for (const row of rows.toArray()) {
    const node = $(row);
    const cells = node.children('div');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'DPD Ireland history columns changed');
    const shown = clean(cells.eq(0).find('strong').first().text(), 200);
    const wording = shown.replace(VAN_WINDOW, '$1');
    const place = clean(cells.eq(1).text(), 120);
    const clock = clockOf(clean(cells.eq(2).text(), 40));
    if (!wording) throw new SchemaError(PROVIDER, 'DPD Ireland returned a scan without wording');
    if (!clock) throw new SchemaError(PROVIDER, 'DPD Ireland returned an invalid scan time');
    // Irish depots and systems keep Irish time. Another network's scan names
    // its own country, and no offset is established for it.
    const time = IRISH_PLACE.test(place) ? irishTime(clock.day, clock.time) : null;
    const event: CarrierEvent = {
      ...(time ? { time } : { local_time: `${clock.day}T${clock.time}`, provider_time_text: clock.text }),
      description: wording,
      ...(place && !NOT_PLACES.has(place.toLowerCase()) ? { location: place } : {}),
    };
    // Each parcel of a consignment repeats the scan.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push({ wording, event });
  }

  // Oldest first: a collection's stage depends on the scans before it, and a
  // notice keeps the stage of the scan before it.
  let previous: Stage | undefined;
  let droppedAtPoint = false;
  for (const { wording, event } of scans) {
    let stage: Stage | undefined;
    if (same(wording, DPD_IE_DRIVER_COLLECTION)) stage = previous && previous !== 'registered' ? 'in_transit' : 'accepted';
    else if (same(wording, DPD_IE_POINT_COLLECTION)) {
      if (!droppedAtPoint) {
        // Possibly the recipient's collection: no stage of its own.
        Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
        continue;
      }
      stage = 'in_transit';
    } else if (isDpdIeNotice(wording)) {
      Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
      continue;
    } else stage = dpdIeScanStage(wording);
    if (same(wording, DPD_IE_POINT_DROP_OFF)) droppedAtPoint = true;
    else if (stage && stage !== 'registered' && stage !== 'accepted') droppedAtPoint = false;
    if (!stage) continue;
    Object.assign(event, { stage, stage_source: 'carrier_map' });
    previous = stage;
  }

  const ordered = [...scans].reverse();
  const events = ordered.map(scan => scan.event);
  const decider = ordered.find(scan => scan.event.stage_source !== 'none')?.event;
  if (!decider) throw new IndeterminateError(PROVIDER, 'DPD Ireland returned no parcel scans');
  const stage = decider.stage as Stage | undefined;
  const latest = events[0]!;
  const headline = clean(root.find('.delivery-box h3').first().text(), 200);
  const window = stage === 'out_for_delivery' && same(decider.description ?? '', VAN) ? vanWindow(headline, decider) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: decider.description ?? null,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: window?.expected_delivery ?? null,
    ...(window ? { expected_delivery_from: window.expected_delivery_from } : {}),
    ...(stage === 'delivered' && decider.time ? { delivered_at: decider.time } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
