import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { emiratesPostStage } from './status.js';

export const PROVIDER = 'Emirates Post';
export const EMIRATES_POST_MAX_BYTES = 2_000_000;
const TRACK_PATH = '/all-services/track-a-package/step-two';
const MAX_EVENTS = 2000;
// These places identify a UAE office. A foreign office or a bare postal code
// keeps its own wall clock; neither the issuer nor the destination dates it.
const UAE_PLACE = /\b(?:Dubai|Abu[ -]+Dhabi|Sharjah|Ajman|Fujairah|Umm[ -]+Al[ -]+Quwain|Ras[ -]+Al[ -]+Khaimah)\b/i;
const WALL = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} (?:AM|PM)$/;
// "Shipped to SEYCHELLES", "Arrived at SEYCHELLES": the wording ends with where the item goes,
// a country or a city.
const SENT_TO = /^(?:Shipped to|Arrived at)\s+(.+)$/i;

export function normalizeEmiratesPostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{13}$/.test(number) && !isValidS10TrackingNumber(number)) throw new InvalidInputError(PROVIDER, 'Expected a postal S10 or a thirteen-digit item number');
  return number;
}

export function emiratesPostUrl(raw: string): string {
  return `https://www.emiratespost.ae${TRACK_PATH}?q=${normalizeEmiratesPostNumber(raw)}`;
}

function statusOf(value: unknown): { code: string; description: string } {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Emirates Post returned an unreadable status');
  const code = clean(value.code, 32);
  const description = clean(value.descriptionEn, 500) || clean(value.descriptionAr, 500);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(code) || !description) throw new SchemaError(PROVIDER, 'Emirates Post returned an unreadable status');
  return { code, description };
}

function clockOf(value: unknown, location: string): Partial<CarrierEvent> {
  const stated = explicitOffsetTime(value);
  if (stated) return { time: stated.iso };
  if (typeof value !== 'string' || !WALL.test(value)) throw new SchemaError(PROVIDER, 'Emirates Post returned an unreadable scan clock');
  const parsed = DateTime.fromFormat(value, 'dd/MM/yyyy hh:mm:ss a', { locale: 'en-US', zone: 'UTC' });
  if (!parsed.isValid || parsed.year < 2000) throw new SchemaError(PROVIDER, 'Emirates Post returned an invalid scan clock');
  const local_time = parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const instant = UAE_PLACE.test(location) ? zonedTime(local_time, "yyyy-MM-dd'T'HH:mm:ss", 'Asia/Dubai') : null;
  return { local_time, ...(instant ? { time: instant.iso, time_zone: 'Asia/Dubai', time_zone_basis: 'place' } : {}) };
}

/** Read only the single-number server-rendered lookup; omit parties and links. */
export function parseEmiratesPost(html: string, raw: string): CarrierResult {
  const number = normalizeEmiratesPostNumber(raw);
  if (html.length > EMIRATES_POST_MAX_BYTES) throw new SchemaError(PROVIDER, 'Emirates Post returned an excessive page');
  const $ = load(html);
  const scripts = $('script#__NEXT_DATA__');
  if (scripts.length !== 1) {
    if (/\b(?:Access Challenge|Just a moment|_cf_chl_opt|cf-chl-widget)\b/i.test(html.slice(0, 100_000))) throw new ChallengeError(PROVIDER, 'Emirates Post returned a browser challenge');
    throw new SchemaError(PROVIDER, 'Emirates Post returned a page without its tracking lookup');
  }
  let next: unknown;
  try { next = JSON.parse(scripts.text()); } catch { throw new SchemaError(PROVIDER, 'Emirates Post returned unreadable page data'); }
  if (!isRecord(next) || !isRecord(next.query) || next.query.q !== number
    || !Array.isArray(next.query.slug) || next.query.slug.join('/') !== TRACK_PATH.slice(1)) {
    throw new SchemaError(PROVIDER, 'Emirates Post returned another tracking page');
  }
  const props = isRecord(next.props) && isRecord(next.props.pageProps) ? next.props.pageProps : null;
  const extra = props && isRecord(props.pageContext) ? props.pageContext.extraData : null;
  if (!isRecord(extra) || !Array.isArray(extra.result) || extra.result.length !== 1) throw new SchemaError(PROVIDER, 'Emirates Post returned another set of items');
  const item: unknown = extra.result[0];
  if (!isRecord(item) || item.trackingNumber !== number) throw new SchemaError(PROVIDER, 'Emirates Post answered for another item');
  if (extra.status === 'not-found') {
    if (item.events === null || (Array.isArray(item.events) && item.events.length === 0)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Emirates Post returned contradictory tracking data');
  }
  if (extra.status !== 'success') throw new IndeterminateError(PROVIDER, 'Emirates Post did not answer the lookup');
  if (!Array.isArray(item.events) || item.events.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Emirates Post returned unreadable history');
  const current = statusOf(item.lastStatus);
  const classified = emiratesPostStage(current.code, current.description);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const value of item.events) {
    if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Emirates Post returned an unreadable scan');
    const status = statusOf(value.status);
    const location = clean(value.locationEn, 200) || clean(value.locationAr, 200);
    const staged = emiratesPostStage(status.code, status.description);
    const event: CarrierEvent = { ...clockOf(value.timeStamp, location), description: status.description,
      provider_code: status.code, ...(location && location !== 'NULL' ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const destination = events.map((event) => countryCode(SENT_TO.exec(event.description ?? '')?.[1])).find(Boolean);
  return { status: classified ? languageStageStatus(classified.stage) : 'unknown',
    ...(classified ? { current_stage: classified.stage, current_stage_source: classified.source } : {}),
    last_status_text: current.description, provider_code: current.code, last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}), ...(destination ? { destination_country: destination } : {}),
    events };
}
