import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { palletwaysStage } from './status.js';

export const PROVIDER = 'Palletways';
// The status table is about 3 kB.
export const PALLETWAYS_MAX_BYTES = 128 * 1024;
// The tracking page's field takes eleven digits.
const NUMBER = /^\d{11}$/;
// The table's columns, in English without the session's language cookie.
const HEADINGS = ['Palletways Tracking ID', 'Currently Due', 'Consignment Number', 'Units', 'Status'];
const NOT_FOUND = 'Consignment not found';
const DUE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// The number of pallets, then the consignment's weight.
const UNITS = /^\d{1,4} @ (\d{1,6}(?:\.\d{1,3})?) ?kg$/i;
const COMPLETE = 'job complete';
// The server's refusal of a request its page script would not make, and bot checks a firewall could put in place of the table.
const BLOCKED = /Direct access not permitted|<title>\s*(?:Access Denied|Attention Required|Just a moment)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha/i;

/** A Palletways tracking ID, eleven digits; anything else is not one Palletways issues. */
export function normalizePalletwaysNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Palletways tracking IDs are eleven digits');
  return number;
}

/** The day a job is currently due, a calendar day; anything else gives none. */
function dueDay(text: string): string | null {
  const match = DUE.exec(text);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** The consignment's weight, after its number of pallets in the units cell. */
function weightOf(text: string): number | null {
  const match = UNITS.exec(text);
  const weight = match ? Number(match[1]) : 0;
  return weight > 0 ? weight : null;
}

/** The status table: one row for the tracking ID asked, bound to its whole number. */
function statusTable($: CheerioAPI, number: string): CarrierResult {
  const table = $('table');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'Palletways returned an unexpected status page');
  const headings = table.find('thead th').map((_, th) => clean($(th).text(), 60)).get();
  if (headings.join('|') !== HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'Palletways returned an unexpected status table');
  const rows = table.find('tbody > tr');
  if (!rows.length) throw new SchemaError(PROVIDER, 'Palletways returned a status table without a consignment');
  if (rows.length > 1) throw new IndeterminateError(PROVIDER, 'Palletways answered with several consignments');
  const cells = rows.first().children('td');
  if (cells.length !== HEADINGS.length) throw new SchemaError(PROVIDER, 'Palletways returned an unexpected status row');

  const first = cells.eq(0);
  const id = clean(first.contents().filter((_, node) => node.nodeType === 3).text(), 40);
  // The kind of job, as "(Delivery)" after the ID.
  const job = /^\(([^()]{1,40})\)$/.exec(clean(first.children('span').text(), 60))?.[1] ?? '';
  if (!id || !job) throw new SchemaError(PROVIDER, 'Palletways returned a consignment without its tracking ID');
  if (id !== number) throw new IndeterminateError(PROVIDER, 'Palletways answered for another consignment');
  const badge = cells.eq(4).find('.badge');
  const status = clean((badge.length ? badge : cells.eq(4)).text(), 80);
  if (!status) throw new SchemaError(PROVIDER, 'Palletways returned a consignment without its status');

  // Only delivery jobs are seen; what another kind's badge means is not known.
  const staged = job.toLowerCase() === 'delivery' ? palletwaysStage(status) : null;
  const ended = staged?.stage === 'delivered' || staged?.stage === 'returned' || status.toLowerCase() === COMPLETE;
  const weight = weightOf(clean(cells.eq(3).text(), 40));
  // The shipper's own consignment number in the third column is not kept.
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: status,
    last_update: null,
    // A completed job can still carry a due day months later, so the day counts only while the job is open.
    expected_delivery: ended ? null : dueDay(clean(cells.eq(1).text(), 20)),
    ...(weight ? { weight_kg: weight } : {}),
    summary_only: true,
    events: [],
  };
}

/**
 * The tracking page's status lookup for one tracking ID: a table with the
 * job's row, or a notice. The notice for an unknown ID does not repeat the ID.
 */
export function parsePalletways(html: string, rawNumber: string): CarrierResult {
  const number = normalizePalletwaysNumber(rawNumber);
  const $ = load(html);
  if ($('table').length) return statusTable($, number);
  const notice = $('.alert .alert-heading');
  if (notice.length) {
    if (clean(notice.text(), 80) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Palletways answered with another notice');
  }
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Palletways refused the status lookup');
  throw new SchemaError(PROVIDER, 'Palletways did not return a status page');
}
