import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { horozStage } from './status.js';

export const PROVIDER = 'Horoz Lojistik';
export const CARRIER = 'horoz';
// A delivery note with a long movement list is under thirty kilobytes.
export const HOROZ_MAX_BYTES = 512 * 1024;

const NUMBER = /^\d{14}$/;
const HEADINGS = ['İşlem', 'Giriş/Çıkış Merkezi', 'Tarihi', 'Plaka', 'Varış Merkezi', 'İşlem Tarihi'];
// "14.03.2026 16:27:05": the movement's clock, with seconds.
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
// The page posts back to itself, so its form names the number it was opened with.
const FORM_ACTION = /^\.\/frmAtfDetay\.aspx\?Ptn=([^&#]*)$/;
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|The requested URL was rejected|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_ROWS = 500;
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

/** A number for Horoz Lojistik's tracker; anything else is not one it issues. */
export function normalizeHorozNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Horoz Lojistik numbers are fourteen digits');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

/** A movement's date and second as one wall time. The page gives no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = match ? DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]) }, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed?.isValid || parsed.year < 2000 || parsed.toFormat('dd.MM.yyyy HH:mm:ss') !== text) {
    throw new SchemaError(PROVIDER, 'Horoz Lojistik returned an invalid movement time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The delivery date the note expects, as a calendar day, when it gives a real one. */
function expectedDay(text: string): string | null {
  const match = DAY.exec(text);
  const parsed = match ? DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) }, { zone: 'UTC' }) : null;
  return parsed?.isValid && parsed.year >= 2000 && parsed.toFormat('dd.MM.yyyy') === text ? parsed.toISODate() : null;
}

/**
 * The delivery note (ATF) Horoz Lojistik's tracker shows at
 * `frmAtfDetay.aspx?Ptn={number}`: a headline status, the note's details,
 * the masked sender and recipient, and a table of movements, oldest first.
 * Each movement is a departure from or an arrival at a centre, with its
 * clock; a delivered parcel's last row is the delivery. A number the tracker
 * does not know gets the same page with every field empty and no table.
 *
 * The page's form must name the whole number asked. The masked names, the
 * provinces and addresses, the waybill, the vehicle plates, the destination
 * centres and the record clocks are not read.
 */
export function parseHoroz(html: string, raw: string): CarrierResult {
  const number = normalizeHorozNumber(raw);
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Horoz Lojistik answered with a browser check');
  const $ = load(html);
  const forms = $('form#form1');
  const action = forms.length === 1 ? FORM_ACTION.exec(forms.attr('action') ?? '') : null;
  const note = $('span#lblatfno');
  if (!action || note.length !== 1 || $('span#LblBaslik').length !== 1) throw new SchemaError(PROVIDER, 'Horoz Lojistik returned an unexpected page');
  let asked: string;
  try {
    asked = decodeURIComponent(action[1]!);
  } catch {
    throw new SchemaError(PROVIDER, 'Horoz Lojistik returned an unexpected page');
  }
  if (asked !== number) throw new IndeterminateError(PROVIDER, 'Horoz Lojistik answered for another shipment');

  const tables = $('table#grdAtfHareket');
  if (!clean(note.text(), 40)) {
    // Empty fields and no movements are the answer for an unknown number.
    if (!tables.length) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Horoz Lojistik returned movements without a delivery note');
  }
  if (!tables.length) throw new NoHistoryError(PROVIDER);
  const rows = tables.length === 1 ? tables.find('tr') : null;
  const headings = rows?.first().children('td').map((_, element) => clean($(element).text(), 40)).get() ?? [];
  if (!rows || headings.join('|') !== HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'Horoz Lojistik history layout changed');
  if (rows.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, 'Horoz Lojistik returned an oversized history');

  const seen = new Set<string>();
  const movements: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.slice(1).each((index, element) => {
    const cells = $(element).children('td');
    if (cells.length !== HEADINGS.length) throw new SchemaError(PROVIDER, 'Horoz Lojistik returned an invalid movement');
    const description = clean(cells.eq(0).text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Horoz Lojistik returned a movement without wording');
    const centre = clean(cells.eq(1).text(), 200);
    const local = wallClock(clean(cells.eq(2).text(), 60));
    // A row the page lists twice is kept once.
    const identity = JSON.stringify([local, description, centre]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = horozStage(description);
    movements.push({ local, index, event: {
      local_time: local,
      description,
      ...(centre ? { location: centre } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  if (!movements.length) throw new NoHistoryError(PROVIDER);
  // Newest first; of equal clocks, the row further down the page is the newer.
  movements.sort((left, right) => right.local.localeCompare(left.local) || right.index - left.index);
  const events = movements.map(({ event }) => event);

  const newest = events[0]!;
  // The headline sums the note up; without a stage of its own, the newest staged movement stands.
  const headline = clean($('span#LblBaslik').text(), 200);
  const summary = headline ? horozStage(headline) : null;
  const latest = events.find((event) => event.stage);
  const current = summary ?? (latest ? { stage: latest.stage!, source: latest.stage_source! } : null);
  const stage = current?.stage as Stage | undefined;
  const expected = stage && FINAL.has(stage) ? null : expectedDay(clean($('span#lblolasiteslimtarihi').text(), 40));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.source } : {}),
    last_status_text: headline || newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    events,
  };
}
