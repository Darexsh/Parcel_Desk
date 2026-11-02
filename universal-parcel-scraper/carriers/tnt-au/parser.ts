import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isTntAuNotice, tntAuStage } from './status.js';

export const PROVIDER = 'TNT Australia';
export const CARRIER = 'tnt-au';
// A page is about 4 kB.
export const TNT_AU_MAX_BYTES = 256 * 1024;

// A domestic consignment: three letters and nine digits.
const NUMBER = /^[A-Z]{3}\d{9}$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const MAX_EVENTS = 200;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A number for TNT Australia's tracker: a domestic consignment, three letters and nine digits. */
export function normalizeTntAuNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TNT Australia consignments are three letters and nine digits');
  return number;
}

/** A day the page writes `dd/mm/yyyy` as `yyyy-mm-dd`, or ''. */
function isoDay(value: string): string {
  const match = DAY.exec(value);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) ?? '' : '';
}

/**
 * The tracker's page `trackref_detail.asp?con={number}`. It repeats the
 * consignment asked, then lists its scans oldest first, each with a wording,
 * a day, a time on the depot's wall clock and the depot. The consignment's
 * estimated delivery comes above them. A number it does not know has one row
 * saying so.
 */
export function parseTntAu(html: string, raw: string): CarrierResult {
  const number = normalizeTntAuNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TNT Australia answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const table = $('#appTable');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'TNT Australia returned an unexpected page');
  const summary = table.find('td.strong').toArray().map((cell) => clean($(cell).text(), 80));
  const shown = summary.map((cell) => /^Consignment No:\s*(\S+)$/i.exec(cell)?.[1]).find(Boolean);
  if (!shown) throw new SchemaError(PROVIDER, 'TNT Australia returned a page without the consignment asked');
  if (normalizeTrackingNumber(shown).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'TNT Australia answered for another consignment');
  const heading = table.find('td.heading').toArray().map((cell) => clean($(cell).text(), 20));
  if (heading.join('|') !== 'Status|Date|Time|Depot') throw new SchemaError(PROVIDER, 'TNT Australia tracking columns changed');
  const rows = table.find('tr').toArray().filter((row) => $(row).children('td').length === 4 && !$(row).children('td.heading').length);
  if (!rows.length) {
    const notice = clean(table.find('td[colspan="4"]').last().text(), 80);
    if (/^No consignment was found$/i.test(notice)) throw new NotFoundError(PROVIDER, 'TNT Australia holds no consignment under this number');
    throw new SchemaError(PROVIDER, 'TNT Australia returned a consignment without scans');
  }
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'TNT Australia returned an oversized history');

  // Oldest first, as the page lists them: a notice keeps the stage of the scan before it.
  let previous: Stage | undefined;
  const events = rows.map((row): CarrierEvent => {
    const [wording = '', date = '', clock = '', depot = ''] = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 160));
    const day = isoDay(date);
    const time = CLOCK.exec(clock);
    if (!wording || !day || !time) throw new SchemaError(PROVIDER, 'TNT Australia returned an invalid scan');
    const scan = { local_time: `${day}T${time[1]}:${time[2]}:00`, description: wording, ...(depot ? { location: depot } : {}) };
    if (isTntAuNotice(wording)) return { ...scan, ...(previous ? { stage: previous, stage_source: 'none' } : {}) };
    const stage = tntAuStage(wording);
    if (stage) previous = stage.stage;
    return { ...scan, ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  }).reverse();
  const newest = events[0]!;
  // The parcel stands at its newest scan with a stage; a notice after it stays the last update.
  const current = events.find((event) => event.stage && event.stage_source !== 'none');
  const stage = current?.stage as Stage | undefined;
  const eta = summary.map((cell) => /^Estimated Delivery by:\s*(\d{2}\/\d{2}\/\d{4})(?:\s+\d{2}:\d{2})?$/i.exec(cell)?.[1]).find(Boolean);
  const expected = eta && stage !== 'delivered' ? isoDay(eta) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: expected || null,
    events: events.slice(0, MAX_EVENTS),
  };
}
