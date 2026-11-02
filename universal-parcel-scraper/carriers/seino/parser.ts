import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { seinoCodeStage, seinoMilestoneStage } from './status.js';

export const PROVIDER = 'Seino Transportation';
/** Every branch is in Japan, which keeps one zone all year. */
export const SEINO_ZONE = 'Asia/Tokyo';
// The page is 60 to 75 kB.
export const SEINO_MAX_BYTES = 1_000_000;

const NUMBER = /^\d{10}$/;
// The page's answer for a number it has no shipment under.
const NOT_FOUND = '入力されたお問合せ番号が見当りません';
// Bot checks a CDN or firewall could serve in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|gokuProps|<title>\s*(?:Access Denied|Request Rejected|403 Forbidden)\s*<\/title>/i;
const MAINTENANCE = /メンテナンス中/;
const RECEIPT = /^(\d{1,2})月(\d{1,2})日$/;
const SCAN = /^(\d{1,2})日(\d{1,2})時(\d{1,2})分$/;
const CLOCK = /^\d{14}$/;
const CODE = /^\d{2}$/;
const WEIGHT = /^(\d{1,3}(?:,?\d{3})*(?:\.\d+)?)\s*kg$/i;
// A phone number, with the label the page would put before it.
const PHONE = /(?:TEL|ＴＥＬ|電話)?\s*[:：]?\s*[0-9０-９][0-9０-９()（）‐－ー-]{7,}[0-9０-９]/gi;
// A scan can be stamped a little ahead of the page's own clock.
const SKEW_MS = 3_600_000;
const MAX_ROWS = 20;

type Selection = ReturnType<CheerioAPI>;

/** Seino's inquiry number (お問い合わせ番号): ten digits, printed with or without hyphens. */
export function normalizeSeinoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Seino inquiry numbers have ten digits');
  return number;
}

/**
 * The encoding a reply declares: its Content-Type's charset, else the page's
 * meta tag, else Shift_JIS, which the page declares. The site names it
 * Windows-31J. Anything but Shift_JIS or UTF-8 is a changed reply.
 */
export function seinoPageEncoding(contentType: string | null, bytes: Uint8Array): string {
  const declared = /charset\s*=\s*["']?([\w.:-]{1,40})/i.exec(contentType ?? '')?.[1]
    ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]{1,40})/i.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 4096)))?.[1];
  if (!declared) return 'shift_jis';
  let encoding = '';
  try {
    encoding = new TextDecoder(declared).encoding;
  } catch {
    // An encoding the runtime does not know is a changed reply.
  }
  if (encoding !== 'shift_jis' && encoding !== 'utf-8') throw new SchemaError(PROVIDER, 'Seino answered in an unexpected encoding');
  return encoding;
}

/** A firewall or bot check in place of the page. */
export function assertNotBlocked(html: string): void {
  if (CHALLENGE.test(html.slice(0, 20_000))) throw new ChallengeError(PROVIDER, 'Seino answered with a browser check');
}

function hidden(scope: Selection, name: string): string {
  return clean(scope.find(`input[type="hidden"][name="${name}"]`).first().attr('value') ?? '', 300);
}

/** The page's own clock when it was made, `yyyyMMddHHmmss` in Japan. */
function pageClock(value: string): DateTime {
  const clock = CLOCK.test(value) ? firstOccurrence(DateTime.fromFormat(value, 'yyyyMMddHHmmss', { zone: SEINO_ZONE })) : null;
  if (!clock?.isValid) throw new SchemaError(PROVIDER, 'Seino returned an invalid page clock');
  return clock;
}

/** The receipt day (受付日, "9月30日"): the latest such day up to the page's clock, as a calendar day. */
function receiptDay(value: string, now: DateTime): DateTime {
  const match = RECEIPT.exec(value);
  const month = Number(match?.[1]);
  const day = Number(match?.[2]);
  const year = month < now.month || (month === now.month && day <= now.day) ? now.year : now.year - 1;
  const date = match ? DateTime.fromObject({ year, month, day }, { zone: 'utc' }) : null;
  if (!date?.isValid) throw new SchemaError(PROVIDER, 'Seino returned an invalid receipt date');
  return date;
}

/** The first calendar day on or after `from` that falls on the given day of the month. */
function onOrAfter(from: DateTime, day: number): DateTime | null {
  for (let months = 0; months <= 2; months += 1) {
    const month = from.startOf('month').plus({ months });
    if (day > (month.daysInMonth ?? 0)) continue;
    const date = month.set({ day });
    if (date >= from) return date;
  }
  return null;
}

interface Milestone { label: string; branch: string; day: number; hour: number; minute: number }

/** The detail's milestones that were reached: a label, a branch and a time without month or year. */
function milestones($: CheerioAPI, detail: Selection): Milestone[] {
  const rows = detail.find('tr').toArray().map((row) => $(row)).filter((row) => row.children('td.col1').length > 0);
  if (!rows.length || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Seino returned a changed shipment detail');
  return rows.flatMap((row) => {
    const label = clean(row.children('td.col1').text(), 40).replace(/\s+/g, '');
    const when = clean(row.children('td.col3').text(), 40).replace(/\s+/g, '');
    // A milestone not reached yet shows no time, and sometimes the branch it is planned at.
    if (!when) return [];
    const match = SCAN.exec(when);
    if (!label || !match) throw new SchemaError(PROVIDER, 'Seino returned an invalid milestone');
    return [{ label, branch: clean(row.children('td.col2').text(), 80), day: Number(match[1]), hour: Number(match[2]), minute: Number(match[3]) }];
  });
}

/**
 * Each milestone's instant. The page gives a day of the month and a time, so
 * the month and year come from the receipt day, and each milestone falls on
 * the first such day from the one before it. A milestone after the page's own
 * clock cannot be placed.
 */
function scans(reached: readonly Milestone[], receipt: DateTime, now: DateTime): CarrierEvent[] {
  let cursor = receipt;
  return reached.map((milestone) => {
    const date = onOrAfter(cursor, milestone.day);
    const wall = date ? firstOccurrence(DateTime.fromObject({ year: date.year, month: date.month, day: date.day,
      hour: milestone.hour, minute: milestone.minute }, { zone: SEINO_ZONE })) : null;
    if (!date || !wall?.isValid) throw new SchemaError(PROVIDER, 'Seino returned an invalid milestone time');
    if (wall.toMillis() > now.toMillis() + SKEW_MS) throw new SchemaError(PROVIDER, 'Seino returned a milestone after its own clock');
    cursor = date;
    const stage = seinoMilestoneStage(milestone.label);
    return {
      time: wall.toISO({ suppressMilliseconds: true }),
      ...(milestone.branch ? { location: milestone.branch } : {}),
      description: milestone.label,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  });
}

/** The product (商品) and the weight in kilograms from the table after the detail. */
function goods($: CheerioAPI, detail: Selection): { service_name?: string; weight_kg?: number } {
  const table = detail.nextAll('table[summary="商品情報"]').first();
  const value = (name: string) => clean(table.find('th').filter((_, cell) => clean($(cell).text(), 20) === name).first().next('td').text(), 80);
  const service = value('商品');
  const weight = Number(WEIGHT.exec(value('重量').normalize('NFKC'))?.[1]?.replace(/,/g, '') ?? Number.NaN);
  return { ...(service ? { service_name: service } : {}), ...(Number.isFinite(weight) && weight > 0 ? { weight_kg: weight } : {}) };
}

/**
 * The tracking page after a lookup of one number: a list row that echoes the
 * number with its status, then the shipment's detail with its status code,
 * its milestones and its goods. The branches' phone numbers, the driver's and
 * the vehicle's references, the destination area code and the piece count are
 * never read. The page shows no sender or recipient.
 */
export function parseSeino(html: string, raw: string): CarrierResult {
  const number = normalizeSeinoNumber(raw);
  assertNotBlocked(html);
  const $ = load(html);
  const list = $('form[name="gempyoNoShokaiListForm"] table[summary="お届け状況確認 検索"]');
  if (list.length !== 1) {
    if (MAINTENANCE.test(clean($('body').text(), 4000))) throw new MaintenanceError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Seino returned an unexpected page');
  }
  const row = list.find('input[name="GNPNO1"]').first().closest('tr');
  // The page's own check of the number's shape prints the number followed by エラー, without the echo.
  const refused = /^(.*?)\s*エラー$/.exec(clean(row.children('td.col3').text(), 80));
  if (refused) {
    if (normalizeTrackingNumber(refused[1] ?? '') !== number) throw new IndeterminateError(PROVIDER, 'Seino answered for another number');
    throw new InvalidInputError(PROVIDER, 'Seino refused the number', { reason: 'wrong_number' });
  }
  const echo = row.find('input[name="inputGNPNO1"]');
  if (echo.length !== 1) throw new SchemaError(PROVIDER, 'Seino returned a changed result list');
  if (normalizeTrackingNumber(clean(echo.attr('value'), 64)) !== number) throw new IndeterminateError(PROVIDER, 'Seino answered for another number');
  if (clean(row.children('td.col4').text(), 200).includes(NOT_FOUND)) {
    throw new NotFoundError(PROVIDER, 'Seino has no shipment under this number: unknown, or received over two months ago');
  }

  const details = $('table.package-detail1').toArray().map((table) => $(table))
    .filter((table) => normalizeTrackingNumber(hidden(table, 'gempyoNo')) === number);
  if (details.length !== 1) throw new SchemaError(PROVIDER, 'Seino returned a shipment without its detail');
  const detail = details[0]!;
  const code = hidden(detail, 'haitatsuJokyoCode');
  const wording = clean(hidden(detail, 'haitatsuJokyo').replace(PHONE, ''), 200);
  if (!CODE.test(code) || !wording) throw new SchemaError(PROVIDER, 'Seino returned a shipment without its status');
  const now = pageClock(hidden(detail, 'mapDspDateT'));
  const events = scans(milestones($, detail), receiptDay(hidden(detail, 'uketsukeDate'), now), now).reverse();

  const coded = seinoCodeStage(code);
  const newest = events[0];
  if (!newest && !coded) throw new NoHistoryError(PROVIDER);
  // The status code decides; one the map does not know leaves it to the newest milestone.
  const stage = (coded ?? events.find((event) => event.stage)?.stage) as Stage | undefined;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: code,
    last_status_text: wording,
    last_update: newest?.time ?? null,
    expected_delivery: null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...goods($, detail),
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
