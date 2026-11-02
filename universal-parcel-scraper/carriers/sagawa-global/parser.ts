import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isSagawaGlobalForecast, sagawaGlobalStage } from './status.js';

export const PROVIDER = 'SGH Global Japan';
// The page is about 10 kB with a full history.
export const SAGAWA_GLOBAL_MAX_BYTES = 512 * 1024;

// Twelve digits, as a Sagawa Express waybill, or IDA and twelve digits from Los Angeles.
const NUMBER = /^(?:\d{12}|IDA\d{12})$/;
// A row's clock, "20260902  1351" with two non-breaking spaces between date and time.
const CLOCK = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})$/;
// The footer that names the Sagawa Express waybill once the parcel is handed over, in either language.
const LOCAL_NUMBER = /^(?:LOCAL TRACKING#|国内伝票番号)$/;
const SAGAWA_NUMBER = /^(?:\d{10}|\d{12})$/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|_Incapsula_Resource/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * An SGX air waybill: twelve digits whose last is the remainder of the first
 * eleven divided by seven, the Sagawa Express check, or IDA and twelve digits.
 */
export function normalizeSagawaGlobalNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || (!number.startsWith('IDA') && !hasMod7CheckDigit(number))) {
    throw new InvalidInputError(PROVIDER, 'SGX air waybills are twelve digits with the Sagawa Express check digit, or IDA and twelve digits');
  }
  return number;
}

/** A row's wall clock, to the minute, with no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  // Built in UTC to check the calendar alone: a day or time that does not exist is refused.
  const parsed = match ? DateTime.fromObject({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]) }, { zone: 'UTC' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'SGX returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The Sagawa Express waybill the footer names, with its link to Sagawa's tracker, once the parcel is handed over. */
function handOff(label: string, value: string, href: string | undefined): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  let host: string;
  try {
    host = new URL(href ?? '').hostname;
  } catch {
    return {};
  }
  const number = normalizeTrackingNumber(value);
  return LOCAL_NUMBER.test(label) && SAGAWA_NUMBER.test(number) && /(?:^|\.)sagawa-exp\.co\.jp$/.test(host)
    ? { delivery_carrier: 'sagawa', delivery_tracking_number: number } : {};
}

/**
 * The page `trackeng.asp` renders for one air waybill. Under the search form,
 * `#ShipmentInfo` echoes the air waybill with the shipper's reference and the
 * origin and destination stations, and `#ShipmentDetail` lists the scans
 * oldest first: a wall clock, the wording and the station. Once Sagawa
 * Express has the parcel, a footer names its waybill. An air waybill the
 * tracker does not know is `No Record.`; several records for one number are a
 * list of air waybills instead.
 */
export function parseSagawaGlobal(html: string, raw: string): CarrierResult {
  const number = normalizeSagawaGlobalNumber(raw);
  const $ = load(html);
  const box = $('#ShipmentDetail');
  if ($('form[name="frm"] select#cat').length !== 1 || box.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SGX answered with a browser check');
    throw new SchemaError(PROVIDER, 'SGX returned a page without a tracking answer');
  }
  const info = $('#ShipmentInfo');
  if (!info.length) {
    if (!box.find('table').length && /^No Record\.?$/i.test(clean(box.text(), 100))) throw new NotFoundError(PROVIDER);
    // Several records under the number, or one found by another of its numbers: none is bound to the number asked.
    if (clean(box.find('th').first().text(), 20) === 'AWB#') {
      throw new IndeterminateError(PROVIDER, 'SGX listed air waybills for this number instead of one shipment');
    }
    throw new SchemaError(PROVIDER, 'SGX returned a page without a tracking answer');
  }
  const echoed = info.find('#info_awb .info_value');
  if (echoed.length !== 1) throw new SchemaError(PROVIDER, 'SGX returned a shipment without its air waybill');
  if (normalizeTrackingNumber(clean(echoed.text(), 64)) !== number) throw new IndeterminateError(PROVIDER, 'SGX answered for another air waybill');
  const headers = box.find('thead th').map((_, cell) => clean($(cell).text(), 40)).get();
  if (headers.join('|') !== 'DATE TIME|STATUS|COUNTRY') throw new SchemaError(PROVIDER, 'SGX returned an invalid history table');
  const rows = box.find('tbody > tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SGX returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.each((_, node) => {
    const cells = $(node).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'SGX returned an invalid scan row');
    const local = wallClock(clean(cells.eq(0).text(), 40));
    // A delivery adds how it was received, as "[STAMP]"; only the wording before it is kept.
    const description = clean(cells.eq(1).text(), 300).replace(/\s*\[[^\]]*\][\s\S]*$/, '');
    if (!description) throw new SchemaError(PROVIDER, 'SGX returned a scan without wording');
    if (isSagawaGlobalForecast(description)) return;
    // Sagawa Express's scans after the hand-off have no station of their own: the page writes
    // the destination station in bold on them, under its own link target.
    const station = cells.eq(2).find('a[target="country1"]').length ? '' : clean(cells.eq(2).text(), 120).replace(/\s*,\s*/g, ', ');
    const key = JSON.stringify([local, description, station]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = sagawaGlobalStage(description);
    events.push({ local_time: local, ...(station ? { location: station } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The page lists the scans oldest first; its order is kept, turned round.
  events.reverse();

  const footer = box.find('tfoot tr');
  const cells = footer.length === 1 ? footer.children('td') : null;
  const partner = cells?.length === 3
    ? handOff(clean(cells.eq(0).text(), 40), clean(cells.eq(1).text(), 64), cells.eq(2).find('a').attr('href')) : {};
  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...partner,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
