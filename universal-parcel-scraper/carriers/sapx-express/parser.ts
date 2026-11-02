import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { sapxStage } from './status.js';

export const PROVIDER = 'SAPX Express';
// A long history is about 90 kB of page, most of it the site's menus.
export const SAPX_MAX_BYTES = 1024 * 1024;
// Letters and digits with at least one digit: a branch or client code and
// eleven or thirteen digits, or a Tokopedia booking code.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,24}$/;
// A Tokopedia booking code, which the tracker holds with its dash.
const TOKOPEDIA = /^TKP01([A-Z0-9]{8})$/;
const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, MEI: 5, JUN: 6, JUL: 7, AUG: 8, AGU: 8, AGT: 8, SEP: 9, OCT: 10, OKT: 10, NOV: 11, DEC: 12, DES: 12,
};
// "06 Apr 2026 | 17:56": a day, a month, a year and a clock.
const CLOCK = /^(\d{1,2}) ([A-Z]{3}) (\d{4}) \| (\d{1,2}):(\d{2})$/i;
const NOT_FOUND = /Nomor Resi Anda Tidak Ditemukan/i;
// A firewall or bot check's page in place of the tracker's.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|AwsWafIntegration/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A SAPX resi in capitals, as the tracker matches it; anything else is not one SAPX issues. */
export function normalizeSapxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SAPX resi numbers are eight to twenty-four letters and digits');
  return number;
}

/** The form the tracker holds a number under: a Tokopedia booking code gets its dash back. */
export function sapxLookupNumber(raw: string): string {
  const number = normalizeSapxNumber(raw);
  const booking = TOKOPEDIA.exec(number);
  return booking ? `TKP01-${booking[1]}` : number;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** An event's wall clock, to the minute: the page names no zone, so no offset is assigned. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const month = match ? MONTHS[match[2]!.toUpperCase()] : undefined;
  const [hour, minute] = match ? [Number(match[4]), Number(match[5])] : [0, 0];
  const date = match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
  if (!date || hour > 23 || minute > 59) throw new SchemaError(PROVIDER, 'SAPX returned an invalid event time');
  return `${date}T${pad(hour)}:${pad(minute)}:00`;
}

// A run of eight or more digits, as phone numbers are written.
const PHONE = /\+?\d(?:[\s().-]{0,2}\d){7,}/g;
// Who took the parcel, after the delivery heading: "Paket Telah Diterima oleh … (Penerima Langsung)".
const RECEIVER = /\s*\boleh\b[\s\S]*$/i;
// A failed or completed run's remark: "[kurir: …] [penerima: …] [hub: …] [status: Undelivered - N1 - Sulit Ditemui] - Keterangan: …".
const RUN_STATUS = /\[status:\s*(Undelivered|Delivered)\s*-\s*([A-Z]{1,2}\d{0,2})\s*-\s*([^\]]*)\]/i;
const REASON = /^[\p{L} ]{1,40}$/u;
// The office a heading or a check-in remark names: "Sampai di Kantor Cabang Medan", "Keterangan: Kantor Cabang Jakarta Barat".
const OFFICE = /^(?:Sampai di|Keluar dari|Keterangan:) Kantor (?:Cabang )?(.+)$/i;
// The head office, the next hub and a branch without its name are no place.
const NO_PLACE = /^(?:Pusat|Hub|Cabang)\b/i;

/** A heading without who took the parcel and without phone numbers. */
function heading(text: string): string {
  const own = /\bditerima\b/i.test(text) ? text.replace(RECEIVER, '') : text;
  return clean(own.replace(PHONE, ''), 200).replace(/[\s,;:\-–]+$/, '');
}

/** The office an event names, unless it is the head office or the next hub. */
function office(text: string): string {
  const name = clean(OFFICE.exec(clean(text, 200))?.[1] ?? '', 80);
  return name && !NO_PLACE.test(name) && !/\d{4}/.test(name) ? name : '';
}

/**
 * One event: its clock, its heading and the remark under it. The remark
 * names the courier, the receiver and the courier's own words, none of which
 * is kept; a failed run keeps its reason's code and label, and a check-in
 * keeps the office it names as the event's place.
 */
function eventOf(content: Cheerio<AnyNode>): CarrierEvent {
  const lines = content.children('h4');
  const remarks = content.children('p');
  if (lines.length !== 2 || remarks.length > 1) throw new SchemaError(PROVIDER, 'SAPX event layout changed');
  const local = wallClock(clean(lines.eq(0).text(), 60));
  const title = heading(clean(lines.eq(1).text(), 400));
  if (!title) throw new SchemaError(PROVIDER, 'SAPX returned an event without wording');
  const remark = clean(remarks.text(), 400);
  const run = RUN_STATUS.exec(remark);
  const reason = run && /^undelivered$/i.test(run[1]!) ? clean(run[3], 60) : '';
  const description = reason && REASON.test(reason) ? `${title}: ${reason}` : title;
  const location = office(title) || (run ? '' : office(remark));
  const staged = sapxStage(description);
  return {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(run ? { provider_code: run[2]!.toUpperCase() } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The summary table's rows by their label: Layanan, Asal, Tujuan, Status and, once delivered, Diterima Oleh. */
function summary($: CheerioAPI, table: Cheerio<AnyNode>): Map<string, string> {
  const rows = new Map<string, string>();
  table.find('tbody > tr').each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length === 2) rows.set(clean(cells.eq(0).text(), 40).toLowerCase(), clean(cells.eq(1).text(), 200));
  });
  return rows;
}

/**
 * The page `/id/cek-awb/{number}` renders for one resi: a table headed with
 * the number it looked up and the service, origin, destination, status and
 * receiver, then the events, newest first, each with a clock, a heading and a
 * remark. A number it does not hold gets "Mohon Maaf Nomor Resi Anda Tidak
 * Ditemukan." in place of both.
 */
export function parseSapx(html: string, raw: string): CarrierResult {
  const number = normalizeSapxNumber(raw);
  const $ = load(html);
  const table = $('table').filter((_, node) => /^Nomor Resi:/i.test(clean($(node).find('thead th').first().text(), 80)));
  if (!table.length) {
    if (NOT_FOUND.test(clean($('.alert').text(), 400))) throw new NotFoundError(PROVIDER);
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SAPX answered with a browser check');
    throw new SchemaError(PROVIDER, 'SAPX did not return a tracking page');
  }
  if (table.length > 1) throw new SchemaError(PROVIDER, 'SAPX tracking page changed');
  // The tracker echoes the number as it was asked, in any case.
  const shown = clean(table.find('thead th').first().text(), 120).replace(/^Nomor Resi:\s*/i, '');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'SAPX answered for another number');

  const rows = summary($, table);
  const contents = $('.process-detail-tracking .process-step > .process-step-content');
  if (contents.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SAPX returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  contents.each((_, node) => {
    const event = eventOf($(node));
    const identity = JSON.stringify([event.local_time, event.description, event.location, event.provider_code]);
    if (seen.has(identity)) return;
    seen.add(identity);
    events.push(event);
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  // The summary's status only stands in when no event has a stage; it can be cut short.
  const summarized = scanned ? null : sapxStage(heading(rows.get('status') ?? ''));
  const stage = (scanned?.stage ?? summarized?.stage) as Stage | undefined;
  const source = scanned?.stage_source ?? summarized?.source;
  const service = clean(rows.get('layanan'), 60);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && source ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
