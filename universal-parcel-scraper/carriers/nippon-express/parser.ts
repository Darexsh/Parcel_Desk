import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { nipponExpressStage } from './status.js';

export const PROVIDER = 'Nippon Express';
// The list page is about 3 kB.
export const NIPPON_EXPRESS_MAX_BYTES = 200_000;
export const NIPPON_EXPRESS_ZONE = 'Asia/Tokyo';

// The tracker's own check: eight to fourteen digits, the last of which is the
// rest of the others divided by seven or by nine.
const NUMBER = /^\d{8,14}$/;
// "12/28 19:45": month, day and clock, without a year.
const CLOCK = /^(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})$/;
const ABSENT = /^指定された伝票番号\((\d{1,20})\)は存在しません。$/;
const NO_DATA = '該当データ無し';
const WRONG_NUMBER = '送り状番号違い';
const HEADERS = ['お問い合せ伝票番号', '最新状況', '受付日', 'お届け指定日', '扱区分'];
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Access Denied|Request Rejected|403 Forbidden|Attention Required|Just a moment)|awsWafCookieDomainList|AwsWafIntegration|_cf_chl_opt|The requested URL was rejected/i;
const MAX_ROWS = 20;
// A leap day needs up to four years back.
const YEARS_BACK = 4;

function checked(number: string): boolean {
  return hasMod7CheckDigit(number) || Number(number.slice(0, -1)) % 9 === Number(number.at(-1));
}

/** A slip number as the tracker takes it: digits only, without hyphens, with its check digit. */
export function normalizeNipponExpressNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw.normalize('NFKC'));
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Nippon Express tracks slip numbers of eight to fourteen digits');
  if (!checked(number)) throw new InvalidInputError(PROVIDER, 'The Nippon Express slip number check digit does not match');
  return number;
}

/** A cell's text, line by line: the list separates a status from its clock with a line break. */
function lines($: CheerioAPI, cell: Cheerio<Element>): string[] {
  const parts = [''];
  cell.contents().each((_, node) => {
    if ($(node).is('br')) parts.push('');
    else parts[parts.length - 1] += $(node).text();
  });
  return parts.map(part => clean(part, 200)).filter(Boolean);
}

/**
 * The status's clock, read in Tokyo. The list gives a month, a day and a
 * clock without a year: the year is the latest that puts the clock no later
 * than the day after the lookup in Japan.
 */
function statusTime(text: string, now: number): string {
  const match = CLOCK.exec(text);
  if (!match) throw new SchemaError(PROVIDER, 'Nippon Express returned a status clock it cannot read');
  const [month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number];
  // Luxon rolls 24:00 over to the next day.
  if (hour > 23) throw new SchemaError(PROVIDER, 'Nippon Express returned an invalid status clock');
  const latest = DateTime.fromMillis(now, { zone: NIPPON_EXPRESS_ZONE }).plus({ days: 1 });
  for (let year = latest.year; year >= latest.year - YEARS_BACK; year -= 1) {
    const wall = firstOccurrence(DateTime.fromObject({ year, month, day, hour, minute }, { zone: NIPPON_EXPRESS_ZONE }));
    if (wall.isValid && wall.toMillis() <= latest.toMillis()) return wall.toUTC().toISO({ suppressMilliseconds: true });
  }
  throw new SchemaError(PROVIDER, 'Nippon Express returned an invalid status clock');
}

/**
 * The tracker's list for the slip numbers asked: one row each, with the
 * number, the latest status and its clock, the acceptance day, the delivery
 * day the sender designated and the service. A number it does not hold gets a
 * sentence naming it instead, and a reason.
 */
export function parseNipponExpress(html: string, raw: string, now = Date.now()): CarrierResult {
  const number = normalizeNipponExpressNumber(raw);
  const $ = load(html);
  const tables = $('table.listtabale');
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'Nippon Express tracking page changed');
  if (!tables.length) {
    // The page the tracker shows when its session is lost or the lookup failed.
    if (clean($('.error_font').text())) throw new IndeterminateError(PROVIDER, 'Nippon Express answered with an error page');
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Nippon Express answered with a block page');
    if ($('input[name="denpyoNo1"]').length) throw new IndeterminateError(PROVIDER, 'Nippon Express returned its search form');
    throw new SchemaError(PROVIDER, 'Nippon Express did not return a tracking list');
  }
  const rows = tables.find('tr');
  const headers = rows.first().children('th').map((_, cell) => clean($(cell).text(), 40)).get();
  if (headers.length !== 6 || HEADERS.some((header, index) => headers[index + 1] !== header)) {
    throw new SchemaError(PROVIDER, 'Nippon Express tracking list changed');
  }
  const data = rows.slice(1);
  if (data.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Nippon Express returned too many rows');
  if (!data.length) throw new IndeterminateError(PROVIDER, 'Nippon Express listed no row for the number');
  const named = data.toArray().map(row => {
    const cells = $(row).children('td');
    if (cells.length !== 6) throw new SchemaError(PROVIDER, 'Nippon Express tracking row changed');
    const links = cells.eq(1).find('a');
    if (links.length > 1) throw new SchemaError(PROVIDER, 'Nippon Express tracking row changed');
    if (links.length) return { cells, shown: clean(links.text(), 40), found: true };
    const absent = ABSENT.exec(clean(cells.eq(1).text(), 120));
    if (!absent) throw new SchemaError(PROVIDER, 'Nippon Express did not name the number');
    return { cells, shown: absent[1]!, found: false };
  });
  // Only one number is asked, so every row has to name it.
  if (named.some(entry => entry.shown !== number)) throw new SchemaError(PROVIDER, 'Nippon Express answered for another number');
  // A slip number can be used again; the list then has a row for each shipment.
  if (named.length > 1) throw new IndeterminateError(PROVIDER, 'Nippon Express lists more than one shipment under the number');
  const { cells, found } = named[0]!;

  if (!found) {
    const reason = clean(cells.eq(3).text(), 80);
    if (reason === NO_DATA) throw new NotFoundError(PROVIDER);
    if (reason === WRONG_NUMBER) throw new InvalidInputError(PROVIDER, 'Nippon Express does not issue this slip number', { reason: 'wrong_number' });
    throw new IndeterminateError(PROVIDER, 'Nippon Express gave another reason for the number');
  }
  const href = cells.eq(1).find('a').attr('href') ?? '';
  const linked = /[?&]okurijoNum=(\d+)/.exec(href)?.[1];
  if (linked !== undefined && linked !== number) throw new SchemaError(PROVIDER, 'Nippon Express linked another number');

  // The status, then its clock on the next line.
  const status = lines($, cells.eq(2));
  if (!status.length || status.length > 2 || /^\d{1,4}\//.test(status[0]!)) throw new SchemaError(PROVIDER, 'Nippon Express status layout changed');
  const wording = status[0]!;
  const lastUpdate = status[1] ? statusTime(status[1], now) : null;
  const service = clean(cells.eq(5).text().normalize('NFKC'), 80);
  const stage = nipponExpressStage(wording);
  // The acceptance day and the designated delivery day come without a year
  // and bound nothing, so they are not kept.
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: wording,
    last_update: lastUpdate,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    timezone: NIPPON_EXPRESS_ZONE,
    summary_only: true,
    // A summary is no scan of its own.
    events: [],
  };
}
