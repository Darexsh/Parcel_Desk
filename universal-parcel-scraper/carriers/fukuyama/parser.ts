import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, zonedTime } from '../../core/time/index.js';
import { clean, decodeText } from '../../core/transport/index.js';
import { fukuyamaMappedStage, fukuyamaStage } from './status.js';

export const PROVIDER = 'Fukuyama Transporting';
// A page is about 25 kB.
export const FUKUYAMA_MAX_BYTES = 512 * 1024;
/** Every branch is in Japan, and the pages print its wall clock without a zone. */
export const FUKUYAMA_ZONE = 'Asia/Tokyo';
// The tracking form's own rule: ten or eleven digits.
const NUMBER = /^\d{10,11}$/;
// Bot checks and firewall refusals a CDN or the site's balancer could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const NOT_FOUND = '該当データはありません。';
// The form's warning for a number it does not take: half-width digits only, ten or eleven of them.
const REFUSED = 'お問い合わせ番号は半角数字で入力してください。';
const HISTORY_HEADINGS = ['', '年月日', '支店名', '支店電話番号'];
// A history row's day, with the minute it happened except on the dispatch row.
const CLOCK = /^(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2}))?$/;
const WEIGHT = /^(\d{1,6}(?:\.\d{1,3})?) ?kg$/i;
const MAX_ROWS = 50;

/** A number for Fukuyama's tracker, printed hyphens removed; anything else is not one it issues. */
export function normalizeFukuyamaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Fukuyama Transporting numbers have ten or eleven digits');
  return number;
}

/**
 * The page in the charset it declares: its Content-Type's, else its own meta
 * tag's. The tracker declares Shift_JIS.
 */
export function decodeFukuyamaPage(bytes: Uint8Array, contentType: string | null): string {
  const declared = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1]
    ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 4096)))?.[1]
    ?? 'utf-8';
  try {
    return decodeText(bytes, declared);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Fukuyama Transporting declared a charset that cannot be read', { cause });
  }
}

type Selection = ReturnType<CheerioAPI>;

/** The summary's cells by their label, without the colon some labels end with. */
function summaryFields($: CheerioAPI, table: Selection): Map<string, Selection> {
  const fields = new Map<string, Selection>();
  for (const column of table.find('.p-recieve_detail_table_col').toArray()) {
    const label = $(column).children('.p-recieve_detail_table_th');
    const cell = $(column).children('.p-recieve_detail_table_td');
    const name = clean(label.text(), 40).replace(/[：:]$/, '');
    if (label.length !== 1 || cell.length !== 1 || !name || fields.has(name)) {
      throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned an invalid shipment summary');
    }
    fields.set(name, cell);
  }
  return fields;
}

/** A row's clock: an instant in Japan's zone, or the day alone when the row has no time. */
function scanClock(text: string): { time: string } | { local_time: string } {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned an invalid scan time');
  if (match[4] === undefined) return { local_time: day };
  const wall = `${day}T${match[4]}:${match[5]}`;
  const parsed = zonedTime(`${day} ${match[4]}:${match[5]}`, 'yyyy-MM-dd HH:mm', FUKUYAMA_ZONE);
  // Only a clock that reads back unchanged is kept: Luxon would roll 24:00 over to the next day.
  if (!parsed || parsed.iso.slice(0, 16) !== wall) throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned an invalid scan time');
  return { time: parsed.iso };
}

/**
 * The history table, one fixed row per milestone in the order a parcel reaches
 * them: its name, the day and minute, the branch and the branch's phone
 * number. A milestone not reached yet has no day and is left out; the phone
 * number is not kept. Newest first.
 */
function eventsOf($: CheerioAPI, main: Selection): CarrierEvent[] {
  const tables = main.find('.c-table_stripe table');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned a shipment without its history');
  const headings = tables.find('thead th').toArray().map((heading) => clean($(heading).text(), 40));
  if (headings.join('|') !== HISTORY_HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'Fukuyama Transporting changed its history table');
  const rows = tables.find('tbody > tr').toArray();
  if (!rows.length || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned an invalid history');
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const cells = $(row).children('td');
    const description = clean(cells.eq(0).text(), 80);
    if (cells.length !== HISTORY_HEADINGS.length || !description) {
      throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned an invalid history row');
    }
    const clock = clean(cells.eq(1).text(), 40);
    if (!clock) continue;
    const location = clean(cells.eq(2).text(), 120);
    const staged = fukuyamaStage(description);
    events.push({ ...scanClock(clock), ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  return events.reverse();
}

/** The weight the summary shows, in kilograms; none when it shows none. */
function weightOf(cell: Selection | undefined): number | null {
  const match = WEIGHT.exec(clean(cell?.text(), 40));
  const kilograms = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : null;
}

/** The search form the tracker answers a number it refuses with, echoing that number. */
function refusal($: CheerioAPI, main: Selection, number: string): never {
  const warned = main.find('.c-form_warning_text').toArray().some((line) => clean($(line).text(), 100) === REFUSED);
  const echoed = clean(main.find('form input[name="data[TrackingNo][tracking_no]"]').attr('value'), 64);
  if (warned && echoed === number) throw new InvalidInputError(PROVIDER, 'Fukuyama Transporting does not take this number', { reason: 'wrong_number' });
  throw new SchemaError(PROVIDER, 'Fukuyama Transporting answered with its search form');
}

/**
 * The tracker's page for one number, `/corp/recieve/tracking_no_hunt/{number}`,
 * which the site renders on its server: a summary with the number, the parcel
 * count, the weight and the current state, then the history and the branches
 * it names. The page prints the number as eleven digits in groups, padding a
 * ten-digit one with a leading zero, and it must be the number asked. A number
 * it does not know gets "該当データはありません。" in place of the state. The
 * parcel count, the branches' phone numbers and addresses, the delivery
 * estimate and the links to the waybill images are not kept.
 */
export function parseFukuyama(html: string, raw: string): CarrierResult {
  const number = normalizeFukuyamaNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Fukuyama Transporting answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const main = $('main');
  if (main.length !== 1) throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned an unexpected page');
  const tables = main.find('.p-recieve_detail_table');
  if (!tables.length && main.find('form#tracking_no_huntForm').length === 1) refusal($, main, number);
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned a page without a shipment summary');
  const fields = summaryFields($, tables);

  const shown = clean(fields.get('お問い合わせ番号')?.text(), 40);
  if (!/^[\d-]{10,16}$/.test(shown)) throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned a shipment without its number');
  if (shown.replace(/-/g, '') !== number.padStart(11, '0')) throw new IndeterminateError(PROVIDER, 'Fukuyama Transporting answered for another shipment');
  const answer = fields.get('照会結果');
  const state = fields.get('現在の配達状況');
  if (answer && !state) {
    if (clean(answer.text(), 100) === NOT_FOUND) throw new NotFoundError(PROVIDER, 'Fukuyama Transporting has no data for this number');
    throw new IndeterminateError(PROVIDER, 'Fukuyama Transporting did not complete the lookup');
  }
  const summary = clean(state?.text(), 120);
  if (answer || !summary) throw new SchemaError(PROVIDER, 'Fukuyama Transporting returned a shipment without its state');

  const events = eventsOf($, main);
  const newest = events[0];
  // The summary is the carrier's current state; the newest staged row decides only a state the map does not know.
  const listed = fukuyamaMappedStage(summary);
  const scanned = events.find((event) => event.stage);
  const stage = (listed ?? scanned?.stage) as Stage | undefined;
  const source = listed ? 'carrier_map' : scanned?.stage_source;
  if (!newest && !listed) throw new NoHistoryError(PROVIDER);
  const weight = weightOf(fields.get('重量'));
  const delivered = stage === 'delivered' && newest?.stage === 'delivered' && typeof newest.time === 'string' ? newest.time : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: summary,
    last_update: typeof newest?.time === 'string' ? newest.time : null,
    last_update_local: typeof newest?.local_time === 'string' ? newest.local_time : null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    timezone: FUKUYAMA_ZONE,
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
