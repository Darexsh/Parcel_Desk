import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { evdemoStage } from './status.js';

export const PROVIDER = 'Evdemo Lojistik';
export const CARRIER = 'evdemo-lojistik';
// A page with a long history and several packages is under thirty kilobytes.
export const EVDEMO_MAX_BYTES = 512 * 1024;

const NUMBER = /^\d{12}$/;
const HEADINGS = ['TARİH', 'DURUM'];
// "18.10.2026 - 00:19", once the page's run of spaces before the dash is folded.
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) - (\d{2}):(\d{2})$/;
const NUMBER_LABEL = /^Gönderi Takip Numarası:/;
// The tracker's notice for a number it does not know, which it also shows without one.
const NOT_FOUND = /^Takip numarası hatalı olabilir, lütfen bilgileri kontrol ediniz\.?$/;
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_ROWS = 500;

/** A number for Evdemo Lojistik's tracker; anything else is not one it issues. */
export function normalizeEvdemoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Evdemo Lojistik numbers are twelve digits');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

/** A scan's date and minute as one wall time. The page gives no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = match ? DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]) }, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed?.isValid || parsed.year < 2000 || parsed.toFormat('dd.MM.yyyy - HH:mm') !== text) {
    throw new SchemaError(PROVIDER, 'Evdemo Lojistik returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * The page Evdemo Lojistik's tracker shows at `/takip?kargo_kodu={number}`:
 * the shipment's number under "Gönderi Takip Numarası", its details, then a
 * table of the shipment's scans, newest first, each a clock and a wording.
 * Each package's newest scan follows in its own table. A number the tracker
 * does not know gets the search form with a notice that it may be wrong.
 *
 * The page must name the whole number asked. The sender's and recipient's
 * masked names, the departure and arrival provinces, the departure date and
 * the packages, named after their contents, are not read.
 */
export function parseEvdemo(html: string, raw: string): CarrierResult {
  const number = normalizeEvdemoNumber(raw);
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Evdemo Lojistik answered with a browser check');
  const $ = load(html);
  const headers = $('.kargo-header');
  if (!headers.length) {
    // The notice alone, under the tracker's own form, is the answer for an unknown number.
    const notices = $('.kargo-sonuc');
    const form = $('form#form-form input[name="kargo_kodu"]');
    if (form.length === 1 && notices.length === 1 && NOT_FOUND.test(clean(notices.text(), 200))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Evdemo Lojistik returned an unexpected page');
  }
  const labels = headers.children('div').filter((_, element) => NUMBER_LABEL.test(clean($(element).text(), 200)));
  const printed = headers.length === 1 && labels.length === 1 ? clean(labels.children('span').first().text(), 64) : '';
  if (!/^\d{1,40}$/.test(printed)) throw new SchemaError(PROVIDER, 'Evdemo Lojistik did not name the shipment');
  if (printed !== number) throw new IndeterminateError(PROVIDER, 'Evdemo Lojistik answered for another shipment');

  // The shipment's table; each package's sits further down, in its own block.
  const tables = $('.tracking-info-detail').children('table');
  const headings = tables.children('thead').find('th').map((_, element) => clean($(element).text(), 40)).get();
  if (tables.length !== 1 || headings.join('|') !== HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'Evdemo Lojistik history layout changed');
  const rows = tables.children('tbody').children('tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Evdemo Lojistik returned an oversized history');

  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.each((index, element) => {
    const cells = $(element).children('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'Evdemo Lojistik returned an invalid scan');
    const local = wallClock(clean(cells.eq(0).text(), 60));
    const description = clean(cells.eq(1).text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Evdemo Lojistik returned a scan without wording');
    // A row the page lists twice is kept once.
    const identity = JSON.stringify([local, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = evdemoStage(description);
    scans.push({ local, index, event: {
      local_time: local,
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; equal clocks keep the page's order.
  scans.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  const events = scans.map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
