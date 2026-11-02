import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { easyMailStage } from './status.js';

export const PROVIDER = 'Easy Mail';
// A page is under 10 kB.
export const EASY_MAIL_MAX_BYTES = 500_000;
// Every store is in Greece.
const ZONE = 'Europe/Athens';
// An eleven-digit voucher, or the twelve digits the tracker prints with a leading zero.
const VOUCHER = /^0?(\d{11})$/;
const CLOCK = /^\d{1,2}\/\d{1,2}\/\d{4} (?:[1-9]|1[0-2]):[0-5]\d:[0-5]\d [AP]M$/;
const DETAILS = 'Αναλυτικά Στοιχεία Αποστολής';
const SUMMARY = 'Τρέχουσα Κατάσταση Αποστολής';
// The notice for a voucher the tracker does not know.
const ABSENT = /^Δεν βρέθηκε η Αποστολή(?:[.\s]|$)/u;
// A firewall's or bot check's page in place of the tracker. Every page of the
// tracker loads Google's reCAPTCHA for its search form, so that alone is no block.
const BLOCKED = /lsrecap|imunify360|webshield|<title>\s*(?:Access denied|Captcha|Just a moment)/i;
// A store named after a partner courier, which names no place.
const PARTNER_STORE = /^SPEEDEX$/i;
const PHONE = /(?<!\d)(?:\+?30)?[26]\d{9}(?!\d)/g;
const EMAIL = /\S+@\S+\.\S+/g;
const MAX_ROWS = 300;

/** An Easy Mail voucher, eleven digits, read from either form; anything else is not one it issues. */
export function normalizeEasyMailNumber(raw: string): string {
  const voucher = VOUCHER.exec(raw.length <= 64 ? normalizeTrackingNumber(raw) : '')?.[1];
  if (!voucher) throw new InvalidInputError(PROVIDER, 'Easy Mail vouchers are eleven digits, or twelve with a leading zero');
  return voucher;
}

/** Whether a page is a firewall's or bot check's instead of the tracker's. */
export function isEasyMailBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/** A scan's clock: the store's wall clock to the second, as "07/03/2026  2:36:00 PM", in Greece. */
function clockOf(text: string): { iso: string; timestamp: number } {
  const parsed = CLOCK.test(text) ? zonedTime(text, 'd/M/yyyy h:mm:ss a', ZONE, { locale: 'en-US' }) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Easy Mail returned an invalid scan time');
  return parsed;
}

/** The voucher a row names, which must be the one asked. */
function bindRow(text: string, voucher: string): void {
  const printed = VOUCHER.exec(text)?.[1];
  if (!printed) throw new SchemaError(PROVIDER, 'Easy Mail returned a row without its voucher');
  if (printed !== voucher) throw new IndeterminateError(PROVIDER, 'Easy Mail answered for another shipment');
}

/** The table under one of the page's headings, if there is one. */
function tableUnder($: CheerioAPI, heading: string): Cheerio<AnyNode> | null {
  const headings = $('h2').filter((_, element) => clean($(element).text(), 80) === heading);
  if (headings.length > 1) throw new SchemaError(PROVIDER, 'Easy Mail returned a page with repeated tables');
  return headings.length ? headings.nextAll('table').first() : null;
}

interface Scan {
  readonly index: number;
  readonly timestamp: number;
  readonly event: CarrierEvent;
}

/**
 * The scans of the detailed table: the voucher, the partner's voucher, the
 * clock, the wording and the store. The store's phone and address in its
 * tooltip and the partner's voucher are not read.
 */
function scansOf($: CheerioAPI, rows: Cheerio<AnyNode>, voucher: string): Scan[] {
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Easy Mail returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const [index, row] of rows.toArray().entries()) {
    const cells = $(row).children('th, td');
    if (cells.length !== 5) throw new SchemaError(PROVIDER, 'Easy Mail returned a scan without its fields');
    const text = (column: number) => clean(cells.eq(column).text(), 300);
    bindRow(text(0), voucher);
    const { iso, timestamp } = clockOf(text(2));
    const description = clean(text(3).replace(EMAIL, '').replace(PHONE, ''), 300).replace(/[\s,:;]+$/, '');
    if (!description) throw new SchemaError(PROVIDER, 'Easy Mail returned a scan without wording');
    const store = text(4);
    const location = /\p{L}/u.test(store) && !PARTNER_STORE.test(store) ? store.slice(0, 120) : '';
    const identity = JSON.stringify([iso, description, location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const stage = easyMailStage(description);
    scans.push({ index, timestamp, event: {
      time: iso,
      ...(location ? { location } : {}),
      description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } });
  }
  // Newest first, as the page lists them; scans of one second keep the page's order.
  return scans.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
}

/**
 * Easy Mail's tracker page for one voucher, rendered on the server: the
 * current status over a table of every scan, newest first, each row naming
 * the voucher in its twelve-digit form. A voucher the tracker does not know
 * gets its "not found" notice, which does not name the voucher.
 */
export function parseEasyMail(html: string, raw: string): CarrierResult {
  const voucher = normalizeEasyMailNumber(raw);
  const $ = load(html);
  if ($('form#trackntraceform').length !== 1) {
    if (isEasyMailBlockPage(html)) throw new ChallengeError(PROVIDER, 'Easy Mail answered with a block page');
    throw new SchemaError(PROVIDER, 'Easy Mail did not return its tracking page');
  }
  const alert = $('.cus-alert');
  if (alert.length) {
    if (ABSENT.test(clean(alert.first().text(), 200))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Easy Mail did not complete the lookup');
  }
  const details = tableUnder($, DETAILS);
  if (!details?.length) throw new SchemaError(PROVIDER, 'Easy Mail returned a page without the shipment');
  // The current status repeats the newest scan; its voucher is checked too.
  for (const row of tableUnder($, SUMMARY)?.find('tbody > tr').toArray() ?? []) {
    bindRow(clean($(row).children('th').first().text(), 40), voucher);
  }
  const events = scansOf($, details.find('tbody > tr'), voucher).map((scan) => scan.event);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time! } : {}),
    events,
  };
}
