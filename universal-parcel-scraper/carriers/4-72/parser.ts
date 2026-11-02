import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { fourSeventyTwoStage } from './status.js';

export const PROVIDER = '4-72';
// A shipment's card and its scans are each under twenty kilobytes.
export const FOUR_SEVENTY_TWO_MAX_BYTES = 512 * 1024;

const MAX_ROWS = 500;
const HEADINGS = ['Fecha', 'Centro Operativo', 'Evento', 'Observaciones'];
const TITLE = /^Número de Guía\s+(\S{1,64})$/;
// The scan's wall clock: "17/07/2023 10:08:26", or on twelve hours "9/05/2023 4:07:04 p. m.".
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?: ([ap])\. ?m\.)?$/i;
// The tariff's year the tracker writes after some services: "CORREO CERTIFICADO NACIONAL 2025".
const TARIFF_YEAR = /\s+(?:19|20)\d{2}$/;
// A run of six or more digits, as phone and ID numbers are written.
const DIGITS = /\d(?:[\s.-]?\d){5,}/g;
// A bot check or firewall page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha|incapsula|support ID/i;

/**
 * 4-72's tracker looks up UPU S10 item codes: its own, ending CO, and those of
 * the posts that send mail to Colombia. The code needs a valid check digit.
 */
export function normalizeFourSeventyTwoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, '4-72 tracks S10 item codes');
}

const blocked = (html: string) => BLOCKED.test(html.slice(0, 64_000));

function unexpected(html: string, message: string): never {
  if (blocked(html)) throw new ChallengeError(PROVIDER, '4-72 answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** A calendar-checked wall clock to the second; parsing in UTC assigns no offset. */
function wallClock(shown: string): string {
  const parts = CLOCK.exec(shown);
  if (!parts) throw new SchemaError(PROVIDER, '4-72 returned an invalid scan time');
  const [, day, month, year, rawHour, minute, second, half] = parts;
  let hour = Number(rawHour);
  if (half) {
    if (hour < 1 || hour > 12) throw new SchemaError(PROVIDER, '4-72 returned an invalid scan time');
    hour = hour % 12 + (half.toLowerCase() === 'p' ? 12 : 0);
  }
  const local = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:${second}`;
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, '4-72 returned an invalid scan time');
  }
  return local;
}

/** The value under a label of the shipment's own card, never the sender's or the recipient's. */
function shipmentField($: CheerioAPI, label: string): string {
  const card = $('.card').filter((_, element) => clean($(element).find('.card-title').first().text(), 80) === 'Datos del envío:').first();
  const heading = card.find('h5').filter((_, element) => clean($(element).text(), 80) === label).first();
  return clean(heading.parent().next().text(), 120);
}

interface Row { clock: string; event: CarrierEvent; index: number }

/**
 * The scans of `Traceability/Events`: a table of the scan's wall clock, the
 * operating centre, the event and a remark, oldest first. The remark, such as
 * why a visit did not deliver, follows the event, without digit runs that
 * could be a phone or ID number; a delivery's remark is not read.
 */
function scans(html: string): Row[] {
  const $ = load(`<table>${html}</table>`);
  const headings = $('thead th').map((_, element) => clean($(element).text(), 40)).get();
  if (headings.join('|') !== HEADINGS.join('|')) unexpected(html, '4-72 returned an unexpected scan table');
  const rows = $('tbody tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, '4-72 returned an oversized history');
  return rows.map((index, element) => {
    const cells = $(element).children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, '4-72 returned an invalid scan');
    const cell = (at: number, maxLength: number) => clean(cells.eq(at).text(), maxLength);
    const wording = cell(2, 200);
    if (!wording) throw new SchemaError(PROVIDER, '4-72 returned a scan without wording');
    const staged = fourSeventyTwoStage(wording);
    const remark = staged?.stage === 'delivered' ? '' : clean(cell(3, 200).replace(DIGITS, ' '));
    const description = remark ? `${wording}: ${remark}` : wording;
    const location = cell(1, 80);
    const clock = wallClock(cell(0, 40));
    const event: CarrierEvent = {
      local_time: clock,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { clock, event, index };
  }).get();
}

/**
 * The tracking page's two replies for one guía: `Traceability/Search`, the
 * shipment's card under a heading naming the guía, and `Traceability/Events`,
 * its scans. The search answers a guía it does not know with an empty reply,
 * which the page reports as "No se ha encontrado información de la guía"; the
 * scan table then has no rows. The card's sender, recipient, receiver and
 * linked guías are not read.
 */
export function parseFourSeventyTwo(search: string, events: string, rawNumber: string): CarrierResult {
  const number = normalizeFourSeventyTwoNumber(rawNumber);
  const rows = scans(events);
  if (!search.trim()) {
    if (rows.length) throw new IndeterminateError(PROVIDER, '4-72 returned scans for a guía its search did not find');
    throw new NotFoundError(PROVIDER);
  }
  const $ = load(search);
  const named = TITLE.exec(clean($('h3').first().text(), 120))?.[1];
  if (!named) unexpected(search, '4-72 returned an unexpected shipment card');
  if (normalizeTrackingNumber(named) !== number) throw new SchemaError(PROVIDER, '4-72 answered for a different guía');
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Oldest first by clock; scans at the same clock keep the reply's order.
  rows.sort((left, right) => left.clock.localeCompare(right.clock) || left.index - right.index);
  const seen = new Set<string>();
  const kept: CarrierEvent[] = [];
  let delivered = false;
  for (const { event } of rows) {
    // After a delivery, the signed delivery document travels back to the
    // sender under the return wordings; those scans are not the item's.
    if (delivered && event.stage === 'returned') continue;
    if (event.stage === 'delivered') delivered = true;
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(event);
  }
  const newestFirst = kept.reverse();
  const latest = newestFirst[0]!;
  const current = newestFirst.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const service = shipmentField($, 'Tipo de servicio:').replace(TARIFF_YEAR, '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    events: newestFirst,
  };
}
