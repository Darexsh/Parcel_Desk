import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { torrestirStage } from './status.js';

export const PROVIDER = 'Torrestir';
// The page is about 30 kB, most of it the site's styles, scripts and footer.
export const TORRESTIR_MAX_BYTES = 1_000_000;
// `torrestir-1`: M001, four digits, a letter or digit, then eleven digits that
// hold the guia number zero-padded to ten digits and one more digit.
const NUMBER = /^M001\d{4}[0-9A-Z]\d{11}$/;
// "2026-01-12 16:40"
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
// Torrestir's own reference, the guia: "0.10.3.12345678".
const REFERENCE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.(\d{1,10})$/;
// The estimate's day, with the window the page may add: "2026-01-13 10:05 / 10:35".
const ESTIMATE = /^(\d{4})-(\d{2})-(\d{2})(?: \d{2}:\d{2}(?: \/ \d{2}:\d{2})?)?$/;
// A scan at one of Torrestir's warehouses (armazém) names it by its town: "ARM. LISBOA".
const WAREHOUSE = /^ARM\.\s*(\S.*)$/;
// The scan list is bound to the page's model: `listaTracking[0].BeginDate`.
const ROW_FIELD = /^listaTracking\[(\d{1,4})\]\.(IdMoment|BeginDate|Description|latitude|longitude)$/;
// The card's labels in the tracker's three languages.
const REFERENCE_LABELS = new Set(['nossa referência', 'our reference', 'nuestra referencia']);
const ESTIMATE_LABELS = new Set(['estimado', 'estimated']);
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|g-recaptcha|h-captcha|_Incapsula_Resource/i;
const MAX_ROWS = 200;

type Row = Partial<Record<'IdMoment' | 'BeginDate' | 'Description' | 'latitude' | 'longitude', string>>;

/** A Torrestir tracking code; anything else is not a number Torrestir's tracker opens. */
export function normalizeTorrestirNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Torrestir tracking codes are M001, four digits, a letter or digit and eleven digits');
  }
  return number;
}

/**
 * A scan's clock, a wall clock to the minute with no zone. Torrestir also
 * works from the Azores, Spain and Germany, and the page names a warehouse
 * without its country, so the clock stays as written. Midnight exactly is a
 * day: the guia's creation carries no time.
 */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59) throw new SchemaError(PROVIDER, 'Torrestir returned an invalid scan time');
  return match[4] === '00' && match[5] === '00' ? day : `${day}T${match[4]}:${match[5]}:00`;
}

/** The card's `Label: value` fields, by label in lower case. */
function cardFields($: CheerioAPI): Map<string, string> {
  const fields = new Map<string, string>();
  for (const node of $('.log-track-details2 strong.card-item').toArray()) {
    const label = clean($(node).text(), 60).replace(/\s*:$/, '').toLocaleLowerCase('pt-PT');
    if (fields.has(label)) throw new IndeterminateError(PROVIDER, 'Torrestir answered for several shipments');
    fields.set(label, clean($(node).parent().clone().children('strong.card-item').remove().end().text(), 120));
  }
  return fields;
}

/** The one field of the card under any of these labels. */
function cardField(fields: Map<string, string>, labels: ReadonlySet<string>): string {
  const found = [...fields].filter(([label]) => labels.has(label));
  if (found.length !== 1) throw new SchemaError(PROVIDER, 'Torrestir returned a page without its reference card');
  return found[0]![1];
}

/** The scan list's rows, in the page's order, from the hidden fields its model binds. */
function scanRows($: CheerioAPI): Row[] {
  const rows: Row[] = [];
  for (const node of $('input[name^="listaTracking["]').toArray()) {
    const field = ROW_FIELD.exec($(node).attr('name') ?? '');
    if (!field) continue;
    const index = Number(field[1]);
    if (index >= MAX_ROWS) throw new SchemaError(PROVIDER, 'Torrestir returned an oversized history');
    const row = rows[index] ??= {};
    const name = field[2] as keyof Row;
    if (row[name] !== undefined) throw new IndeterminateError(PROVIDER, 'Torrestir answered for several shipments');
    row[name] = $(node).attr('value') ?? '';
  }
  if (Array.from(rows).some((row) => !row)) throw new SchemaError(PROVIDER, 'Torrestir returned an incomplete history');
  return rows;
}

/** The estimate's day while the parcel is still to come, and not a day before its newest scan. */
function estimateDay(text: string, newest: string): string | null {
  const match = ESTIMATE.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  return day && day >= newest.slice(0, 10) ? day : null;
}

/**
 * Torrestir's tracker page for one code, `/?id={code}`, which the tracker
 * renders on its server. A card gives the code, the customer that booked the
 * shipment and its reference, Torrestir's own reference (the guia), the
 * estimate, the origin and destination towns and the parcel and pallet
 * counts. A table lists the scans, oldest first, each with its place (a
 * warehouse, or the leg such as `Em Viagem`), clock and wording, and a
 * warehouse's coordinates. The page repeats any code it is asked, and a code
 * it holds nothing for gets the card and table empty.
 */
export function parseTorrestir(html: string, rawNumber: string): CarrierResult {
  const number = normalizeTorrestirNumber(rawNumber);
  const $ = load(html);
  const codes = $('.trackcodet .codenum');
  const tables = $('table.tabela');
  if (!codes.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Torrestir answered with a bot check');
    throw new SchemaError(PROVIDER, 'Torrestir did not return its tracker page');
  }
  // One code opens one shipment; a page with several cannot say which is the code's.
  if (codes.length > 1 || tables.length > 1) throw new IndeterminateError(PROVIDER, 'Torrestir answered for several shipments');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Torrestir returned a page without its scan table');
  if (normalizeTrackingNumber(clean(codes.text(), 80)) !== number) throw new IndeterminateError(PROVIDER, 'Torrestir answered for another shipment');
  const fields = cardFields($);
  const reference = cardField(fields, REFERENCE_LABELS);
  const estimate = cardField(fields, ESTIMATE_LABELS);
  const rows = scanRows($);
  if (!reference) {
    if (rows.length) throw new SchemaError(PROVIDER, 'Torrestir returned scans without its reference');
    throw new NotFoundError(PROVIDER);
  }
  const guia = REFERENCE.exec(reference);
  if (!guia) throw new SchemaError(PROVIDER, 'Torrestir returned an unexpected reference');
  // The page echoes the code asked, so the guia it shows must be the one the code holds.
  if (Number(guia[1]) !== Number(number.slice(9, 19))) throw new IndeterminateError(PROVIDER, 'Torrestir answered for another shipment');

  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    const description = clean(row.Description, 200);
    if (!description || row.BeginDate === undefined) throw new SchemaError(PROVIDER, 'Torrestir returned a scan without its clock or wording');
    const local = wallClock(clean(row.BeginDate, 40));
    // A leg (`Registo`, `Em Viagem`, `Destinatário`) is not a place; a warehouse is, and has coordinates.
    const place = clean(row.IdMoment, 120);
    const point = eventPoint(row.latitude, row.longitude);
    const location = WAREHOUSE.exec(place)?.[1] ?? (point ? place : '');
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = torrestirStage(description);
    scans.push({ local, index, event: {
      local_time: local, description,
      ...(location ? { location, ...(point ? { point } : {}) } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans of one clock keep the page's order, the later one newer.
  scans.sort((a, b) => b.local.localeCompare(a.local) || b.index - a.index);
  const events = scans.map((scan) => scan.event);
  const newest = scans[0]!.local;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const final = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: newest,
    // The estimate stays on the page after the delivery.
    expected_delivery: final ? null : estimateDay(estimate, newest),
    events,
  };
}
