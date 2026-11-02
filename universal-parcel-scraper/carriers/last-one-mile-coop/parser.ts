import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, decodeText } from '../../core/transport/index.js';
import { lastOneMileMappedStage, lastOneMileStage } from './status.js';

export const PROVIDER = 'Last One Mile Co-op';
// A page is about 10 kB.
export const LAST_ONE_MILE_MAX_BYTES = 512 * 1024;
/** Every centre and member company is in Japan, and the page prints its wall clock without a zone. */
export const LAST_ONE_MILE_ZONE = 'Asia/Tokyo';
/** The co-op's own form on Yamato System Development's shared tracker. */
export const LAST_ONE_MILE_FORM = { cd: '81118', id: '02116' } as const;
// Twelve digits, the last of which is the rest of the first eleven divided by seven.
const NUMBER = /^\d{12}$/;
// Bot checks and firewall refusals a CDN or the site's balancer could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied|Request Rejected)|g-recaptcha|h-captcha|The requested URL was rejected/i;
const NOT_FOUND = '送り状番号未登録';
const HISTORY_HEADINGS = ['貨物状況', '日付/時刻', '企業名/委託先企業名', '営業所名', '送り状番号/委託送り状番号'];
// The heading over a parcel's details: "1件目 送り状番号 {number}".
const DETAIL_HEADING = /^\d+件目 送り状番号 (\S+)$/;
const DAY = /^\d{4}\/\d{2}\/\d{2}$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
// A parcel's details follow an anchor named after its row in the list and its
// place under that row: A00 for the first number's first parcel.
const DETAIL_ANCHOR = /^A0\d$/;
const MAX_ROWS = 100;

/** A number for the co-op's tracker, printed hyphens removed; anything else is not one it issues. */
export function normalizeLastOneMileNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw.normalize('NFKC')) : '';
  if (!NUMBER.test(number) || !hasMod7CheckDigit(number)) {
    throw new InvalidInputError(PROVIDER, 'Last One Mile Co-op waybills have twelve digits and a check digit');
  }
  return number;
}

/**
 * The page in the charset its Content-Type or its meta tag declares. The
 * tracker declares Shift_JIS.
 */
export function decodeLastOneMilePage(bytes: Uint8Array, contentType: string | null): string {
  const declared = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1]
    ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 4096)))?.[1]
    ?? 'utf-8';
  try {
    return decodeText(bytes, declared);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Last One Mile Co-op declared a charset that cannot be read', { cause });
  }
}

type Selection = ReturnType<CheerioAPI>;

/** A cell's lines, which the page separates with line breaks; full-width letters and digits as ASCII. */
function lines($: CheerioAPI, cell: Selection): string[] {
  const copy = $(cell.toArray()[0]).clone();
  copy.find('br').replaceWith('\n');
  return copy.text().split('\n').map((line) => clean(line.normalize('NFKC'), 120)).filter(Boolean);
}

/** A row's clock, a day and a time to the second: an instant in Japan's zone. */
function scanTime(day: string | undefined, clock: string | undefined): string {
  const wall = `${(day ?? '').replace(/\//g, '-')}T${clock}`;
  const parsed = day && clock && DAY.test(day) && CLOCK.test(clock)
    ? zonedTime(`${day} ${clock}`, 'yyyy/MM/dd HH:mm:ss', LAST_ONE_MILE_ZONE)
    : null;
  // Only a clock that reads back unchanged is kept: Luxon would roll 24:00 over to the next day.
  if (!parsed || parsed.iso.slice(0, 19) !== wall) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned an invalid scan time');
  return parsed.iso;
}

/**
 * The history table: one row per state, oldest first, with its day and time,
 * the companies, the office and the waybill numbers. Each row must name the
 * number asked. The companies and the member company's waybill number are not
 * kept. Newest first.
 */
function eventsOf($: CheerioAPI, table: Selection, number: string): CarrierEvent[] {
  const rows = table.children('tbody').children('tr').toArray().slice(1);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned an oversized history');
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const cells = $(row).children('td');
    if (cells.length !== HISTORY_HEADINGS.length) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned an invalid history row');
    const [description, ...more] = lines($, cells.eq(0));
    const [day, clock, ...rest] = lines($, cells.eq(1));
    const office = lines($, cells.eq(3));
    const [shown] = lines($, cells.eq(4));
    if (!description || more.length || rest.length || office.length > 1) {
      throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned an invalid history row');
    }
    if (!shown) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned a history row without its number');
    if (shown !== number) throw new IndeterminateError(PROVIDER, 'Last One Mile Co-op answered for another shipment');
    const staged = lastOneMileStage(description);
    events.push({ time: scanTime(day, clock), ...(office[0] ? { location: office[0] } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  return events.reverse();
}

/** The table of a parcel's history, found by its headings. */
function historyTable($: CheerioAPI, detail: Selection): Selection | null {
  const tables = detail.find('table').filter((_, table) => {
    const headings = $(table).children('tbody').children('tr').first().children('td').toArray()
      .map((cell) => lines($, $(cell)).join(''));
    return headings.join('|') === HISTORY_HEADINGS.join('|');
  });
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned two histories for one parcel');
  return tables.length ? tables.first() : null;
}

/**
 * The co-op's page on Yamato System Development's tracker,
 * `inqservlet?cd=81118&id=02116&number01={number}`, which the tracker renders
 * on its server. A list has one row for each number asked, with the number,
 * the day of its latest state and that state; a number it does not know gets
 * "送り状番号未登録" as its state. Below the list, each parcel found has its
 * details under its anchor: a heading naming the number, a sentence for the
 * state, the delivery day, the parcel count and the weight, and the history.
 * The list's row and the details must name the number asked. The delivery
 * day and the weight, which the page leaves empty, the parcel count, the
 * companies, the offices' contact links and the drop-off button are not kept.
 */
export function parseLastOneMile(html: string, raw: string): CarrierResult {
  const number = normalizeLastOneMileNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Last One Mile Co-op answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const field = $('input[name="number01"]');
  if (field.length !== 1) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned an unexpected page');
  const form = field.closest('form');
  if (form.find('input[name="cd"]').attr('value') !== LAST_ONE_MILE_FORM.cd || form.find('input[name="id"]').attr('value') !== LAST_ONE_MILE_FORM.id) {
    throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned another company’s tracking page');
  }
  const cells = field.closest('tr').children('td');
  if (cells.length < 5) throw new SchemaError(PROVIDER, 'Last One Mile Co-op changed its tracking list');
  const listed = lines($, cells.eq(2)).join('');
  const state = lines($, cells.eq(4)).join(' ');
  if (!listed) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned a list without the number');
  if (listed !== number) throw new IndeterminateError(PROVIDER, 'Last One Mile Co-op answered for another shipment');

  const anchors = $('a[name]').filter((_, anchor) => DETAIL_ANCHOR.test($(anchor).attr('name') ?? ''));
  if (!anchors.length) {
    if (state === NOT_FOUND) throw new NotFoundError(PROVIDER, 'Last One Mile Co-op has no record of this waybill');
    if (!state) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned a list without the state');
    throw new IndeterminateError(PROVIDER, 'Last One Mile Co-op did not complete the lookup');
  }
  // A waybill number can come round again; the details would then list each parcel.
  if (anchors.length > 1) throw new IndeterminateError(PROVIDER, 'Last One Mile Co-op lists more than one parcel under the waybill');
  if (!state || state === NOT_FOUND) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned details without a state');
  const detail = anchors.first().next('table');
  const heading = DETAIL_HEADING.exec(lines($, detail.children('tbody').children('tr').first()).join(' '));
  if (!detail.length || !heading) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned details without their number');
  if (heading[1] !== number) throw new IndeterminateError(PROVIDER, 'Last One Mile Co-op answered for another shipment');
  const table = historyTable($, detail);
  if (!table) throw new SchemaError(PROVIDER, 'Last One Mile Co-op returned a parcel without its history');

  const events = eventsOf($, table, number);
  const newest = events[0];
  // The list's state is the co-op's current one; the newest staged row decides only a state the map does not know.
  const mapped = lastOneMileMappedStage(state);
  const scanned = events.find((event) => event.stage);
  const stage = (mapped ?? scanned?.stage) as Stage | undefined;
  const source = mapped ? 'carrier_map' : scanned?.stage_source;
  if (!newest && !mapped) throw new NoHistoryError(PROVIDER);
  const delivered = stage === 'delivered' && newest?.stage === 'delivered' ? newest.time : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: state,
    last_update: newest?.time ?? null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    timezone: LAST_ONE_MILE_ZONE,
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
