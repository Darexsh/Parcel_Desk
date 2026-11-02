import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { rexStage } from './status.js';

export const PROVIDER = 'REX Indonesia';
export const REX_MAX_BYTES = 512 * 1024;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|verify (?:that )?you are human/i;

export function rexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^(?:\d{12}|\d{14})$/.test(number)) throw new InvalidInputError(PROVIDER, 'REX Indonesia needs its complete air waybill');
  return number;
}

function clock(day: string, time: string): string | null {
  if (!day && !time) return null; // Undated template milestones are not completed scans.
  const parts = /^(\d{2})-(\d{2})-(\d{4})$/.exec(day);
  const date = parts ? calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1])) : null;
  if (!date || Number(parts?.[3]) < 1000 || (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new SchemaError(PROVIDER, 'REX Indonesia returned an invalid milestone clock');
  }
  return time ? `${date}T${time}` : date;
}

/** A single server-rendered milestone view, with its own whole consignment heading. */
export function parseRex(html: string, raw: string): CarrierResult {
  const number = rexNumber(raw);
  if (new TextEncoder().encode(html).byteLength > REX_MAX_BYTES) throw new SchemaError(PROVIDER, 'REX Indonesia returned an oversized page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'REX Indonesia answered with browser verification');
  const $ = load(html), area = $('.nextPage');
  if (area.length !== 1) throw new SchemaError(PROVIDER, 'REX Indonesia returned no unique tracking area');
  const tables = area.find('table.table.table-hover.table-bordered').filter((_, table) => /^No Konosemen\s*:/i.test($(table).find('thead').children('tr').first().text().trim()));
  const notices = area.find('.alert.alert-danger');
  if (notices.length) {
    if (notices.length !== 1 || tables.length) throw new SchemaError(PROVIDER, 'REX Indonesia returned conflicting results');
    const missing = /^Data Not Found for Konosemen Number (.+)\.$/.exec(notices.text().replace(/\s+/g, ' ').trim());
    if (missing && normalizeTrackingNumber(missing[1]!) === number) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'REX Indonesia returned an unrecognized tracking notice');
  }
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'REX Indonesia returned no unique milestone view');
  const table = tables.first(), headers = table.children('thead').children('tr');
  const identity = /^No Konosemen\s*:\s*(.+)$/i.exec(headers.first().text().trim());
  if (!identity || normalizeTrackingNumber(identity[1]!) !== number) throw new IndeterminateError(PROVIDER, 'REX Indonesia answered another waybill');
  if (headers.length !== 2 || headers.eq(1).children('td').toArray().map(cell => clean($(cell).text())).join('|') !== 'Status|Date|Time') {
    throw new SchemaError(PROVIDER, 'REX Indonesia changed its milestone columns');
  }
  const rows = table.children('tbody').children('tr');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > 100) throw new SchemaError(PROVIDER, 'REX Indonesia returned excessive milestones');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 3 || cells.toArray().some(cell => $(cell).text().length > 1000)) throw new SchemaError(PROVIDER, 'REX Indonesia returned an invalid milestone');
    const local = clock(cells.eq(1).text().trim(), cells.eq(2).text().trim());
    if (!local) continue;
    const rawDescription = clean(cells.eq(0).text());
    let description: string, location = '';
    // The delivery label appends a signatory. Project the label, never their name.
    if (/^Diterima Oleh\s*:/i.test(rawDescription)) description = 'Diterima';
    else {
      const place = /^(Asal|Tujuan)\s+(.+)$/i.exec(rawDescription);
      if (place) { description = /^asal$/i.test(place[1]!) ? 'Asal' : 'Tujuan'; location = clean(place[2], 160); }
      else if (rawDescription === 'Dikirim ke Pelanggan') description = rawDescription;
      else throw new SchemaError(PROVIDER, 'REX Indonesia returned an unrecognized milestone label');
    }
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = rexStage(description);
    events.push({ local_time: local, description, ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const railOrder: Readonly<Record<string, number>> = { Asal: 0, Tujuan: 1, 'Dikirim ke Pelanggan': 2, Diterima: 3 };
  events.sort((a, b) => {
    const day = b.local_time!.slice(0, 10).localeCompare(a.local_time!.slice(0, 10));
    if (day) return day;
    if (a.local_time!.length > 10 && b.local_time!.length > 10 && a.local_time !== b.local_time) return b.local_time!.localeCompare(a.local_time!);
    // A day-only reached delivery follows earlier rail stages without inventing an hour.
    return railOrder[b.description!]! - railOrder[a.description!]!;
  });
  const newest = events[0]!, staged = rexStage(newest.description!);
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown', ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time!, expected_delivery: null,
    // The page exposes a milestone rail rather than the detailed operational scan log.
    history_truncated: true, events };
}
