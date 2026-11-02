import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { sendexStage } from './status.js';

export const PROVIDER = 'Sendex';
// The result page is about 100 kB, most of it the site's theme.
export const SENDEX_MAX_BYTES = 1_000_000;
// The tracker asks for twelve digits and sends eleven-digit guías to Coordinadora's tracker.
const NUMBER = /^\d{12}$/;
// "17/04/2024 17:55": a day, a month, a year and a clock to the minute.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
// The commitment date, with or without a clock.
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})(?: \d{2}:\d{2})?$/;
// The dash the page shows in an empty field.
const EMPTY = /^[-–—]*$/;
const NOT_FOUND = 'no se encontraron resultados para las guias ingresadas.';
// The tracker's refusal of a number shorter than twelve digits.
const INCOMPLETE = /guia completa/;
// A firewall's, CDN's or bot check's page in place of the tracker's.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha-delivery|awswaf/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Sendex guía: twelve digits. Anything else, an eleven-digit Coordinadora guía included, is not one Sendex issues. */
export function normalizeSendexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Sendex guías are twelve digits');
  return number;
}

/** A label's key: lower case, single spaces and no accents. */
function labelKey(text: string): string {
  return clean(text, 200).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** A field's value, without the dash the page puts in an empty one. */
function value(text: string, maxLength = 200): string {
  const shown = clean(text, maxLength);
  return EMPTY.test(shown) ? '' : shown;
}

const pad = (part: string) => part.padStart(2, '0');

/**
 * A movement's clock: the branch's wall clock to the minute. Mexico has
 * several zones and the page names none, so no offset is assigned.
 */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const date = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!match || !date || Number(match[4]) > 23 || Number(match[5]) > 59) throw new SchemaError(PROVIDER, 'Sendex returned an invalid movement time');
  return `${date}T${pad(match[4]!)}:${pad(match[5]!)}:00`;
}

/** The commitment date as a calendar day; a field the page leaves empty, or writes otherwise, gives none. */
function commitment(text: string): string | null {
  const match = DAY.exec(text);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** The card's fields this adapter reads, by their label. The recipient's are not read. */
const FIELDS = new Set(['numero de guia', 'pais', 'tipo de servicio', 'fecha compromiso']);

function fields($: CheerioAPI, card: Cheerio<AnyNode>): Map<string, string> {
  const found = new Map<string, string>();
  card.find('.sdx-cell').each((_, node) => {
    const cell = $(node);
    const label = labelKey(cell.children('.sdx-cell__label').text());
    if (!FIELDS.has(label)) return;
    if (found.has(label)) throw new SchemaError(PROVIDER, 'Sendex result layout changed');
    found.set(label, value(cell.children('.sdx-cell__value').text()));
  });
  return found;
}

/** One movement row: its office, its clock and its wording, each under its label. */
function movement($: CheerioAPI, row: Cheerio<AnyNode>): { office: string; clock: string; description: string } {
  const items = new Map<string, string>();
  row.children('.sdx-movements__item').each((_, node) => {
    const item = $(node);
    items.set(labelKey(item.children('.sdx-movements__label').text()), value(item.children('.sdx-movements__value').text(), 300));
  });
  const [office, clock, description] = ['oficina', 'fecha y hora', 'descripcion'].map((label) => items.get(label));
  if (office === undefined || clock === undefined || description === undefined) throw new SchemaError(PROVIDER, 'Sendex movement layout changed');
  if (!description) throw new SchemaError(PROVIDER, 'Sendex returned a movement without wording');
  return { office, clock, description };
}

/**
 * The page the tracker renders after its form posts one guía: a card with the
 * guía, its type, the recipient and destination, the service and two dates,
 * then the movements, oldest first, each with an office, a clock and a
 * wording, and who received a delivered parcel. A guía it does not hold gets
 * a notice in place of the card.
 */
export function parseSendex(html: string, raw: string): CarrierResult {
  const number = normalizeSendexNumber(raw);
  const $ = load(html);
  const widget = $('.elementor-widget-sendex_resultados');
  if (!widget.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Sendex answered with a block page');
    throw new SchemaError(PROVIDER, 'Sendex did not return its tracking results');
  }
  if (widget.length > 1) throw new SchemaError(PROVIDER, 'Sendex result layout changed');
  const cards = widget.find('.sdx-card');
  if (!cards.length) {
    if (widget.find('.sendex-error').length) throw new IndeterminateError(PROVIDER, 'Sendex could not look the guía up');
    const notice = labelKey(widget.find('.sendex-notice').text());
    if (notice === NOT_FOUND) throw new NotFoundError(PROVIDER);
    // The adapter sends twelve digits, so a refusal means the form changed.
    if (INCOMPLETE.test(notice)) throw new SchemaError(PROVIDER, 'Sendex refused the guía as incomplete');
    throw new SchemaError(PROVIDER, 'Sendex returned results without a guía or its notice');
  }
  if (cards.length > 1) throw new SchemaError(PROVIDER, 'Sendex returned several guías');
  const card = cards.first();
  const shown = fields($, card);
  const guia = shown.get('numero de guia');
  if (guia === undefined) throw new SchemaError(PROVIDER, 'Sendex returned a guía without its number');
  if (normalizeTrackingNumber(guia) !== number) throw new IndeterminateError(PROVIDER, 'Sendex answered for another guía');

  const rows = card.find('.sdx-movements__row');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Sendex returned an oversized history');
  const seen = new Set<string>();
  const listed: CarrierEvent[] = [];
  rows.each((_, node) => {
    const row = movement($, $(node));
    const event: CarrierEvent = { local_time: wallClock(row.clock), ...(row.office ? { location: row.office } : {}), description: row.description };
    // The tracker can list one movement twice.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = sendexStage(row.description);
    if (staged) Object.assign(event, { stage: staged.stage, stage_source: staged.source });
    listed.push(event);
  });
  if (!listed.length) throw new NoHistoryError(PROVIDER);
  // The page lists the movements oldest first; the result has them newest first.
  const events = (listed[0]!.local_time as string) <= (listed.at(-1)!.local_time as string) ? listed.reverse() : listed;

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const service = shown.get('tipo de servicio');
  const destination = shown.get('pais');
  const country = destination ? countryCode(destination) : null;
  const expected = stage === 'delivered' || stage === 'returned' ? null : commitment(shown.get('fecha compromiso') ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
