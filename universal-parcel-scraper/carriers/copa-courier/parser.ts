import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { copaCourierStage } from './status.js';

export const PROVIDER = 'Copa Courier';
// The home page is about 40 kB and a long history about 12 kB.
export const COPA_COURIER_MAX_BYTES = 512 * 1024;

const NUMBER = /^H\d{7}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,1024}$/;
// A row's clock as the Spanish page writes it, "22-dic.-2026 15:08"; an English session writes "22-Dec-2026 15:08".
const CLOCK = /^(\d{1,2})-([a-z]{3,4})\.?-(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/i;
const MONTHS: Readonly<Record<string, number>> = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7,
  ago: 8, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};
// The station after a milestone, an airport code, or nothing after the dash.
const STATION = /(?:^|\s+)-(?:\s+([A-Z]{3}))?$/;
// Stations seen in replies, by the airport code the tracker writes; another code stays as written.
const STATIONS: Readonly<Record<string, string>> = {
  HAV: 'Havana, Cuba',
  MGA: 'Managua, Nicaragua',
  ONX: 'Colón, Panama',
  PTY: 'Panama City, Panama',
  SCL: 'Santiago, Chile',
  SJO: 'San José, Costa Rica',
};
const NOT_FOUND = /no hemos encontrado el c[oó]digo/i;
const MALFORMED = /formato incorrecto/i;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|_Incapsula_Resource/i;
// The weight as the page writes it, with a decimal comma in Spanish.
const WEIGHT = /^\d{1,4}(?:[.,]\d{1,3})?$/;
// Rows one minute apart are not always in order: a delivery can come before the van that brought it.
const TIE_ORDER: Partial<Record<Stage, number>> = { accepted: 0, out_for_delivery: 2, delivered: 3 };
const MAX_ROWS = 500;

/** A house air waybill: `H` and seven digits. Anything else is not a number Copa Courier issues. */
export function normalizeCopaCourierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Copa Courier HAWB numbers are H and seven digits');
  return number;
}

function assertNotBlocked(html: string): void {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Copa Courier answered with a browser check');
}

/** The anti-forgery token of the home page's tracking form. */
export function parseCopaCourierForm(html: string): string {
  const $ = load(html);
  const forms = $('form[action="/Hawb/Hawb"]');
  if (forms.length !== 1 || forms.find('textarea[name="txtNumeroHAWB"]').length !== 1) {
    assertNotBlocked(html);
    throw new SchemaError(PROVIDER, 'Copa Courier home page has no tracking form');
  }
  const tokens = forms.find('input[name="__RequestVerificationToken"]');
  const token = tokens.length === 1 ? tokens.attr('value') ?? '' : '';
  if (!TOKEN.test(token)) throw new SchemaError(PROVIDER, 'Copa Courier tracking form changed');
  return token;
}

/** A row's wall clock, to the minute, with no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const month = match ? MONTHS[match[2]!.toLowerCase()] : undefined;
  if (!match || !month) throw new SchemaError(PROVIDER, 'Copa Courier returned an invalid scan time');
  // Built in UTC to check the calendar alone: a day that does not exist is refused.
  const parsed = DateTime.fromObject({ year: Number(match[3]), month, day: Number(match[1]), hour: Number(match[4]),
    minute: Number(match[5]) }, { zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'Copa Courier returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The weight in kilograms, when the page labels it so. */
function weightOf(label: string, text: string): number | undefined {
  if (!/\(kg\)/i.test(label) || !WEIGHT.test(text)) return undefined;
  const value = Number(text.replace(',', '.'));
  return value > 0 ? value : undefined;
}

interface Row { event: CarrierEvent; rank: number; index: number }

/**
 * The page `POST /Hawb/Hawb` answers for one HAWB. The server renders a box
 * with the HAWB, the origin and destination towns, the package count and the
 * weight, then its milestones oldest first, each with a wall clock, its
 * wording and the station's airport code, and a detail line that names who
 * took a delivered parcel. A HAWB the tracker does not know comes back as a
 * notice that the code is not in its database.
 */
export function parseCopaCourier(html: string, raw: string): CarrierResult {
  const number = normalizeCopaCourierNumber(raw);
  const $ = load(html);
  if (!$('body#bodySeguimiento').length) {
    assertNotBlocked(html);
    throw new SchemaError(PROVIDER, 'Copa Courier returned a page without an answer');
  }
  const boxes = $('.cajaseguimiento');
  if (!boxes.length) {
    const notice = clean($('#bmicajaerror').text(), 300);
    if (NOT_FOUND.test(notice)) throw new NotFoundError(PROVIDER);
    // An H and seven digits is a shape the tracker takes: a refusal means the request changed.
    if (MALFORMED.test(notice)) throw new SchemaError(PROVIDER, 'Copa Courier refused the HAWB as malformed');
    throw new SchemaError(PROVIDER, 'Copa Courier returned a page without an answer');
  }
  if (boxes.length !== 1) throw new SchemaError(PROVIDER, 'Copa Courier returned an unexpected number of shipments');
  const echoed = boxes.find('#lblHAWB1');
  if (echoed.length !== 1) throw new SchemaError(PROVIDER, 'Copa Courier returned a shipment without its HAWB');
  if (clean(echoed.text(), 40) !== number) throw new SchemaError(PROVIDER, 'Copa Courier answered for a different HAWB');
  const list = boxes.find('ul#bmilistadetalle1');
  if (list.length !== 1) throw new SchemaError(PROVIDER, 'Copa Courier returned a shipment without its milestones');
  const items = list.children('li.detallelista');
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Copa Courier returned an oversized history');

  const rows: Row[] = [];
  items.each((index, node) => {
    const item = $(node);
    const clock = item.find('label.fechadetalle');
    const milestone = item.find('label.hitodescripcion');
    if (clock.length !== 1 || milestone.length !== 1) throw new SchemaError(PROVIDER, 'Copa Courier returned a milestone without its time or wording');
    const written = clean(milestone.text(), 200);
    const station = STATION.exec(written);
    const description = station ? written.slice(0, station.index) : written;
    if (!description) throw new SchemaError(PROVIDER, 'Copa Courier returned a milestone without its wording');
    const code = station?.[1];
    const location = code ? STATIONS[code] ?? code : undefined;
    const staged = copaCourierStage(description);
    // The detail line names who took the parcel and their identity card; it is not read.
    const event: CarrierEvent = {
      local_time: wallClock(clean(clock.text(), 40)),
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    rows.push({ event, rank: (staged && TIE_ORDER[staged.stage]) ?? 1, index });
  });
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Oldest first by wall clock, then by progress within a minute, then the page's order; newest first after.
  rows.sort((a, b) => (a.event.local_time as string).localeCompare(b.event.local_time as string) || a.rank - b.rank || a.index - b.index);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const { event } of rows.reverse()) {
    const key = JSON.stringify([event.local_time, event.description, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  const weight = weightOf(clean(boxes.find('label[for="lblPesoNeto"]').text(), 40), clean(boxes.find('#lblPesoNeto1').text(), 20));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    events,
  };
}
