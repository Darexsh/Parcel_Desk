import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { ampmStage } from './status.js';

export const PROVIDER = 'Grupo ampm';
export const CARRIER = 'ampm';
// The page with a long history is under a hundred kilobytes.
export const AMPM_MAX_BYTES = 1024 * 1024;

// Guías, Cainiao's CNA numbers and IDTS numbers: ten to thirty letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{10,30}$/;
const HEADINGS = ['FECHA', 'TIPO', 'MOVIMIENTO', 'OFICINA'];
// "24-01-2026 15:08:19": day, month, year and the second.
const CLOCK = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const ECHO = /^RASTREO:\s*(\S{1,64})$/;
const ESTIMATE = /^Fecha Compromiso de Entrega:\s*(.*)$/;
// The tracker's answer for a number it has nothing for, which it also gives a malformed one.
const NO_INFORMATION = /^Número de guía inválido o sin información$/i;
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|imunify360/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Grupo ampm's tracker, in upper case; anything else is not one it issues. */
export function normalizeAmpmNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Grupo ampm numbers are ten to thirty letters and digits');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

/** A `dd-MM-yyyy HH:mm:ss` clock as a wall time; anything else is a changed page. */
function wallClock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]) }, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed.isValid || parsed.year < 2000 || parsed.toFormat('dd-MM-yyyy HH:mm:ss') !== text) return null;
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The number the result's heading names, from its own text and not its link. */
function echoedNumber(heading: ReturnType<CheerioAPI>): string {
  const own = heading.contents().filter((_, node) => node.nodeType === 3).text();
  const match = ECHO.exec(clean(own, 200));
  if (!match) throw new SchemaError(PROVIDER, 'Grupo ampm did not name the shipment');
  return match[1]!.toUpperCase();
}

/** The promised delivery day, which the page heads the shipment with. */
function estimate($: CheerioAPI): string | null {
  const cells = $('td').filter((_, element) => ESTIMATE.test(clean($(element).text(), 200)));
  if (cells.length !== 1) return null;
  const local = wallClock(ESTIMATE.exec(clean(cells.text(), 200))![1]!);
  return local ? local.slice(0, 10) : null;
}

/**
 * The page Grupo ampm's tracker serves at `/rastreador/?tracking-id={number}`.
 * Each number asked gets a heading naming it, `RASTREO: {number}`. A shipment
 * follows with its promised delivery day, the sender and the masked recipient,
 * a progress rail, the table of its movements, oldest first, its service and
 * guía, and the delivery's details once a run ended. A number the tracker has
 * nothing for gets the heading with "Número de guía inválido o sin información".
 *
 * The heading must name the whole number asked. The sender, the recipient,
 * the rail, the service, the guía, the delivery's details and the link to the
 * proof of delivery are not read.
 */
export function parseAmpm(html: string, raw: string): CarrierResult {
  const number = normalizeAmpmNumber(raw);
  const $ = load(html);
  const headings = $('p.rastreo');
  if (!headings.length && isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Grupo ampm answered with a browser check');
  // One number asked, one heading.
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'Grupo ampm returned an unexpected page');
  if (echoedNumber(headings) !== number) throw new IndeterminateError(PROVIDER, 'Grupo ampm answered for another shipment');
  const notice = clean(headings.children('span').text(), 200);
  // Invalid or without information: the tracker does not say the shipment does not exist.
  if (NO_INFORMATION.test(notice)) {
    throw new IndeterminateError(PROVIDER, 'Grupo ampm\'s tracker has no information for the number', { reason: 'portal_not_found' });
  }

  const tables = $('table#grvMovimientos');
  const columns = tables.find('th').map((_, element) => clean($(element).text(), 40)).get();
  if (tables.length !== 1 || columns.join('|') !== HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'Grupo ampm history layout changed');
  const rows = tables.find('tr').filter((_, element) => $(element).children('td').length > 0);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Grupo ampm returned an oversized history');

  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.each((index, element) => {
    const cells = $(element).children('td');
    if (cells.length !== HEADINGS.length) throw new SchemaError(PROVIDER, 'Grupo ampm returned an invalid movement');
    const local = wallClock(clean(cells.eq(0).text(), 60));
    if (!local) throw new SchemaError(PROVIDER, 'Grupo ampm returned an invalid movement time');
    const code = clean(cells.eq(1).text(), 16).toUpperCase();
    const description = clean(cells.eq(2).text(), 200);
    const location = clean(cells.eq(3).text(), 120);
    if (!description) throw new SchemaError(PROVIDER, 'Grupo ampm returned a movement without wording');
    // A row the page lists twice is kept once.
    const identity = JSON.stringify([local, code, description, location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = ampmStage(code, description);
    scans.push({ local, index, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Oldest first, as the page lists them; equal clocks keep the page's order.
  scans.sort((left, right) => left.local.localeCompare(right.local) || left.index - right.index);
  // Once the parcel is sent back, every later movement is the way back: a
  // delivery then reaches the sender, not the recipient.
  let returning = false;
  for (const { event } of scans) {
    if (returning && event.stage && event.stage !== 'exception') event.stage = 'returned';
    if (event.stage === 'returned') returning = true;
  }
  const events = scans.map(({ event }) => event).reverse();

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    // The promise is for the outward delivery, which a delivery or a return ends.
    expected_delivery: returning || stage === 'delivered' ? null : estimate($),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
