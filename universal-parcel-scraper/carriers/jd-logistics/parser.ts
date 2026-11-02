import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus } from '../../core/status/index.js';
import { countryCode, countryTimeZone, EXPLICIT_OFFSET_PATTERN, explicitOffsetTime, firstOccurrence, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jdLogisticsStatus } from './status.js';
import { partnerNumber, scanWording } from './wording.js';

const PROVIDER = 'JD Logistics';

const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
const SHORT_ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region', style: 'short' });
const CHINESE_REGIONS = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'QO', 'UN', 'ZZ']);
// Countries by their Simplified Chinese name, as JD writes `routeCountry`
// ("沙特阿拉伯"), plus the usual short forms.
const COUNTRY_BY_CHINESE_NAME: ReadonlyMap<string, string> = new Map([
  ...Array.from({ length: 26 * 26 }, (_, index) => String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)))
    .filter(code => countryCode(code) === code && !NOT_COUNTRIES.has(code) && !code.startsWith('X'))
    .map(code => [CHINESE_REGIONS.of(code) ?? code, code] as const)
    .filter(([name, code]) => name !== code),
  ['沙特', 'SA'], ['阿联酋', 'AE'], ['印尼', 'ID'], ['澳洲', 'AU'], ['中国大陆', 'CN'], ['中国内地', 'CN'],
  ['香港', 'HK'], ['中国香港', 'HK'], ['澳门', 'MO'], ['中国澳门', 'MO'], ['中国台湾', 'TW'],
]);
// English names of the special administrative regions that `countryCode` reads only in full.
const REGION_BY_SHORT_NAME: ReadonlyMap<string, string> = new Map([['HONG KONG', 'HK'], ['MACAO', 'MO'], ['MACAU', 'MO']]);

// A single-zone region JD's lanes name that core/time's table leaves out: its
// code is also Missouri's. Countries spanning several zones (US, AU, ID,
// BR...) stay out: a country alone cannot tell their clock.
const LANE_ZONES: Readonly<Record<string, string>> = { MO: 'Asia/Macau' };
const countryZone = (code: string) => (Object.hasOwn(LANE_ZONES, code) ? LANE_ZONES[code]! : countryTimeZone(code));

/**
 * The country a place field names, in Chinese or as `countryCode` reads it;
 * never a two-letter value, which may be a province code.
 */
const namedCountry = (value: string) => COUNTRY_BY_CHINESE_NAME.get(value)
  ?? (value.length > 2 ? countryCode(value) ?? REGION_BY_SHORT_NAME.get(value.toUpperCase()) ?? null : null);

/**
 * The countries a scan's place fields name, and the fields as JD wrote them.
 * JD writes the country in Chinese in `routeCountry`, on some scans only, and
 * on international lanes in English in `routeProvinceName`, which elsewhere
 * holds a province. A city field can name a city-state.
 */
function placeCountries(node: Record<string, unknown>) {
  const [written, provinceText, cityText] = [clean(node.routeCountry, 100), clean(node.routeProvinceName, 100), clean(node.routeCityName, 200)];
  return { written, provinceText, cityText, country: namedCountry(written), province: namedCountry(provinceText), city: namedCountry(cityText) };
}

/**
 * The scan's city and its country in English, whichever field names it, so
 * every scan of a place reads the same. A country field read neither way
 * stays as written. A city that is the country itself stands alone.
 */
function scanLocation(node: Record<string, unknown>): string {
  const city = clean(node.routeCityName, 200);
  const { written, country, province } = placeCountries(node);
  const code = country ?? province;
  const name = code ? ENGLISH_REGIONS.of(code) ?? written : written;
  const same = (value: string | undefined) => value?.toLocaleLowerCase('en-US') === city.toLocaleLowerCase('en-US');
  const cityIsCountry = same(name) || (code !== null && (same(SHORT_ENGLISH_REGIONS.of(code)) || namedCountry(city) === code));
  return [city, cityIsCountry ? '' : name].filter(Boolean).join(', ');
}

// JD declares each scan's zone as a fixed offset: "UTC+3", "UTC+8".
const DECLARED_ZONE = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i;

/** A declared zone as an ISO offset ("+03:00") within the offsets clocks use; null otherwise. */
function declaredOffset(value: unknown): string | null {
  const zone = DECLARED_ZONE.exec(clean(value, 16));
  if (!zone) return null;
  if (!zone[1]) return '+00:00';
  const [hours, minutes] = [Number(zone[2]), Number(zone[3] ?? 0)];
  const signed = (zone[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
  if (minutes > 59 || signed > 14 * 60 || signed < -12 * 60) return null;
  return `${zone[1]}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * A scan's instant when two of JD's fields agree: its epoch milliseconds read as
 * its wall clock at the offset it declares. Every country its place fields name
 * must keep one zone known here, and that zone that offset at that wall clock,
 * neither skipped nor repeated there. A country spanning several zones, one not
 * known here, a country field read neither way, or a place naming no country
 * read here keeps the clock local. Only a scan with no place at all is dated on
 * the two fields alone.
 */
function scanInstant(node: Record<string, unknown>, wall: string): ParsedTime | null {
  const offset = declaredOffset(node.timeZone);
  const epoch = node.operationTimestamp;
  if (!offset || typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch <= 0) return null;
  const instant = explicitOffsetTime(`${wall}${offset}`);
  if (!instant || Math.floor(epoch / 1000) !== Math.floor(instant.timestamp / 1000)) return null;
  const { written, provinceText, cityText, country, province, city } = placeCountries(node);
  if (written && !country) return null;
  if (!country && !province && !city && (provinceText || cityText)) return null;
  for (const code of [country, province, city]) {
    if (!code) continue;
    const zone = countryZone(code);
    if (!zone) return null;
    const local = firstOccurrence(DateTime.fromISO(wall, { zone }));
    if (!local.isValid || local.toMillis() !== instant.timestamp || local.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall.slice(0, 19)
      || local.getPossibleOffsets().length !== 1) return null;
  }
  return instant;
}

export function normalizeJdNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{8,35}$/.test(number)) throw new InvalidInputError(PROVIDER, 'JD Logistics requires a waybill number');
  return number;
}

/**
 * JD's own answer that its international feed holds nothing under the number, as for its
 * domestic waybills: no outage, and no proof the parcel does not exist.
 */
const noHistory = () => new IndeterminateError(PROVIDER, 'JD Logistics returned no international history', { reason: 'portal_not_found' });

/** The international website returns one parent reference with its constituent waybills. */
export function parseJdLogistics(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJdNumber(raw);
  if (!isRecord(payload) || payload.code !== 1 || !Array.isArray(payload.data) || payload.data.length > 100) {
    throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid tracking response');
  }
  if (!payload.data.length) throw noHistory();
  if (payload.data.length !== 1 || !isRecord(payload.data[0])
    || returnedTrackingNumber(payload.data[0].waybillNo) !== number) {
    throw new SchemaError(PROVIDER, 'JD Logistics returned a different or ambiguous shipment');
  }
  const item = payload.data[0];
  if (item.waybillNum === 0) throw noHistory();
  if ((item.waybillNum !== undefined && item.waybillNum !== 1)
    || !Array.isArray(item.wayBillTrackItemDtoList) || item.wayBillTrackItemDtoList.length !== 1
    || !isRecord(item.wayBillTrackItemDtoList[0])) {
    throw new SchemaError(PROVIDER, 'JD Logistics returned missing or multiple waybills');
  }
  const waybill = item.wayBillTrackItemDtoList[0];
  if (!clean(waybill.waybillNo, 64) || !Array.isArray(waybill.trackNodeList) || waybill.trackNodeList.length > 1000) {
    throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid waybill history');
  }
  if (!waybill.trackNodeList.length) throw noHistory();
  const partners = new Set<string>();
  const events: CarrierEvent[] = waybill.trackNodeList.flatMap(node => {
    if (!isRecord(node)) throw new SchemaError(PROVIDER);
    // Never keep the courier's name and phone, nor the partner's number in the wording.
    const text = clean(node.operatorDesc, 1000);
    const description = scanWording(text);
    const clock = clean(node.operatorTime, 64);
    if (!text || !clock) throw new SchemaError(PROVIDER, 'JD Logistics returned an incomplete scan');
    const partner = partnerNumber(text);
    if (partner) partners.add(partner);
    if (!description) return [];
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(clock)) {
      throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid scan clock');
    }
    const offset = /[+-](\d{2}):?(\d{2})$/.exec(clock);
    if (offset && (Number(offset[1]) > 14 || Number(offset[2]) > 59
      || (Number(offset[1]) === 14 && Number(offset[2]) !== 0))) {
      throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid scan offset');
    }
    const iso = clock.replace(' ', 'T');
    const wall = DateTime.fromISO(iso, { zone: 'UTC' });
    if (!wall.isValid) throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid scan clock');
    const instant = EXPLICIT_OFFSET_PATTERN.test(iso) ? explicitOffsetTime(iso) : scanInstant(node, iso);
    const location = scanLocation(node);
    const code = clean(node.operationCode, 32);
    const mapped = jdLogisticsStatus(code, description);
    const classification = classifyWording(description);
    return [{ description, ...(instant ? { time: instant.iso } : { local_time: wall.toFormat("yyyy-MM-dd'T'HH:mm:ss") }),
      ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' }
        : classification.source !== 'none' ? { stage: classification.stage, stage_source: classification.source } : {}) }];
  });
  if (!events.length) throw new SchemaError(PROVIDER, 'JD Logistics returned an incomplete scan');
  // JD lists the newest first. Only a fully dated history is ordered by instant, ties kept.
  if (events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const seen = new Set<string>();
  const unique = events.filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 100);
  const latest = unique[0]!;
  const coded = jdLogisticsStatus(latest.provider_code, latest.description!);
  const classified = classifyWording(latest.description!);
  return { status: coded?.status ?? (classified.source !== 'none' ? languageStageStatus(classified.stage) : 'unknown'),
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    // The last-mile partner's number, when JD gives one other than its own.
    ...(partners.size === 1 && !partners.has(number) ? { delivery_tracking_number: [...partners][0]! } : {}), events: unique };
}
