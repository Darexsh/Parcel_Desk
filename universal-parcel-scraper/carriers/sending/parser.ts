import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isSendingNotice, isSendingReceipt, sendingPhaseStage, sendingStage } from './status.js';

export const PROVIDER = 'Sending';
// A page with a long history is under 50 kB.
export const SENDING_MAX_BYTES = 1024 * 1024;

const NUMBER = /^\d{12}$/;
const HEADING = 'Seguimiento del envío';
const NOT_FOUND = 'LO SENTIMOS, NO HEMOS ENCONTRADO TU ENVIO.';
const MONTHS = new Map(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre',
  'noviembre', 'diciembre'].map((name, index) => [name, index + 1] as const));
const DAY = /^(\d{1,2}) (\p{L}{4,10}) (\d{4})$/u;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const PHASE = /\bvar estado = "([A-Z]{2,8})";/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Sending shipment number: twelve digits, leading zeros included. */
export function normalizeSendingNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Sending shipment numbers are twelve digits');
  return number;
}

/** A bot check or firewall page in place of the tracker. */
export function isSendingChallenge(html: string): boolean {
  return /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha|Request Rejected/i.test(html);
}

/** A day heading such as "3 septiembre 2026". */
function headingDay(text: string): string {
  const match = DAY.exec(text);
  const month = match ? MONTHS.get(match[2]!.toLocaleLowerCase('es-ES')) : undefined;
  const day = match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
  if (!day) throw new SchemaError(PROVIDER, 'Sending returned an invalid scan day');
  return day;
}

/** Text without the children matching `drop`. */
function ownText(node: Cheerio<AnyNode>, drop: string, maxLength: number): string {
  const copy = node.clone();
  copy.find(drop).remove();
  return clean(copy.text(), maxLength);
}

/** The rail's current phase, which the page's script sets once. */
function phaseOf($: CheerioAPI): string {
  const phases = $('script').toArray().flatMap(node => [...$(node).text().matchAll(PHASE)].map(match => match[1]!));
  if (phases.length !== 1) throw new SchemaError(PROVIDER, 'Sending changed its progress rail');
  return phases[0]!;
}

/**
 * The page the tracker opens for one number: a heading naming the shipment,
 * the progress rail, the scans newest first under the day they happened, and
 * a block of sender, recipient and branch details. A number it does not know
 * opens its not-found page instead.
 */
export function parseSending(html: string, raw: string): CarrierResult {
  const number = normalizeSendingNumber(raw);
  const $ = load(html);
  const header = $('#header-text');
  if (header.length !== 1) {
    const absent = $('#noEncontrado .textosNoEncontrado');
    if (absent.length === 1 && clean(absent.text(), 80) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    if (isSendingChallenge(html)) throw new ChallengeError(PROVIDER, 'Sending answered with a browser check');
    throw new SchemaError(PROVIDER, 'Sending returned a page without a tracking answer');
  }
  if (clean(header.children('h1').text(), 80) !== HEADING) throw new SchemaError(PROVIDER, 'Sending changed its tracking heading');
  const shown = clean(header.children('h2').text(), 40);
  if (!/^\d{1,30}$/.test(shown)) throw new SchemaError(PROVIDER, 'Sending returned an invalid shipment number');
  // The tracker also finds a shipment by other references, and then names that shipment.
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'Sending answered for another shipment');
  const phase = phaseOf($);

  const table = $('#tracking table');
  if (table.length > 1) throw new SchemaError(PROVIDER, 'Sending returned more than one history');
  const rows = table.find('tr');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Sending returned an oversized history');

  const events: CarrierEvent[] = [];
  let day: string | undefined;
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length === 1 && cells.hasClass('date')) {
      day = headingDay(clean(cells.text(), 40));
      continue;
    }
    const time = cells.filter('.time');
    const info = cells.filter('.info');
    if (cells.length !== 2 || time.length !== 1 || info.length !== 1 || !day) throw new SchemaError(PROVIDER, 'Sending history layout changed');
    const clock = clean(time.text(), 8);
    const description = clean(info.children('h1').text(), 200);
    if (!CLOCK.test(clock)) throw new SchemaError(PROVIDER, 'Sending returned an invalid scan time');
    if (!description) throw new SchemaError(PROVIDER, 'Sending returned a scan without wording');
    // The receipt names whoever took the parcel, beside the delivery's own scan.
    if (isSendingReceipt(description)) continue;
    // The branch's town; its number in brackets is left out.
    const location = ownText(info.children('h2'), 'em', 80);
    // Some scans carry the day alone, written as midnight.
    events.push({ local_time: clock === '00:00' ? day : `${day}T${clock}:00`, description, ...(location ? { location } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // Oldest first: a notice keeps the stage of the scan before it.
  let previous: Stage | undefined;
  for (const event of [...events].reverse()) {
    if (isSendingNotice(event.description!)) {
      Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
      continue;
    }
    const staged = sendingStage(event.description!);
    if (!staged) continue;
    Object.assign(event, { stage: staged.stage, stage_source: staged.source });
    previous = staged.stage;
  }

  const decider = events.find(event => event.stage && event.stage_source !== 'none');
  let stage = decider?.stage as Stage | undefined;
  let source = decider?.stage_source;
  let text = (decider ?? events[0]!).description!;
  // A delivered parcel and one written off as missing end on the rail, whatever the last scan says.
  const ended = sendingPhaseStage(phase);
  const declared = ended && ended !== stage;
  if (declared) {
    stage = ended;
    source = 'carrier_map';
    text = clean($(`#timeline td[fase="${phase}"] span`).first().text(), 80) || phase;
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    ...(declared ? { provider_code: phase } : {}),
    last_status_text: text,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
