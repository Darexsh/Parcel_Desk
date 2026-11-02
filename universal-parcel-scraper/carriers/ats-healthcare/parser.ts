import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { atsMappedStage } from './status.js';

export const PROVIDER = 'ATS Healthcare';
export const CARRIER = 'ats-healthcare';
// A page is about 9 kB.
export const ATS_MAX_BYTES = 256 * 1024;

// Eight or nine digits, as the tracker prints them.
const NUMBER = /^\d{8,9}$/;
// "Delivered, 2026/02/18 14:10:56": the status and its wall clock, with no zone.
const STATUS = /^(.+?),\s*(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const HEADINGS = ['', 'Shipment', 'Date', 'Time', 'Signature', 'Status'];
// The row the tracker shows for any number it does not hold.
const PLACEHOLDER = 'Shipping label created for ATS Healthcare';
// "6-Delivered": a step of the progress bar and its name.
const STEP = /^(\d)-(.+)$/;

/** A number for ATS Healthcare's tracker: eight or nine digits. */
export function normalizeAtsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ATS Healthcare shipment numbers have eight or nine digits');
  return number;
}

type Selection = ReturnType<CheerioAPI>;

/** The status's wall clock, to the second; none when the status has none. */
function statusClock(parts: RegExpExecArray): string {
  const [year, month, day, hour, minute, second] = parts.slice(2).map(Number) as [number, number, number, number, number, number];
  const date = calendarDay(year, month, day);
  if (!date || hour > 23 || minute > 59 || second > 59) throw new SchemaError(PROVIDER, 'ATS Healthcare returned an invalid status time');
  return `${date}T${parts[5]}:${parts[6]}:${parts[7]}`;
}

/** The progress bar's current step, with its name from the legend under it. */
function currentStep($: CheerioAPI, detail: Selection): { code: string; name: string } {
  const steps = detail.find('#lstProgress > li').toArray();
  const legend = new Map(detail.find('#lstProgressDescr > li').toArray().flatMap((item) => {
    const step = STEP.exec(clean($(item).text(), 80));
    return step ? [[step[1]!, step[2]!.trim()] as const] : [];
  }));
  const active = steps.filter((step) => $(step).hasClass('active'));
  const code = active.length === 1 ? clean($(active[0]).text(), 4) : '';
  const name = legend.get(code);
  if (!steps.length || !/^\d$/.test(code) || !name) throw new SchemaError(PROVIDER, 'ATS Healthcare returned a shipment without its progress');
  return { code, name };
}

/**
 * The tracker's result page for one number, `/quickTrackResult?ship=`, which
 * its server renders: a row with the number, the delivery's day and time, the
 * signatory and the status with its clock, then the shipment's progress bar,
 * from on file (0) to delivered (6). The row's number must be the one asked. A
 * number the tracker does not hold gets a placeholder row, "Shipping label
 * created for ATS Healthcare", and "No detail for shipment" in place of the
 * progress. The signatory is not kept; the page has no history.
 */
export function parseAts(html: string, raw: string): CarrierResult {
  const number = normalizeAtsNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ATS Healthcare answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const table = $('table#dgPOD');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'ATS Healthcare returned an unexpected page');
  const headings = table.find('tr').first().children('th').toArray().map((heading) => clean($(heading).text(), 40));
  if (headings.join('|') !== HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'ATS Healthcare changed its result table');
  const rows = table.find('tr').toArray().slice(1);
  const cells = rows.length === 1 ? $(rows[0]).children('td') : null;
  if (!cells || cells.length !== HEADINGS.length) throw new SchemaError(PROVIDER, 'ATS Healthcare returned an invalid result row');
  if (clean(cells.eq(1).text(), 40) !== number) throw new IndeterminateError(PROVIDER, 'ATS Healthcare answered for another shipment');
  const status = clean(cells.eq(5).text(), 200);
  const detail = $('#divQuickTrackShipDetail');
  const shown = clean(detail.find('#lblShip').text(), 80);
  if (detail.length !== 1 || !status || !shown) throw new SchemaError(PROVIDER, 'ATS Healthcare returned a shipment without its state');
  if (shown === `No detail for shipment ${number}`) {
    if (status === PLACEHOLDER) throw new NotFoundError(PROVIDER, 'ATS Healthcare has no shipment for this number');
    throw new IndeterminateError(PROVIDER, 'ATS Healthcare gave no detail for this shipment');
  }
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'ATS Healthcare answered for another shipment');

  const step = currentStep($, detail);
  const clocked = STATUS.exec(status);
  const wording = clocked ? clocked[1]!.trim() : status;
  const stage = atsMappedStage(step.code);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: wording,
    provider_code: step.code,
    last_update: null,
    last_update_local: clocked ? statusClock(clocked) : null,
    expected_delivery: null,
    summary_only: true,
    events: [],
  };
}
