import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { lookupBudget, readerLanguage, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import type { Stage } from '../../generated/catalog.js';
import { countryCode, countryTimeZone, isoTime } from '../../core/time/index.js';
import { withNetworkRetry } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import {
  FALLBACK_EVENT_LABELS, GLOBAL_STATUS_STAGE, STAGE_STATUS, STATUS_MAP, SWISS_POST_LANGUAGES, swissPostEventStage,
  type SwissPostLanguage,
} from './status.js';
import { DESTINATION_EVENTS, PRE_ADVICE, PRE_ADVICE_ZONE, swissPostOriginZone } from './clock.js';

// The public tracker signs an anonymous visitor in before it will search: it
// creates a throwaway user, echoes a CSRF token, and keys the search result on
// a hash. Every call in that sequence shares one cookie jar.
const API_BASE = 'https://service.post.ch/ekp-web/api';
/** The tracker's wording table in one of its languages; the event replies are the same in all of them. */
const translationsUrl = (language: SwissPostLanguage) =>
  `https://service.post.ch/ekp-web/core/rest/translations/${language}/shipment-text-messages`;
const PROVIDER = 'Swiss Post';
const REQUEST_TIMEOUT_MS = 10_000;
/** A wording table that failed to load, or came back empty, is asked for again after this. */
const TRANSLATION_RETRY_MS = 10 * 60_000;
/** The user, search, result, event, translation and pickup office calls, each at its own bound. */
const DEFAULT_BUDGET_MS = 6 * REQUEST_TIMEOUT_MS;
/** A request's own timer can fire a few milliseconds before the budget's clock runs out. */
const BUDGET_SLACK_MS = 5;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-CH,en;q=0.9',
  Referer: 'https://service.post.ch/ekp-web/ui/',
};

/** The refresh on Swiss Post's outage page: to `sorry.post.ch`, its own page for an unplanned outage. */
const OUTAGE_REFRESH = /^\s*\d+(?:\.\d*)?\s*[;,]\s*(?:url\s*=\s*)?(["']?)https?:\/\/sorry\.post\.ch\/?\1\s*$/i;

/**
 * A reply's JSON. While the service is down, any `ekp-web` URL can answer, even with HTTP 200,
 * with Swiss Post's outage page, which only refreshes to `sorry.post.ch`. That says nothing
 * about the shipment, so it is inconclusive; any other reply that does not parse stays malformed.
 */
function swissPostJson(bytes: Uint8Array): unknown {
  try {
    return parseJsonBytes(bytes, PROVIDER);
  } catch (cause) {
    const $ = load(decodeText(bytes));
    const outage = $('meta').filter((_, meta) => /^\s*refresh\s*$/i.test($(meta).attr('http-equiv') ?? '')
      && OUTAGE_REFRESH.test($(meta).attr('content') ?? '')).length > 0;
    if (outage) throw new IndeterminateError(PROVIDER, 'Swiss Post returned its outage page instead of tracking data', { cause });
    throw cause;
  }
}

export interface SwissPostOptions {
  /** Test seam; production uses the global fetch. The cookie jar wraps it. */
  fetcher?: typeof fetch;
}

/**
 * Trim and cap without collapsing inner whitespace: Swiss Post's translated
 * wording is shown as the carrier writes it, so `core/transport`'s `clean` is
 * deliberately not used here.
 */
function text(value: unknown, limit = 500): string {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? String(value).trim().slice(0, limit) : '';
}

/** Whether the lookup was cancelled or has spent its budget, rather than a request failing on its own. */
function ended(budget: LookupBudget): boolean {
  return budget.signal.aborted || budget.remainingMs() <= BUDGET_SLACK_MS;
}

function comparableShipmentNumber(value: unknown): string {
  return text(value, 64).replace(/[\s.-]/g, '').toUpperCase();
}

function datePart(value: unknown): string | null {
  return /(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/.exec(text(value))?.[1] ?? null;
}

function clockParts(value: unknown): string[] {
  if (isRecord(value)) {
    return ['start', 'end', 'from', 'to'].flatMap((key) => clockParts(value[key]));
  }
  if (Array.isArray(value)) return value.flatMap(clockParts);
  const stringValue = text(value);
  const timestampClock = /T((?:[01]\d|2[0-3]):[0-5]\d)/.exec(stringValue)?.[1];
  if (timestampClock) return [timestampClock];
  const clocks = stringValue.match(/(?<!\d)(?:[01]\d|2[0-3]):[0-5]\d/g) ?? [];
  if (clocks.length > 1 && /[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(stringValue)) {
    return clocks.slice(0, 1);
  }
  return clocks;
}

export function swissPostExpectedDelivery(item: JsonObject): string | null {
  const interval = item.deliveryTimeInterval;
  const range = isRecord(item.deliveryRange) ? item.deliveryRange : {};
  const date = [
    item.calculatedDeliveryDate,
    item.deliveryDate,
    interval,
    range.start,
    range.end,
  ].map(datePart).find(Boolean) ?? null;
  if (!date) return null;
  const clocks = clockParts(interval);
  if (clocks.length === 0) return date;
  if (clocks.length === 1 || clocks[0] === clocks[1]) return `${date} ${clocks[0]}`;
  return `${date} ${clocks[0]}–${clocks[1]}`;
}

/** A positive whole measurement, or null. Swiss Post sends 0 for an unmeasured item. */
function measurement(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(text(value, 20));
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** The item's weight: Swiss Post sends grams. */
function weightKg(item: JsonObject): number | null {
  const grams = measurement(isRecord(item.physicalProperties) ? item.physicalProperties.weight : undefined);
  return grams === null ? null : Math.round(grams) / 1000;
}

/** Length, width and height when measured: Swiss Post sends millimetres; letters often have two. */
function dimensionsText(item: JsonObject): string | null {
  const properties = isRecord(item.physicalProperties) ? item.physicalProperties : {};
  const centimetres = ['dimension1', 'dimension2', 'dimension3']
    .map((key) => measurement(properties[key]))
    .filter((millimetres): millimetres is number => millimetres !== null)
    .map((millimetres) => Math.round(millimetres) / 10);
  return centimetres.length >= 2 ? `${centimetres.join(' × ')} cm` : null;
}

/**
 * Resolve one dotted translation key against the service's pattern table, where
 * `*` is a wildcard segment. The most specific pattern of the same length wins.
 */
function translationMatch(
  translations: Record<string, string>,
  segments: string[],
): string | null {
  let best: { score: number; description: string } | null = null;
  for (const [pattern, description] of Object.entries(translations)) {
    const patternSegments = pattern.split('.');
    if (patternSegments.length !== segments.length) continue;
    if (!patternSegments.every((expected, index) => expected === '*' || expected === segments[index])) {
      continue;
    }
    const score = patternSegments.filter((segment) => segment !== '*').length;
    if (!best || score > best.score) best = { score, description };
  }
  return best?.description ?? null;
}

function eventDescription(
  event: JsonObject,
  translations: Record<string, string>,
  internationalType: string,
): string {
  const eventCode = text(event.eventCode, 100);
  const segments = [...eventCode.split('.'), internationalType];
  // The tracker's page fills a wording's {{valueParameter}} with the scan's
  // `subEventAdditionalInfo`, a collection deadline. A wording it would leave
  // unfilled, or fill with anything but a date, is dropped.
  const parameter = text(event.subEventAdditionalInfo, 40);
  const filled = (wording: string | null): string | null => {
    if (!wording?.includes('{{valueParameter}}')) return wording;
    return /^\d[\d./: T+-]{5,}$/.test(parameter) ? wording.replaceAll('{{valueParameter}}', parameter) : null;
  };
  let description = filled(translationMatch(translations, segments));
  const subEventId = text(event.subEventId, 50);
  if (subEventId) {
    const subSegments = [...segments, subEventId];
    const detailCode = text(event.subEventDetailCode, 50);
    if (detailCode) subSegments.push(detailCode);
    const detail = filled(translationMatch(translations, subSegments));
    if (detail && detail !== description) description = description ? `${description} — ${detail}` : detail;
  }
  const metadata = isRecord(event.externalMetadata) ? event.externalMetadata : {};
  const externalDescription = text(metadata.description);
  const code = eventCode.split('.').at(-1) ?? '';
  const value = description || externalDescription || FALLBACK_EVENT_LABELS[code] || eventCode;
  const $ = load(`<span>${value}</span>`);
  return $('span').text().trim().slice(0, 500) || 'Tracking update';
}

/**
 * Operational scan location: city and postcode, or an explicit country when city is absent.
 * A postcode or site number alone places nothing.
 */
function eventLocation(event: JsonObject): string {
  const city = text(event.city, 100);
  const postcode = text(event.zip, 30);
  const country = countryCode(event.country);
  if (!city) return country && country !== 'ZZ' ? country : '';
  return [city, postcode].filter(Boolean).join(' ').slice(0, 160);
}

/**
 * The site number of the office or My Post 24 terminal holding the parcel, from its pickup
 * notice, else empty. The tracker reads the arrival office first, as its own page does.
 */
export function swissPostPickupOffice(item: JsonObject): string {
  const avis = isRecord(item.avis) ? item.avis : {};
  const office = text(avis.arrivalPostOfficeZip, 20) || text(avis.deliveryPostOfficeZip, 20);
  return /^\d{6}$/.test(office) ? office : '';
}

/**
 * The site record's name, then its street and its town on their own lines, as the pickup
 * notice shows them, if it is the requested site. A street that repeats the name, as a
 * terminal's can, is left out; without a town the name stands alone.
 */
export function swissPostPickupPoint(office: unknown, site: string): string {
  if (!isRecord(office) || text(office.zip, 20) !== site) return '';
  const name = text(office.description, 120);
  if (!name) return '';
  const postcode = text(office.zip4, 10);
  const town = text(office.city, 80);
  if (!/^\d{4}$/.test(postcode) || !town) return name;
  const street = [text(office.street, 120), text(office.streetNumber, 20)].filter(Boolean).join(' ');
  return [name, street !== name && street, `${postcode} ${town}`].filter(Boolean).join('\n');
}

/**
 * Local ordering policy: event timestamps are read only to sort. Values without
 * an offset are treated as UTC for that comparison, which keeps the ordering
 * stable without rewriting the string the carrier sent — the event keeps the
 * carrier's own `timestamp` verbatim, but for a destination post's event.
 */
function timestamp(value: string): number {
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const parsed = Date.parse(explicitZone ? value : `${value}Z`);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(?:Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A destination post's event, on its country's clock when that keeps one. In a
 * country with several, it keeps Swiss Post's offset, the last guess: hours
 * off, but the reply keeps its instants.
 */
function destinationClock(event: JsonObject, time: string, destination: string | null): string {
  const located = text(event.city, 100) || text(event.zip, 30) || text(event.country, 10);
  const wall = WALL_CLOCK.exec(time)?.[1];
  if (!destination || located || !wall || !DESTINATION_EVENTS.has(text(event.eventCode, 100).split('.').at(-1) ?? '')) return time;
  const zone = countryTimeZone(destination);
  return (zone ? isoTime(wall, zone)?.iso : null) ?? time;
}

/** An origin office's event on a parcel from abroad, on that office's clock when [clock.ts](clock.ts) lists it. */
function originClock(event: JsonObject, time: string, imported: boolean): string {
  const zone = imported ? swissPostOriginZone(text(event.city, 100)) : null;
  const wall = WALL_CLOCK.exec(time)?.[1];
  return (zone && wall ? isoTime(wall, zone)?.iso : null) ?? time;
}

/** A consolidator's notice that its letter will shortly be handed over, on its system's clock ([clock.ts](clock.ts)). */
function preAdviceClock(event: JsonObject, time: string): string {
  const wall = WALL_CLOCK.exec(time)?.[1];
  if (!wall || text(event.eventCode, 100).split('.').at(-1) !== PRE_ADVICE) return time;
  return isoTime(wall, PRE_ADVICE_ZONE)?.iso ?? time;
}

/** Ready at a PickPost or My Post 24 point, and the point's own arrival scans. */
const PICKUP_READY = new Set(['2101', '2102']);
const PICKUP_ARRIVAL = new Set(['1001', '1100']);
const LEFT_THE_POINT = new Set<string>(['out_for_delivery', 'delivered', 'failed_attempt', 'returned']);

/**
 * A parcel still waiting at its pickup point when the point scans its arrival
 * after the ready-for-pickup scan: a newest-first history whose newest scan is
 * that arrival, with a ready scan before it and nothing in between that takes
 * the parcel out again.
 */
function heldForPickup(events: readonly CarrierEvent[]): boolean {
  const codeOf = (event: CarrierEvent) => event.provider_code?.split('.').at(-1) ?? '';
  if (!events[0] || !PICKUP_ARRIVAL.has(codeOf(events[0]))) return false;
  const ready = events.findIndex((event) => PICKUP_READY.has(codeOf(event)) && event.stage === 'ready_for_pickup');
  return ready > 0 && events.slice(0, ready).every((event) => !LEFT_THE_POINT.has(event.stage ?? ''));
}

export function parseSwissPostShipment(
  item: JsonObject,
  rawEvents: unknown[],
  translations: Record<string, string> = {},
): CarrierResult {
  const globalStatus = text(item.globalStatus, 100);
  let status: CarrierStatus = STATUS_MAP.get(globalStatus) ?? 'in_transit';
  const internationalType = item.internationalImport
    ? 'IMPORT'
    : item.internationalExport
      ? 'EXPORT'
      : 'INLAND';
  const destination = text(item.recipientCountry, 10).toUpperCase();
  const abroad = item.internationalExport === true && !item.internationalImport && /^[A-Z]{2}$/.test(destination)
    && destination !== 'CH' ? destination : null;
  const events: CarrierEvent[] = [];
  for (const rawEvent of rawEvents.slice(0, 100)) {
    if (!isRecord(rawEvent)) continue;
    const time = text(rawEvent.timestamp, 100);
    const eventCode = text(rawEvent.eventCode, 100);
    if (!time || !eventCode) continue;
    const event: CarrierEvent = {
      time: preAdviceClock(rawEvent, originClock(rawEvent, destinationClock(rawEvent, time, abroad), item.internationalImport === true)),
      location: eventLocation(rawEvent),
      description: eventDescription(rawEvent, translations, internationalType),
      provider_code: eventCode,
    };
    const stage = swissPostEventStage(eventCode, text(rawEvent.subEventId, 50));
    if (stage) event.stage = stage;
    events.push(event);
  }
  // Swiss Post can list one scan twice at one instant, once with its place and once without;
  // the copy without a place adds nothing.
  const scan = (event: CarrierEvent) => [event.provider_code, event.time, event.description, event.stage].join('\u0000');
  const placed = new Set(events.filter((event) => event.location).map(scan));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (!events[index]!.location && placed.has(scan(events[index]!))) events.splice(index, 1);
  }
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((left, right) => timestamp(right.time ?? '') - timestamp(left.time ?? ''));
  // The newest scan's own stage leads; the shipment summary fills in when that
  // scan has none (an enquiry note, an unmapped code, or no scans at all).
  let stage: Stage | undefined = (events[0]?.stage as Stage | undefined) ?? GLOBAL_STATUS_STAGE[globalStatus];
  // A shipment sent back reads "Delivered" once it reaches its sender again;
  // the summary is what says it came back.
  if ((globalStatus === 'RETURNED' || item.returned === true) && (!events[0]?.stage || stage === 'delivered')) {
    stage = 'returned';
  }
  if (stage === 'in_transit' && heldForPickup(events)) stage = 'ready_for_pickup';
  if (stage && STAGE_STATUS[stage]) status = STAGE_STATUS[stage]!;
  let lastStatusText: string;
  let lastUpdate: string | null;
  if (events[0]) {
    lastStatusText = events[0].description ?? 'Tracking update';
    lastUpdate = events[0].time ?? null;
  } else {
    lastStatusText = globalStatus;
    lastUpdate = text(item.lastEventDateTime, 100) || null;
  }
  const finished = stage === 'delivered' || stage === 'returned';
  const deliveredAt = status === 'delivered'
    ? (/T\d{2}:\d{2}/.test(text(item.deliveryDate, 100)) ? text(item.deliveryDate, 100) : events[0]?.time ?? null)
    : null;
  const weight = weightKg(item);
  const dimensions = dimensionsText(item);
  return {
    status,
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: lastStatusText,
    last_update: lastUpdate,
    expected_delivery: finished ? null : swissPostExpectedDelivery(item),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(dimensions ? { dimensions_text: dimensions } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    timezone: 'Europe/Zurich',
    global_status: globalStatus,
    canonical_tracking_number: comparableShipmentNumber(item.shipmentNumber) || undefined,
    ...(/^[A-Z0-9]{4,40}$/.test(comparableShipmentNumber(item.internationalBarcode))
      ? { international_tracking_number: comparableShipmentNumber(item.internationalBarcode) } : {}),
    delivery_range: item.deliveryRange,
    delivery_time_interval: item.deliveryTimeInterval,
    // The summary without its events, as when their optional call fails; a provider may hold them.
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}

export class SwissPostTracker {
  readonly #translations = new Map<SwissPostLanguage, Record<string, string>>();
  /** When a table may be asked for again: while one load runs, and for a while after one fails. */
  readonly #translationRetryAt = new Map<SwissPostLanguage, number>();
  readonly #fetcher: typeof fetch | undefined;

  constructor(options: SwissPostOptions = {}) {
    this.#fetcher = options.fetcher;
  }

  async readJson(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit = {},
    budget?: LookupBudget,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const { bytes } = await fetchBounded(url, budget ? { ...init, signal: budget.signal } : init, {
      provider: 'Swiss Post tracking',
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, timeoutMs, budget?.remainingMs() ?? REQUEST_TIMEOUT_MS),
      fetcher,
    });
    return swissPostJson(bytes);
  }

  /**
   * A call of the lookup's chain, sent once more if it fails to reach Swiss Post or hangs: the
   * first gets at most half of what is left, so the second fits in the rest. The search's POST
   * only files the number under the throwaway user, so it is sent again like a read.
   */
  #readRetrying(fetcher: typeof fetch, url: string, init: RequestInit, budget: LookupBudget): Promise<unknown> {
    return withNetworkRetry(budget, (timeoutMs) => this.readJson(fetcher, url, init, budget, timeoutMs));
  }

  /**
   * Cached for the process, one per language: a table is large, static, and shared by every
   * lookup in its language. Lookups that come while it loads, or within ten minutes of a failed
   * or empty load, go without it and fall back to the event's own wording; the first after
   * that asks again.
   */
  async loadTranslations(fetcher: typeof fetch, budget?: LookupBudget, language: SwissPostLanguage = 'en'): Promise<Record<string, string>> {
    const cached = this.#translations.get(language);
    if (cached) return cached;
    if (Date.now() < (this.#translationRetryAt.get(language) ?? 0)) return {};
    this.#translationRetryAt.set(language, Infinity);
    try {
      const payload = await this.readJson(fetcher, translationsUrl(language), { headers: HEADERS }, budget);
      const raw = isRecord(payload) && isRecord(payload['shipment-text--'])
        ? payload['shipment-text--']
        : {};
      const translations = Object.fromEntries(
        Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
      if (Object.keys(translations).length === 0) {
        this.#translationRetryAt.set(language, Date.now() + TRANSLATION_RETRY_MS);
        return {};
      }
      this.#translations.set(language, translations);
      return translations;
    } catch (error) {
      // A lookup that ended says nothing about the table: the next one asks again.
      if (budget && ended(budget)) {
        this.#translationRetryAt.set(language, 0);
        throw error;
      }
      this.#translationRetryAt.set(language, Date.now() + TRANSLATION_RETRY_MS);
      return {};
    }
  }

  /** The shipment, its scans worded in `language`. */
  async fetch(trackingNumber: string, context: TrackingContext = {}, language: SwissPostLanguage = 'en'): Promise<CarrierResult> {
    const budget = lookupBudget(context, DEFAULT_BUDGET_MS);
    const fetcher = makeFetchCookie(this.#fetcher ?? fetch, new CookieJar());
    const userResult = await withNetworkRetry(budget, (timeoutMs) => fetchBounded(`${API_BASE}/user`, { headers: HEADERS, signal: budget.signal }, {
      provider: 'Swiss Post tracking',
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, timeoutMs),
      fetcher,
    }));
    const userPayload = swissPostJson(userResult.bytes);
    if (!isRecord(userPayload)) throw new SchemaError(PROVIDER, 'Swiss Post returned an invalid anonymous user response');
    const userId = text(userPayload.userIdentifier);
    if (!userId) throw new SchemaError(PROVIDER, 'Swiss Post did not return an anonymous user identifier');
    const csrf = userResult.response.headers.get('x-csrf-token') ?? '';
    const headers = { ...HEADERS, 'x-csrf-token': csrf };
    const query = new URLSearchParams({ userId });
    const historyPayload = await this.#readRetrying(fetcher, `${API_BASE}/history?${query}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchQuery: trackingNumber }),
    }, budget);
    const hash = isRecord(historyPayload) ? text(historyPayload.hash) : '';
    if (!hash) throw new SchemaError(PROVIDER, 'Swiss Post did not return a shipment search identifier');
    const items = await this.#readRetrying(
      fetcher,
      `${API_BASE}/history/not-included/${encodeURIComponent(hash)}?${query}`,
      { headers },
      budget,
    );
    if (!Array.isArray(items)) {
      throw new SchemaError(PROVIDER, 'Swiss Post returned an invalid shipment response');
    }
    if (items.length === 0) throw new NotFoundError(PROVIDER);
    if (!items.every(isRecord)) {
      throw new SchemaError(PROVIDER, 'Swiss Post returned an invalid shipment response');
    }
    const requested = comparableShipmentNumber(trackingNumber);
    const identified = items.filter((candidate) => comparableShipmentNumber(candidate.shipmentNumber));
    if (identified.length === 0) {
      throw new SchemaError(PROVIDER, 'Swiss Post did not return a shipment identifier');
    }
    const matches = identified.filter((candidate) =>
      comparableShipmentNumber(candidate.shipmentNumber) === requested
      || comparableShipmentNumber(candidate.internationalBarcode) === requested,
    );
    if (matches.length === 0) throw new SchemaError(PROVIDER, 'Swiss Post returned a different shipment');
    if (matches.length !== 1) throw new SchemaError(PROVIDER, 'Swiss Post returned an ambiguous shipment');
    const item = matches[0]!;
    const identity = text(item.identity);
    let events: unknown[] = [];
    if (identity) {
      try {
        const payload = await this.#readRetrying(
          fetcher,
          `${API_BASE}/shipment/id/${encodeURIComponent(identity)}/events`,
          { headers },
          budget,
        );
        if (Array.isArray(payload)) events = payload;
      } catch (error) {
        // A shipment summary is still useful when the optional event call fails.
        if (ended(budget)) throw error;
      }
    }
    const translations = events.length > 0 ? await this.loadTranslations(fetcher, budget, language) : {};
    const result = parseSwissPostShipment(item, events, translations);
    // The pickup notice names the site holding the parcel; that site's record gives its name and address.
    const office = result.current_stage === 'ready_for_pickup' ? swissPostPickupOffice(item) : '';
    if (office) {
      const point = await this.pickupPoint(fetcher, headers, office, budget, context.signal);
      if (point) result.pickup_point = point;
    }
    return result;
  }

  /** The pickup point, or nothing: the parcel is found without it. Only the caller's cancellation ends the lookup. */
  private async pickupPoint(
    fetcher: typeof fetch,
    headers: Record<string, string>,
    office: string,
    budget: LookupBudget,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    try {
      return swissPostPickupPoint(await this.readJson(
        fetcher,
        `${API_BASE}/autocomplete/postoffice/id/${encodeURIComponent(office)}`,
        { headers },
        budget,
      ), office);
    } catch {
      signal?.throwIfAborted();
      return '';
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SwissPostTracker({ fetcher: environment.fetcher });
  return {
    id: 'swiss-post',
    steps: ['direct'],
    // Swiss Post words its scans in the reader's language when it has one, else in English.
    track: (input, context) => tracker.fetch(input.number, context, readerLanguage(input, SWISS_POST_LANGUAGES) ?? 'en'),
  };
};
