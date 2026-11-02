import { returnedTrackingNumber } from '../../core/detection/returned.js';

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay, countryCode, countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { japanPostStatus } from './status.js';

const PROVIDER = 'Japan Post';
const ENDPOINT = 'https://trackings.post.japanpost.jp/services/srv/search/direct';
const MAX_RESPONSE_BYTES = 1_000_000;
// Every Japanese prefecture keeps Japan's civil time.
const PREFECTURES = new Set([
  'HOKKAIDO', 'AOMORI', 'IWATE', 'MIYAGI', 'AKITA', 'YAMAGATA', 'FUKUSHIMA', 'IBARAKI', 'TOCHIGI', 'GUNMA',
  'SAITAMA', 'CHIBA', 'TOKYO', 'KANAGAWA', 'NIIGATA', 'TOYAMA', 'ISHIKAWA', 'FUKUI', 'YAMANASHI', 'NAGANO',
  'GIFU', 'SHIZUOKA', 'AICHI', 'MIE', 'SHIGA', 'KYOTO', 'OSAKA', 'HYOGO', 'NARA', 'WAKAYAMA', 'TOTTORI',
  'SHIMANE', 'OKAYAMA', 'HIROSHIMA', 'YAMAGUCHI', 'TOKUSHIMA', 'KAGAWA', 'EHIME', 'KOCHI', 'FUKUOKA', 'SAGA',
  'NAGASAKI', 'KUMAMOTO', 'OITA', 'MIYAZAKI', 'KAGOSHIMA', 'OKINAWA',
]);
// Country names the portal prints that `countryCode` does not read.
const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  'KOREA REP': 'KR', 'HONG KONG': 'HK', 'REPUBLIC OF SERBIA': 'RS',
};
// These posts also deliver on other clocks under the same country name: Spain
// and Portugal on their islands, France in the overseas departments Japan
// Post's France covers. A delivery scan names no office, only the country.
const OVERSEAS_CLOCKS = new Set(['ES', 'FR', 'PT']);
// Offices of exchange on the mainland of those countries, by the name the UPU
// code list gives them: Correos' Madrid airport office is `MADRID AP`.
const MAINLAND_OFFICES: Readonly<Record<string, { office: RegExp; zone: string }>> = {
  ES: { office: /^MADRID(?: |$)/, zone: 'Europe/Madrid' },
};

// The history header states that overseas scans are in local time, the clock
// of the post that scanned. A row's own Prefecture / Country cell settles its
// zone when it names a prefecture or a single-zone country, and its own office
// when that is a mainland office of exchange of a country with other clocks.
// Another scan's zone or the parcel's destination never does.
function rowZone(region: string, office: string): string | null {
  const name = region.toUpperCase();
  if (PREFECTURES.has(name)) return 'Asia/Tokyo';
  const code = Object.hasOwn(COUNTRY_NAMES, name) ? COUNTRY_NAMES[name]! : countryCode(name);
  if (!code) return null;
  if (!OVERSEAS_CLOCKS.has(code)) return countryTimeZone(code);
  const mainland = Object.hasOwn(MAINLAND_OFFICES, code) ? MAINLAND_OFFICES[code]! : null;
  return mainland?.office.test(office.toUpperCase()) ? mainland.zone : null;
}

export function normalizeJapanPostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  // The official portal accepts domestic 11–13 digit items and international
  // S10 references. U-prefixed customs labels are explicitly not trackable.
  if (!/^\d{11,13}$/.test(number)
    && (!/^[A-TV-Z][A-Z]\d{9}[A-Z]{2}$/.test(number) || !isValidS10TrackingNumber(number))) {
    throw new InvalidInputError(PROVIDER, 'Japan Post requires a domestic tracking number or a valid tracked postal reference');
  }
  return number;
}

function wallTime(raw: string): string {
  const format = /^\d{2}\/\d{2}\/\d{4}$/.test(raw) ? 'MM/dd/yyyy' : 'MM/dd/yyyy HH:mm';
  // The table explicitly labels overseas scans as local time. Validate the
  // calendar in UTC without assigning that zone to an international event.
  const date = DateTime.fromFormat(raw, format, { zone: 'UTC' });
  if (!date.isValid) throw new SchemaError(PROVIDER, 'Japan Post returned an invalid event date');
  return date.toFormat(format === 'MM/dd/yyyy' ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ss");
}

function eventInstant(localTime: string, region: string, office: string): string | null {
  const zone = rowZone(region, office);
  if (!zone || !localTime.includes('T')) return null;
  const date = firstOccurrence(DateTime.fromISO(localTime, { zone }));
  // Luxon can shift a nonexistent spring clock forward or pick one side of
  // an autumn fold. Neither supplies an unambiguous carrier scan instant.
  if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== localTime
    || date.getPossibleOffsets().length !== 1) return null;
  return date.toUTC().toISO({ suppressMilliseconds: true });
}

export function parse(html: string, trackingNumber: string): CarrierResult {
  const number = normalizeJapanPostNumber(trackingNumber);
  const $ = load(html);
  if (/just a moment|verify.*human|captcha/i.test($('title').text())
    || $('.g-recaptcha, .h-captcha, input[name="captcha"]').length) throw new ChallengeError(PROVIDER);
  $('script, style, noscript').remove();

  const result = $('table[summary="照会結果"]');
  const details = $('table[summary="配達状況詳細"]');
  const history = $('table[summary="履歴情報"]');
  if (details.length !== 1 || history.length !== 1) {
    const rows = result.find('tr').filter((_, row) => $(row).children('td').length > 0);
    const cells = rows.children('td');
    if (!details.length && !history.length && result.length === 1 && rows.length === 1 && cells.length === 2
      && returnedTrackingNumber(cells.eq(0).text()) === number
      && clean(cells.eq(1).text()) === '** Your item was not found. Confirm your item number and ask at your local office.') {
      throw new NotFoundError(PROVIDER);
    }
    throw new SchemaError(PROVIDER, 'Japan Post returned missing or ambiguous shipment tables');
  }
  if (result.length) throw new SchemaError(PROVIDER, 'Japan Post returned ambiguous shipment tables');

  // International items have one heading row and one value row. Domestic items
  // add a second pair (expected delivery office, number of pieces).
  const detailRows = details.find('tr');
  const fields = new Map<string, string>();
  let itemNumbers = 0;
  if (!detailRows.length || detailRows.length % 2 !== 0 || detailRows.length > 8) {
    throw new SchemaError(PROVIDER, 'Japan Post returned a different or ambiguous shipment');
  }
  for (let index = 0; index < detailRows.length; index += 2) {
    const labels = detailRows.eq(index).children();
    const values = detailRows.eq(index + 1).children();
    if (!labels.length || labels.length !== values.length
      || labels.filter('th').length !== labels.length || values.filter('td').length !== values.length) {
      throw new SchemaError(PROVIDER, 'Japan Post returned a different or ambiguous shipment');
    }
    labels.each((column, cell) => {
      const label = clean($(cell).text());
      if (label === 'Item number') itemNumbers += 1;
      if (label && !fields.has(label)) fields.set(label, clean(values.eq(column).text()));
    });
  }
  if (itemNumbers !== 1 || normalizeTrackingNumber(fields.get('Item number') ?? '') !== number) {
    throw new SchemaError(PROVIDER, 'Japan Post returned a different or ambiguous shipment');
  }
  const headers = history.find('th').map((_, cell) => clean($(cell).text())).get();
  // International results label the date column with its overseas clock
  // caveat; domestic results call it Date.
  if (!(headers[0] === 'Date' || headers[0]?.startsWith('State occurrence date'))
    || headers[1] !== 'Shipping track record' || headers[2] !== 'Details' || headers[3] !== 'Office'
    || !['Prefecture / Country', 'Prefecture'].includes(headers[4]!)
    || headers[5] !== 'ZIP code（Postal code number）' || headers.length !== 6) {
    throw new SchemaError(PROVIDER, 'Japan Post returned an invalid history table');
  }
  const rows = history.find('tr').filter((_, row) => $(row).children('td').length > 0);
  if (!rows.length || rows.length % 2 !== 0 || rows.length > 1_000) {
    throw new SchemaError(PROVIDER, 'Japan Post returned incomplete tracking history');
  }

  const events: CarrierEvent[] = [];
  for (let index = 0; index < rows.length; index += 2) {
    const cells = rows.eq(index).children('td');
    const postalCode = rows.eq(index + 1).children('td');
    if (cells.length !== 5 || [0, 1, 2, 4].some((column) => cells.eq(column).attr('rowspan') !== '2')
      || cells.eq(3).is('[rowspan]') || cells.filter('[colspan]').length
      || postalCode.length !== 1 || postalCode.is('[rowspan], [colspan]')) {
      throw new SchemaError(PROVIDER, 'Japan Post returned an invalid event row');
    }
    const localTime = wallTime(clean(cells.eq(0).text(), 64));
    const description = clean(cells.eq(1).text(), 500);
    if (!description) throw new SchemaError(PROVIDER, 'Japan Post returned an empty event');
    const region = clean(cells.eq(4).text(), 100);
    const office = clean(cells.eq(3).text(), 150);
    const location = [office, region].filter(Boolean).join(', ');
    const time = eventInstant(localTime, region, office);
    const status = japanPostStatus(description);
    // The host treats `time` as an instant and applies the catalog's timezone
    // when no offset is present. Keep unresolved wall clocks in local_time.
    events.push({ ...(time ? { time } : {}), local_time: localTime, description,
      ...(location ? { location } : {}), ...(status ? { stage: status.stage } : {}) });
  }
  // The carrier presents oldest first. Preserve its sequence when some scans
  // have unresolved zones, rather than mixing UTC and local-clock sorting.
  const seen = new Set<string>();
  const latestFirst = events.reverse().filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const latest = latestFirst[0]!;
  // A delivery stands against the destination post's rows after it, such as
  // its customs system returning the item an hour after the delivery; only a
  // return or another problem says more.
  const delivery = latestFirst.findIndex((event) => event.stage === 'delivered');
  const current = delivery > 0 && latestFirst.slice(0, delivery)
    .every((event) => japanPostStatus(event.description!)?.status !== 'exception') ? latestFirst[delivery]! : latest;
  const status = japanPostStatus(current.description!);
  const settled = status && (status.status === 'exception' || ['delivered', 'returned', 'ready_for_pickup'].includes(status.stage));
  // The class of goods is the Japan Post service the item travels under: Yu-Pack, or EMS or Parcel abroad.
  const service = clean(fields.get('Class of goods'), 80);
  return { status: status?.status ?? 'unknown', ...(status ? { current_stage: status.stage } : {}),
    last_status_text: current.description, last_update: latest.time ?? null, last_update_local: latest.local_time,
    expected_delivery: settled ? null : designatedDelivery(fields, String(latest.local_time)),
    ...(status?.stage === 'delivered' && current.time ? { delivered_at: current.time } : {}),
    ...(service ? { service_name: service } : {}), events: latestFirst.slice(0, 100) };
}

/**
 * The delivery day the sender designated, with its time slot when one was
 * chosen, as long as no scan is dated after that day. It is a plan, not a scan.
 */
function designatedDelivery(fields: ReadonlyMap<string, string>, latestLocal: string): string | null {
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fields.get('Designated date for delivery') ?? '');
  const day = date ? calendarDay(Number(date[3]), Number(date[1]), Number(date[2])) : null;
  if (!day || latestLocal.slice(0, 10) > day) return null;
  const slot = /^From (\d{1,2}):([0-5]\d) to (\d{1,2}):([0-5]\d)$/.exec(fields.get('Designated time slot') ?? '');
  if (!slot) return day;
  const from = `${slot[1]!.padStart(2, '0')}:${slot[2]}`;
  const to = `${slot[3]!.padStart(2, '0')}:${slot[4]}`;
  return Number(slot[3]) <= 24 && from < to ? `${day} ${from}–${to}` : day;
}

export class JapanPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJapanPostNumber(raw);
    const budgetMs = context.budgetMs ?? this.options.timeoutMs ?? 15_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Japan Post timeout must be positive');
    context.signal?.throwIfAborted();
    const url = `${ENDPOINT}?${new URLSearchParams({ reqCodeNo1: number, locale: 'en' })}`;
    try {
      const { bytes } = await fetchBounded(url, { headers: { 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, maxBytes: MAX_RESPONSE_BYTES, timeoutMs: Math.max(1, Math.floor(budgetMs)),
        fetcher: (input, init) => (this.options.fetcher ?? fetch)(input, {
          ...init,
          signal: AbortSignal.any([...(context.signal ? [context.signal] : []), ...(init?.signal ? [init.signal] : [])]),
        }),
      });
      context.signal?.throwIfAborted();
      return parse(decodeText(bytes), number);
    } catch (error) {
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
        throw new TransportError(PROVIDER, 'Japan Post tracking endpoint is unavailable', { cause: error });
      }
      throw error;
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JapanPostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'japan-post', steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJapanPostNumber(number))),
  };
};
