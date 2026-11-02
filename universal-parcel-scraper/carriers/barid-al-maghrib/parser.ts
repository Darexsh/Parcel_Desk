import { load, type CheerioAPI } from 'cheerio';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { baridAlMaghribStage } from './status.js';

export const PROVIDER = 'Barid Al-Maghrib';
// The detail page is about a hundred kilobytes, most of it the site's frame.
export const BARID_AL_MAGHRIB_MAX_BYTES = 1024 * 1024;

// A firewall's or CDN's page in place of the site's.
const CHALLENGE = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|The requested URL was rejected|_cf_chl_opt|cf-turnstile|captcha/i;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^\d{2}:\d{2}(?::\d{2})?$/;
const WEIGHT = /^(\d{1,4}(?:[.,]\d{1,3})?)\s*kg$/i;
const MAX_ROWS = 500;

/**
 * Barid Al-Maghrib's tracker takes UPU S10 item codes: its own, ending MA,
 * and those of the posts that send mail to Morocco. The code needs a valid
 * check digit. The page's lookup reads several codes split by `;`, so
 * anything else never reaches it.
 */
export function normalizeBaridAlMaghribNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Barid Al-Maghrib tracks S10 item codes');
}

/** A firewall's page in place of the tracker's, which is no answer about the item. */
export function assertNotChallenged(body: string): void {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Barid Al-Maghrib answered with a firewall page');
}

/** A label without accents, case, spaces or punctuation: "POSITION D'ARRIVÉ" is "POSITIONDARRIVE". */
function label(text: string): string {
  return clean(text, 80).normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z]/g, '');
}

/** The value under one of the item's headings ("Poid du colis", "POSITION D'ARRIVÉ"), or ''. */
function fact($: CheerioAPI, body: ReturnType<CheerioAPI>, heading: string): string {
  const title = body.find('.crbt-title').filter((_, element) => label($(element).text()) === heading).first();
  return clean(title.siblings('.crbt-data').first().text(), 80);
}

function weightOf(text: string): number | undefined {
  const match = WEIGHT.exec(text);
  const kilograms = match ? Number(match[1]!.replace(',', '.')) : NaN;
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : undefined;
}

/**
 * The history table, newest first as the page lists it: a row with a day
 * (`18/05/2026`), then that day's scans, each with a clock, an office and
 * a wording. The page prints the clock on a twelve-hour dial without AM or
 * PM, so a scan keeps its day in `local_time` and the clock as printed in
 * `provider_time_text`.
 */
function eventsOf($: CheerioAPI): CarrierEvent[] {
  const table = $('#tracking-table-detail-body');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned a page without its history');
  const rows = table.children('tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned an oversized history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let day: { iso: string; text: string } | null = null;
  for (const row of rows) {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 200));
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned an invalid history row');
    const [date, clock, location, wording] = cells as [string, string, string, string];
    if (date) {
      const match = DAY.exec(date);
      const iso = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
      if (!iso || clock || location || wording) throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned an invalid scan date');
      day = { iso, text: date };
      continue;
    }
    if (!day || !wording) throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned a scan without its date or wording');
    const description = clean(wording, 200);
    const office = clean(location, 120);
    const key = [day.iso, clock, office, description].join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = baridAlMaghribStage(description);
    events.push({
      local_time: day.iso,
      ...(CLOCK.test(clock) ? { provider_time_text: `${day.text} ${clock}` } : {}),
      ...(office ? { location: office } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return events;
}

/**
 * The tracking page's detail for one item, `getdetailentrytracking?code=`,
 * which the site renders on its server: the code, the item's weight, kind,
 * cash-on-delivery amount, departure and arrival countries, a progress rail
 * and the history. Only the code, the weight, the arrival country and the
 * history are read.
 */
export function parseBaridAlMaghrib(html: string, rawNumber: string): CarrierResult {
  const number = normalizeBaridAlMaghribNumber(rawNumber);
  assertNotChallenged(html);
  const $ = load(html);
  const body = $('.detail-tracking-body');
  if (body.length !== 1) throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned a page without the item');
  const shown = clean(body.find('.title-tracking h3').text(), 64);
  if (normalizeTrackingNumber(shown) !== number) throw new SchemaError(PROVIDER, 'Barid Al-Maghrib answered for a different item');
  const events = eventsOf($);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const weight = weightOf(fact($, body, 'POIDDUCOLIS'));
  const destination = countryCode(fact($, body, 'POSITIONDARRIVE'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}

/**
 * Whether the page's lookup for several codes, `getTrackingByCode`, knows the
 * item. It lists a code it has under `tracking` and one it has not under
 * `errors`, which the page reports as "Code de tracking est introuvable".
 * Its entries also carry the recipient's name and address, which are not read.
 */
export function baridAlMaghribSummaryKnows(payload: unknown, rawNumber: string): boolean {
  const number = normalizeBaridAlMaghribNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.tracking) || !Array.isArray(payload.errors)) {
    throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned an invalid lookup reply');
  }
  const lists = (entries: unknown[]) => entries.some((entry) => {
    if (!isRecord(entry) || typeof entry.parcel !== 'string') throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned an invalid lookup entry');
    return normalizeTrackingNumber(clean(entry.parcel, 64)) === number;
  });
  if (lists(payload.tracking)) return true;
  if (lists(payload.errors)) return false;
  throw new SchemaError(PROVIDER, 'Barid Al-Maghrib answered for a different item');
}
