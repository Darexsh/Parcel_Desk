import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { timelyTitanStage } from './status.js';

export const PROVIDER = 'Timely Titan';
export const CARRIER = 'timely-titan';
// A parcel with thirty statuses is under fifteen kilobytes.
export const TIMELY_TITAN_MAX_BYTES = 512 * 1024;

const NUMBER = /^[A-Z0-9]{6,40}$/;
// What the page shows in place of the table for a number it does not know.
const UNKNOWN = 'tracking not found';
// "2026-01-18 19:43:53": the status's clock, to the second.
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CLOCK_FORMAT = 'yyyy-MM-dd HH:mm:ss';
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_ROWS = 500;

// "[中国]", "[HongKong]": where the row comes from, a region or the shop that sent the parcel.
const SOURCE = /^\[([^[\]]{1,40})\]\s*/;
// The regions the page names, in Chinese or English, with or without a space.
const REGIONS: ReadonlyMap<string, string> = new Map([
  ['中国', 'China'], ['hongkong', 'Hong Kong'], ['hong kong', 'Hong Kong'], ['香港', 'Hong Kong'],
]);
// "转寄单号:…": the number the parcel is forwarded under.
const FORWARDED = /^转寄单号[:：]\s*([A-Z0-9]{6,40})$/i;

// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone
// numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Who took a delivered parcel, after the delivery's own words.
const RECEIVER = /\s*[,;:.\-–，；：]?\s*(?:(?:signed(?: for)? by|signatory|received by)\b|签收人)[\s\S]*$/i;
// A clause of a relayed Chinese post scan that gives a courier, a phone, a hotline or a complaint line.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|呼叫|快递员|投递员|揽投员|揽收员|派送员|派件员|收派员|配送员|司机|姓名|(?<![A-Z\d])\d{5,}/i;
// A bracketed office, centre, workshop or city, a day, or the warehouse's own step; any other
// bracket can name a person or a signer.
const OFFICE = /(?:局|部|中心|站|所|处|公司|仓|港|场|口岸|海关|网点|营业厅|厅|机场|航空|车间|市|县|自治州|报关行)$/;
const DAY = /^\d{1,2}月\d{1,2}日(?:上午|中午|下午|晚上)?$/;
const STEP = /^[出入]库$/;
const HAN = /\p{Script=Han}/u;

/** A number for Timely Titan's tracker, in capitals as the page shows it. */
export function normalizeTimelyTitanNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Timely Titan numbers are six to forty letters and digits');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

/** A status's date and second as one wall time. The page gives no zone. */
function wallClock(text: string): string {
  const parsed = CLOCK.test(text) ? DateTime.fromFormat(text, CLOCK_FORMAT, { zone: 'UTC' }) : null;
  // UTC only checks the calendar fields; no offset is assigned.
  if (!parsed?.isValid || parsed.year < 2000) throw new SchemaError(PROVIDER, 'Timely Titan returned an invalid status time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * A status's text without who signed for it, phone numbers or e-mail addresses.
 * A relayed Chinese post scan also loses the brackets that name no office, day
 * or warehouse step, and every clause from the first that gives a contact.
 */
export function timelyTitanText(value: string): string {
  let text = value.replace(RECEIVER, '').replace(EMAIL, '').replace(PHONE, '');
  if (HAN.test(text)) {
    text = text.replace(/【([^【】]*)】/g, (whole, inner: string) => {
      const name = inner.trim();
      return (OFFICE.test(name) || DAY.test(name) || STEP.test(name)) && !CONTACT.test(name) ? whole : '';
    });
    const kept: string[] = [];
    for (const clause of text.split(/(?<=[，,。；;！!？?])/)) {
      if (CONTACT.test(clause)) break;
      kept.push(clause);
    }
    text = kept.join('');
  }
  return clean(text.replace(/\s+([,，;；.。])/g, '$1')).replace(/^[\s,，;；:：]+|[\s,，;；:：。\-–]+$/g, '');
}

/** A row's source tag and the region it names, if it names one. */
function source(context: string): { text: string; region?: string } {
  const tagged = SOURCE.exec(context);
  if (!tagged) return { text: context };
  const tag = clean(tagged[1]);
  const region = REGIONS.get(tag.toLowerCase()) ?? (countryCode(tag) ? tag : undefined);
  return { text: context.slice(tagged[0].length), ...(region ? { region } : {}) };
}

/**
 * The page Timely Titan's tracker returns for a number: its form, filled with
 * the number searched, and a table of statuses, newest first, each with its
 * clock and its text. A text starts with where the row comes from in square
 * brackets: a region, or the shop that sent the parcel. A number the tracker
 * does not know gets "tracking not found" in place of the table.
 *
 * The form must hold the whole number asked. The page's order stands: the
 * rows' clocks are not all on one zone.
 */
export function parseTimelyTitan(html: string, raw: string): CarrierResult {
  const number = normalizeTimelyTitanNumber(raw);
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Timely Titan answered with a browser check');
  const $ = load(html);
  const sections = $('section#services');
  const inputs = sections.find('form input[name="number"]');
  if (sections.length !== 1 || inputs.length !== 1) throw new SchemaError(PROVIDER, 'Timely Titan returned an unexpected page');
  if (normalizeTrackingNumber(clean(inputs.attr('value') ?? '', 80)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Timely Titan answered for another shipment');
  }
  const tables = sections.find('table');
  if (!tables.length) {
    const answer = clean(sections.clone().find('form').remove().end().text(), 200).toLowerCase();
    if (answer === UNKNOWN) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Timely Titan returned an unexpected page');
  }
  const header = tables.find('tr').first().children();
  if (tables.length !== 1 || header.length !== 2 || header.filter('th').length !== 2
    || clean(header.eq(0).text(), 20) !== 'Time' || clean(header.eq(1).text(), 20) !== 'Context') {
    throw new SchemaError(PROVIDER, 'Timely Titan returned an unexpected page');
  }

  const rows = tables.find('tr').slice(1);
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Timely Titan returned an oversized history');
  const seen = new Set<string>();
  const forwarded = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.each((_, element) => {
    const cells = $(element).children();
    if (cells.length !== 2 || cells.filter('td').length !== 2) throw new SchemaError(PROVIDER, 'Timely Titan returned an invalid status');
    const local = wallClock(clean(cells.eq(0).text(), 40));
    const context = clean(cells.eq(1).text(), 1000);
    if (!context) throw new SchemaError(PROVIDER, 'Timely Titan returned a status without text');
    const { text, region } = source(context);
    const description = timelyTitanText(text).slice(0, 200);
    // A row that gave only contacts is left out.
    if (!description) return;
    const partner = FORWARDED.exec(description)?.[1];
    if (partner) forwarded.add(normalizeTrackingNumber(partner).toUpperCase());
    // A row the page lists twice is kept once.
    const identity = JSON.stringify([local, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = timelyTitanStage(description);
    events.push({
      local_time: local,
      description,
      ...(region ? { location: region } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const latest = events.find((event) => event.stage);
  const stage = latest?.stage as Stage | undefined;
  // Only one number the parcel is forwarded under, other than the one asked, names it.
  const [partner] = forwarded.size === 1 ? [...forwarded] : [];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(partner && partner !== number ? { delivery_tracking_number: partner } : {}),
    events,
  };
}
