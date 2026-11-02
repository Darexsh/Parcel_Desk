import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { castoresStage } from './status.js';

export const PROVIDER = 'Transportes Castores';
// A shipment's page is about 40 kB, most of it the site around the tracking.
export const CASTORES_MAX_BYTES = 512 * 1024;
/** The tracking page, which renders the talones in `guide_numbers` on the server. */
export const CASTORES_PAGE = 'https://www.castores.com.mx/rastrear.html';

// The talón: the eleven digits under the carta porte's barcode.
const NUMBER = /^\d{11}$/;
// "09:52:44 Hrs", the hour sometimes without its leading zero.
const CLOCK = /^(\d{1,2}):(\d{2}):(\d{2}) Hrs$/;
// "21/Abr/2017", the month abbreviated in Spanish.
const DAY = /^(\d{2})\/([A-Za-z]{3,4})\/(\d{4})$/;
const MONTHS: ReadonlyMap<string, number> = new Map([
  ['ene', 1], ['feb', 2], ['mar', 3], ['abr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['ago', 8], ['sep', 9], ['sept', 9], ['oct', 10], ['nov', 11], ['dic', 12],
]);
// "Las guias 00000000000 ingresados no existe en la base de datos.", or "El talón …
// ingresado no existe …", naming the numbers asked.
const NOT_FOUND = /^(?:las guias|el talon) (\S+) ingresad[oa]s? no existe en la base de datos\.?$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|requested URL was rejected|Incapsula incident|_Incapsula_Resource|AwsWafIntegration/i;
const MAX_ROWS = 500;

/** A Castores talón: eleven digits. Anything else, the guía included, is not what the tracker takes. */
export function normalizeCastoresNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Castores tracks the eleven-digit talón under the carta porte’s barcode');
  return number;
}

/** The tracking page's own address for one talón, as its search form opens it. */
export function castoresLookupUrl(number: string): string {
  return `${CASTORES_PAGE}?${new URLSearchParams({ guide_numbers: normalizeCastoresNumber(number) })}`;
}

/** Lower case without accents, to compare the page's labels. */
function folded(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** "09:52:44 Hrs" on "21/Mar/2017" as a wall clock. The page gives no zone. */
function wallClock(clock: string, day: string): string | null {
  const time = CLOCK.exec(clock);
  const date = DAY.exec(day);
  if (!time || !date) return null;
  const month = MONTHS.get(date[2]!.toLowerCase());
  const calendar = month ? calendarDay(Number(date[3]), month, Number(date[1])) : null;
  if (!calendar || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 59) return null;
  return `${calendar}T${time[1]!.padStart(2, '0')}:${time[2]}:${time[3]}`;
}

/**
 * A row's wording: the heading the page files it under, then the branch's
 * status when it says something else, as "En Ruta de Entrega: TALON RECUPERADO
 * EN OFICINA".
 */
export function castoresWording(heading: string, status: string): string {
  if (!status || folded(status) === folded(heading)) return heading;
  return heading ? `${heading}: ${status}` : status;
}

/** The value of one heading over the shipment, "Servicio" or "Número de guía", or '' without it. */
function titled($: CheerioAPI, shipment: ReturnType<CheerioAPI>, label: string): string {
  const matches = shipment.find('.c-track__board-detailTitles h2')
    .filter((_, node) => folded(clean($(node).children('small').text(), 40)) === label);
  if (matches.length > 1) throw new SchemaError(PROVIDER, 'Castores repeated a detail of the shipment');
  return matches.length ? clean(matches.clone().children().remove().end().text(), 80) : '';
}

interface Row { key: string; event: CarrierEvent }

/** One history row: its clock and date, the heading, the branch's status and the branch. */
function row(item: ReturnType<CheerioAPI>): Row {
  const paragraphs = item.children('p');
  const headings = item.children('h4');
  if (paragraphs.length !== 3 || headings.length !== 1) throw new SchemaError(PROVIDER, 'Castores changed its history rows');
  const stamp = paragraphs.eq(0);
  const local_time = wallClock(clean(stamp.clone().children().remove().end().text(), 40), clean(stamp.children('small').text(), 40));
  const description = castoresWording(clean(headings.text(), 120), clean(paragraphs.eq(1).text(), 120));
  if (!local_time || !description) throw new SchemaError(PROVIDER, 'Castores returned a row without its clock and status');
  const location = clean(paragraphs.eq(2).text(), 120);
  const staged = castoresStage(description);
  const event: CarrierEvent = {
    local_time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local_time, description, location]), event };
}

/** The tracking page's answer when it shows no shipment: only its notice naming the talón is a missing one. */
function absent(html: string, body: ReturnType<CheerioAPI>, number: string): never {
  const notice = clean(body.text(), 400);
  if (!notice) throw new IndeterminateError(PROVIDER, 'Castores did not answer the lookup');
  const missing = NOT_FOUND.exec(folded(notice));
  if (missing) {
    if (missing[1] === number) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Castores answered for another talón');
  }
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Castores answered with a block page');
  throw new SchemaError(PROVIDER, 'Castores returned an unexpected answer');
}

/**
 * The page `rastrear.html?guide_numbers=` renders for one talón: the talón
 * and service over a progress rail, the origin and destination with the
 * parties and who took the delivery, then the history, a row per branch scan
 * with a wall clock, newest first. A talón it does not know gets a notice
 * naming it. Only the talón, the service and the history are read.
 */
export function parseCastores(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCastoresNumber(rawNumber);
  const $ = load(html);
  const body = $('main.js-rastrear section.c-track .c-track__body');
  if (body.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Castores answered with a block page');
    throw new SchemaError(PROVIDER, 'Castores did not return its tracking page');
  }
  const shipments = body.children('.js-shipping-content');
  if (!shipments.length) absent(html, body, number);
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'Castores answered for several shipments');
  const shipment = shipments.first();
  const shown = titled($, shipment, 'numero de guia');
  if (!shown) throw new SchemaError(PROVIDER, 'Castores returned a shipment without its talón');
  if (normalizeTrackingNumber(shown.replace(/^#/, '')) !== number) throw new IndeterminateError(PROVIDER, 'Castores answered for another talón');

  const lists = shipment.find('.js-shipDetails > ul');
  if (lists.length !== 1) throw new SchemaError(PROVIDER, 'Castores returned a shipment without its history');
  const items = lists.children('li');
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Castores returned an oversized history');
  const seen = new Set<string>();
  const listed: CarrierEvent[] = [];
  items.each((_, node) => {
    const parsed = row($(node));
    if (seen.has(parsed.key)) return;
    seen.add(parsed.key);
    listed.push(parsed.event);
  });
  if (!listed.length) throw new NoHistoryError(PROVIDER);
  // The page lists the newest first; a list the other way round is turned round.
  const events = listed.length > 1 && listed[0]!.local_time! < listed.at(-1)!.local_time! ? listed.reverse() : listed;

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const service = titled($, shipment, 'servicio');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    events,
  };
}
