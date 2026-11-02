import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { expressOneBgPlace, expressOneBgStage } from './status.js';

export const PROVIDER = 'Express One Bulgaria';
export const CARRIER = 'express-one-bg';
// A shipment with a long history is under a hundred kilobytes.
export const EXPRESS_ONE_BG_MAX_BYTES = 512 * 1024;

// A bill of lading is eight digits; a package's barcode is twenty-four.
const BILL = /^\d{8}$/;
const NUMBER = /^(?:\d{8}|\d{24})$/;
// The form's CSRF token, which belongs to the page's session.
const TOKEN = /<input\b[^>]*\bname="form\[_token\]"[^>]*\bvalue="([A-Za-z0-9._-]{8,512})"/;
// The notice the page shows under the form when the lookup found nothing.
const NO_RESULTS = 'No results found';
// "Shipment N 10000017 - Delivered": the shipment's bill of lading and current status.
const HEADING = /^Shipment N (\d{1,30})(?: - (.*))?$/;
const DAY = /^\d{2}\.\d{2}\.\d{4}$/;
const MINUTE = /^\d{2}:\d{2}$/;
const CLOCK_FORMAT = 'dd.MM.yyyy HH:mm';
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_ROWS = 500;

/** A number for Express One Bulgaria's tracker: a bill of lading or a package's barcode. */
export function normalizeExpressOneBgNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Express One Bulgaria tracks eight-digit bills of lading and twenty-four-digit barcodes');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

/** The CSRF token of the tracking page's form, valid in the session the page opened. */
export function readExpressOneBgToken(html: string): string {
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Express One Bulgaria answered with a browser check');
  const token = TOKEN.exec(html)?.[1];
  if (!token) throw new SchemaError(PROVIDER, 'Express One Bulgaria\'s tracking page has no form token');
  return token;
}

/** A row's date and minute as one wall time. The page gives no zone. */
function wallClock(day: string, minute: string): string {
  const text = `${day} ${minute}`;
  const parsed = DAY.test(day) && MINUTE.test(minute) ? DateTime.fromFormat(text, CLOCK_FORMAT, { zone: 'UTC' }) : null;
  // UTC only checks the calendar fields; no offset is assigned. Only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.year < 2000 || parsed.toFormat(CLOCK_FORMAT) !== text) {
    throw new SchemaError(PROVIDER, 'Express One Bulgaria returned an invalid status time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * The shipment Express One Bulgaria's tracker shows for a number posted to its
 * form: a heading that names the shipment's bill of lading and its current
 * status, then its statuses, newest first, each with a date, a day of the
 * week, a time and the status with the office and town it happened in.
 *
 * A bill of lading must be the one the heading names. A barcode is not shown:
 * the reply must hold one shipment, whose bill of lading becomes the canonical
 * number.
 */
export function parseExpressOneBg(html: string, raw: string): CarrierResult {
  const number = normalizeExpressOneBgNumber(raw);
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Express One Bulgaria answered with a browser check');
  const $ = load(html);
  if ($('[data-controller="bol-tracking-page"]').length !== 1) throw new SchemaError(PROVIDER, 'Express One Bulgaria returned an unexpected page');
  const shipments = $('div.accordion-container');
  if (!shipments.length) {
    if ($('p.text-default').filter((_, element) => clean($(element).text(), 80) === NO_RESULTS).length === 1) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Express One Bulgaria returned an unexpected page');
  }
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'Express One Bulgaria answered with several shipments');

  const shipment = shipments.first();
  const heading = HEADING.exec(clean(shipment.find('.accordion-header span').first().text(), 200));
  if (!heading) throw new SchemaError(PROVIDER, 'Express One Bulgaria returned an unexpected page');
  const bill = heading[1]!;
  // A barcode lookup answers with the bill of lading of the shipment it belongs to.
  if (bill !== number && !(number.length === 24 && BILL.test(bill))) {
    throw new IndeterminateError(PROVIDER, 'Express One Bulgaria answered for another shipment');
  }

  const rows = shipment.find('table.flexible-table > tbody > tr').not('.row-separator');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Express One Bulgaria returned an oversized history');
  const seen = new Set<string>();
  const statuses: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.each((index, element) => {
    const cells = $(element).children('td');
    const titles = cells.map((_, cell) => clean($(cell).children('span.mobile-title').text(), 40)).get();
    if (cells.length !== 5 || titles.join('|') !== '|Date|Day of the week|Time|Status') {
      throw new SchemaError(PROVIDER, 'Express One Bulgaria returned an invalid status');
    }
    const field = (cell: number) => clean(cells.eq(cell).children('p').text(), 300);
    const local = wallClock(field(1), field(3));
    const text = field(4);
    if (!text) throw new SchemaError(PROVIDER, 'Express One Bulgaria returned a status without wording');
    // A row the page lists twice is kept once.
    const identity = JSON.stringify([local, text]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const { wording, office, town } = expressOneBgPlace(text);
    const location = [office, town].filter(Boolean).join(', ');
    const staged = expressOneBgStage(wording);
    statuses.push({ local, index, event: {
      local_time: local,
      description: wording,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // Newest first; of equal clocks, the row higher up the page is the newer.
  statuses.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  const events = statuses.map(({ event }) => event);

  const newest = events[0]!;
  const latest = events.find((event) => event.stage);
  const stage = latest?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(bill !== number ? { canonical_tracking_number: bill } : {}),
    events,
  };
}
