
/**
 * Paack recipient tracking.
 *
 * The public page is a Remix application: one bounded GET with the order
 * number and the delivery postcode returns server-rendered HTML whose
 * `window.__remixContext` already holds the loader response for the tracking
 * route. Reading that embedded payload avoids a second, undocumented API call
 * and gives the same data the page itself renders.
 *
 * Paack answers the number and postcode as a pair: a wrong pair is redirected
 * back to the form with `err=true`, or answered with an explicit "order not
 * found" message, and both become a clean not-found. A tracking page is
 * therefore the order for that pair. It does not echo the number when that is
 * a label barcode (`external_id` is then the retailer's own reference), but it
 * does echo the delivery postcode, which must agree with the requested one.
 *
 * Privacy: the loader payload carries the retailer, the recipient's name,
 * e-mail, phone and address, the PaackGo Point pickup code and QR link, and
 * per-event `variables` that repeat them. `parse()` copies nothing from those:
 * each event is rebuilt from its timestamp, our own description and the mapped
 * stage, and the only order-level fields read are the delivery postcode,
 * compared and never copied, the delivery country, which picks the window's
 * clock, the delivery window, and the PaackGo Point's name and address while
 * the parcel waits there.
 */
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, IndeterminateError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { recoverableByDefault, runSteps } from '../../core/runner/index.js';
import { firstAttemptMs } from '../../core/runner/networkRetry.js';
import { countryCode, countryTimeZone, explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, UpstreamHttpError, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { PAACK_EVRI_NUMBER, trackPaackThroughEvri } from './evri.js';
import { classifyPaackEvent } from './status.js';

const TRACKING_ENDPOINT = 'https://mydeliveries.paack.app/tracking/order';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_EVENTS = 100;
const MAX_REDIRECTS = 1;
/** Steps of a delivery run that a stale banner must not hide. */
const ATTEMPT_STAGES = new Set(['failed_attempt', 'out_for_delivery', 'ready_for_pickup', 'delivered', 'returned']);
const DEFAULT_ZONE = 'Europe/Paris';
const PAACK_HOST = /(?:^|\.)paack\.(?:app|co)$/;
const NOT_FOUND_PATTERN = /order not found|incorrect order number|commande introuvable|pedido no encontrado/i;
const NOT_FOUND_PAGE_PATTERN = /order not found|incorrect order number or postal code|commande introuvable|pedido no encontrado/i;

/**
 * Kept local rather than taken from core/time: the loader mixes epoch seconds,
 * epoch milliseconds and offset-bearing ISO strings in the same field, and the
 * result keeps millisecond precision (`toISOString()`), which the core helpers
 * deliberately suppress.
 */
function normalizedTimestamp(value: unknown): { iso: string; timestamp: number } | null {
  let timestamp: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    timestamp = value < 10_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    timestamp = Date.parse(value.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return { iso: date.toISOString(), timestamp: date.getTime() };
}

function normalizedDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const candidate = value.trim();
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(candidate);
    if (match && !Number.isNaN(Date.parse(candidate))) return match[1]!;
  }
  return normalizedTimestamp(value)?.iso.slice(0, 10) ?? null;
}

/**
 * The clock the page shows the delivery window on: the delivery country's, and
 * the Canary Islands' for Spanish postcodes 35 and 38.
 */
function deliveryZone(country: unknown, postcode: string): string {
  return countryCode(country) === 'ES' && /^3[58]\d{3}$/.test(postcode)
    ? 'Atlantic/Canary'
    : countryTimeZone(country) ?? DEFAULT_ZONE;
}

/**
 * `expected_delivery_ts` as the page shows it: `YYYY-MM-DD HH:MM–HH:MM` on the
 * delivery clock when both ends are instants within one day, else the day
 * alone. A window that ended before the newest scan is dropped.
 */
function expectedDelivery(window: JsonObject, zone: string, newest: number): string | null {
  const start = explicitOffsetTime(window.start);
  const end = explicitOffsetTime(window.end) ?? start;
  if (!end) return normalizedDate(window.end ?? window.start);
  if (end.timestamp < newest) return null;
  const clock = (time: ParsedTime) => DateTime.fromMillis(time.timestamp, { zone }).toFormat('yyyy-MM-dd HH:mm');
  const last = clock(end);
  const first = start ? clock(start) : last;
  return first.slice(0, 10) === last.slice(0, 10) && first < last
    ? `${first}–${last.slice(11)}`
    : last.slice(0, 10);
}

function routeData(payload: unknown): JsonObject {
  if (!isRecord(payload)) throw new SchemaError('Paack', 'Paack returned an invalid tracking response');
  if (isRecord(payload.orderTrackData)) return payload;
  const state = payload.state;
  if (!isRecord(state) || !isRecord(state.loaderData)) {
    throw new SchemaError('Paack', 'Paack returned incomplete tracking details');
  }
  const route = state.loaderData['routes/tracking.order'];
  if (!isRecord(route)) throw new SchemaError('Paack', 'Paack returned incomplete tracking details');
  return route;
}

function errorText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  return [payload.error, payload.message, payload.statusText]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function remixContext(html: string): unknown {
  const $ = load(html);
  let serialized = '';
  $('script').each((_, element) => {
    if (serialized) return;
    const script = $(element).html() ?? '';
    const marker = 'window.__remixContext';
    const markerIndex = script.indexOf(marker);
    if (markerIndex < 0) return;
    const equalsIndex = script.indexOf('=', markerIndex + marker.length);
    if (equalsIndex < 0) return;
    serialized = script.slice(equalsIndex + 1).trim().replace(/;\s*$/, '');
  });
  if (!serialized) throw new SchemaError('Paack', 'Paack did not return tracking details');
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new SchemaError('Paack', 'Paack returned an invalid tracking response', { cause: error });
  }
}

export function normalizePaackTrackingNumber(raw: string): string {
  const value = raw.trim().toLocaleUpperCase('en-US').replace(/\s/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{4,40}$/.test(value)) {
    throw new InvalidInputError('Paack', 'Paack tracking numbers must contain 4 to 40 ASCII letters and digits, including at least one digit');
  }
  return value;
}

export function normalizePaackPostcode(raw: string): string {
  const value = raw.trim().toLocaleUpperCase('en-US');
  if (!/^(?=.{3,10}$)(?=.*\d)[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/.test(value)) {
    throw new InvalidInputError('Paack', 'Paack tracking requires a 3- to 10-character alphanumeric delivery postcode');
  }
  return value.replace(/\s+/g, '');
}

function trackingOrderUrl(base: string, trackingNumber: string, postcode: string): string {
  const url = new URL(base);
  url.searchParams.set('tracking_number', trackingNumber);
  url.searchParams.set('postal_code', postcode);
  return url.toString();
}

export function paackTrackingUrl(rawTrackingNumber: string, rawPostcode: string): string {
  return trackingOrderUrl(
    TRACKING_ENDPOINT,
    normalizePaackTrackingNumber(rawTrackingNumber),
    normalizePaackPostcode(rawPostcode),
  );
}

/**
 * Where a redirect from the lookup leads. `err=true` is Paack's answer to a
 * wrong pair. The same lookup on another Paack host is followed: the page is
 * moving from mydeliveries.paack.app to paack.co, and the old host forwards
 * some lookups there before checking the postcode. Anything else proves
 * nothing about the parcel.
 */
function redirectTarget(
  location: string | null,
  from: string,
  trackingNumber: string,
  postcode: string,
): { notFound: true } | { url: string } | null {
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' || !PAACK_HOST.test(target.hostname)) return null;
  if (target.searchParams.get('err') === 'true') return { notFound: true };
  const echoes = (name: string, value: string) => (
    (target.searchParams.get(name) ?? '').toLocaleUpperCase('en-US').replace(/\s/g, '') === value
  );
  if (!target.pathname.endsWith('/tracking/order')
    || !echoes('tracking_number', trackingNumber)
    || !echoes('postal_code', postcode)) return null;
  return { url: trackingOrderUrl(`${target.origin}${target.pathname}`, trackingNumber, postcode) };
}

/**
 * The PaackGo Point the page names: `pudo_name`, then `pudo_address` on the
 * following lines. The address is one string Paack formats itself; the page
 * prints it as it comes and breaks it only where it holds a line break. The
 * pickup code (`pudo_passcode`), QR link and collection deadline beside them
 * are never read.
 */
function pickupPoint(order: JsonObject): string {
  const name = clean(order.pudo_name, 120);
  if (!name) return '';
  const address = typeof order.pudo_address === 'string'
    ? order.pudo_address.split('\n').map((line) => clean(line, 200)).filter(Boolean)
    : [];
  return [name, ...address].join('\n');
}

/**
 * The steps that happened: the timeline's, then the history's. The history
 * (`triggeredEventList`) repeats the timeline's steps under the same `uniq_id`
 * and adds those the page keeps off the timeline (`timeline: false`), such as
 * a failed attempt, the new attempt and the courier assigned to it.
 */
function happenedSteps(route: JsonObject): JsonObject[] {
  const steps = new Map<string, JsonObject>();
  for (const list of [route.eventList, route.triggeredEventList]) {
    if (!Array.isArray(list)) continue;
    const timed = list.slice(0, 500).flatMap((step) => {
      if (!isRecord(step)) return [];
      const time = normalizedTimestamp(step.timestamp ?? step.time);
      return time ? [{ step, time }] : [];
    });
    // The timeline runs oldest first and the history newest first; each is read newest first.
    if (listsNewestFirst(timed.map(({ time }) => ({ time: time.iso }))) === false) timed.reverse();
    for (const { step, time } of timed) {
      const key = typeof step.uniq_id === 'string' && step.uniq_id
        ? step.uniq_id
        : `${String(step.id)}|${time.timestamp}`;
      if (!steps.has(key) || (!steps.get(key)!.label && step.label)) steps.set(key, step);
    }
  }
  return [...steps.values()];
}

/** Letters and digits only, so "SW1A 1AA" and "4445-027" compare by content. */
function postcodeKey(value: string): string {
  return value.toLocaleUpperCase('en-US').replace(/[^A-Z0-9]/g, '');
}

export function parsePaackTrackingResponse(
  payload: unknown,
  rawPostcode: string,
): CarrierResult {
  const postcode = normalizePaackPostcode(rawPostcode);
  if (NOT_FOUND_PATTERN.test(errorText(payload))) throw new NotFoundError('Paack');
  const route = routeData(payload);
  if (NOT_FOUND_PATTERN.test(errorText(route))) throw new NotFoundError('Paack');

  const order = route.orderTrackData;
  if (!isRecord(order)) throw new SchemaError('Paack', 'Paack returned incomplete tracking details');
  // The number is not echoed when it is a label barcode; the postcode is.
  const address = isRecord(order.delivery_address) ? order.delivery_address : null;
  const echoedPostcode = typeof address?.post_code === 'string' ? postcodeKey(address.post_code) : '';
  if (echoedPostcode && echoedPostcode !== postcodeKey(postcode)) {
    throw new SchemaError('Paack', 'Paack returned a different shipment');
  }

  const parsedEvents: Array<{
    event: CarrierEvent;
    status: CarrierStatus;
    timestamp: number;
    sourceIndex: number;
  }> = [];
  happenedSteps(route).forEach((rawEvent, sourceIndex) => {
    const classified = classifyPaackEvent(rawEvent);
    const time = normalizedTimestamp(rawEvent.timestamp ?? rawEvent.time)!;
    parsedEvents.push({
      event: {
        time: time.iso,
        description: classified.description,
        stage: classified.stage,
      },
      status: classified.status,
      timestamp: time.timestamp,
      sourceIndex,
    });
  });
  parsedEvents.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  const events = parsedEvents.slice(0, MAX_EVENTS).map(({ event }) => event);
  const activeEvent = isRecord(route.activeEvent) ? route.activeEvent : null;
  const active = activeEvent ? classifyPaackEvent(activeEvent) : null;
  const activeTime = activeEvent
    ? normalizedTimestamp(activeEvent.timestamp ?? activeEvent.time)
    : null;
  const banner = active && active.status !== 'unknown' ? active : null;
  // The banner stays on "Out for delivery" after a failed attempt; a newer step
  // of a delivery run replaces it. Scheduling notes and corrections do not.
  const newer = banner && activeTime
    ? parsedEvents.find((event) => event.status !== 'unknown' && event.timestamp > activeTime.timestamp
      && ATTEMPT_STAGES.has(event.event.stage ?? ''))
    : undefined;
  const latest = newer ?? (banner ? undefined : parsedEvents.find((event) => event.status !== 'unknown'));
  const current = latest
    ? {
      status: latest.status,
      stage: latest.event.stage ?? 'in_transit',
      description: latest.event.description ?? 'Shipment update',
    }
    : banner;
  if (!current) throw new SchemaError('Paack', 'Paack returned incomplete tracking details');

  const zone = deliveryZone(address?.country, postcode);
  const newest = Math.max(activeTime?.timestamp ?? -Infinity, parsedEvents[0]?.timestamp ?? -Infinity);
  // A failed attempt keeps the window: it is the new attempt's.
  const expected = isRecord(order.expected_delivery_ts) && !['delivered', 'returned', 'exception'].includes(current.stage)
    ? expectedDelivery(order.expected_delivery_ts, zone, newest)
    : null;
  const pickup = current.stage === 'ready_for_pickup' ? pickupPoint(order) : '';
  return {
    status: current.status,
    current_stage: current.stage,
    last_status_text: current.description,
    last_update: newer?.event.time ?? activeTime?.iso ?? events[0]?.time ?? null,
    expected_delivery: expected,
    ...(pickup ? { pickup_point: pickup } : {}),
    timezone: zone,
    events,
  };
}

export function parsePaackTrackingHtml(html: string, rawPostcode: string): CarrierResult {
  // An empty body proves nothing about the shipment, so it stays indeterminate.
  if (!html.trim()) throw new IndeterminateError('Paack', 'Paack returned an empty tracking response');
  if (NOT_FOUND_PAGE_PATTERN.test(html)) throw new NotFoundError('Paack');
  return parsePaackTrackingResponse(remixContext(html), rawPostcode);
}

export interface PaackTrackerOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

export class PaackTracker {
  readonly timeoutMs: number;
  readonly fetcher?: typeof fetch;
  private readonly userAgent: string;

  constructor(options: PaackTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Paack timeout must be positive');
    }
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(rawTrackingNumber: string, rawPostcode: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizePaackTrackingNumber(rawTrackingNumber);
    const postcode = normalizePaackPostcode(rawPostcode);
    const budget = lookupBudget(context, this.timeoutMs);
    let url = paackTrackingUrl(trackingNumber, postcode);
    for (let redirects = 0; ; redirects += 1) {
      const { response, bytes } = await fetchBounded(url, {
        signal: budget.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          'User-Agent': this.userAgent,
        },
      }, {
        provider: 'Paack tracking',
        timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
        maxBytes: MAX_RESPONSE_BYTES,
        redirect: 'manual',
        fetcher: this.fetcher,
        allowHttpError: true,
      });

      if (response.status >= 300 && response.status < 400) {
        const target = redirectTarget(response.headers.get('location'), url, trackingNumber, postcode);
        if (target && 'notFound' in target) throw new NotFoundError('Paack');
        if (!target || redirects >= MAX_REDIRECTS) {
          throw new IndeterminateError('Paack', 'Paack redirected the lookup without an answer');
        }
        url = target.url;
        continue;
      }
      if (response.status === 404) throw new NotFoundError('Paack');
      if (!response.ok) throw new UpstreamHttpError('Paack tracking', response.status);
      return parsePaackTrackingHtml(decodeText(bytes), postcode);
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PaackTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'paack',
    recordsSteps: true,
    steps: ['direct', 'evri'],
    track: async (input, context = {}) => {
      const trackingNumber = normalizePaackTrackingNumber(input.number);
      const postcode = input.postcode?.trim() ?? '';
      const viaEvri = PAACK_EVRI_NUMBER.test(trackingNumber);
      return runSteps({
        carrier: 'paack', budgetMs: context.budgetMs ?? DEFAULT_TIMEOUT_MS, signal: context.signal, recorder: environment.recorder,
      }, [
        {
          // Paack's own page needs the postcode; with one, it comes first for its instants and window.
          id: 'direct',
          enabled: Boolean(postcode) || !viaEvri,
          run: ({ signal, remainingMs }) => {
            if (!postcode) throw new InputRequiredError('Paack', 'the delivery postcode');
            return tracker.fetch(trackingNumber, postcode, { signal, budgetMs: viaEvri ? firstAttemptMs(remainingMs) : remainingMs });
          },
        },
        {
          // A number Paack gave a parcel from Evri International needs no postcode there. Paack's
          // not-found answers the number and postcode pair, so this number is still asked alone.
          id: 'evri',
          enabled: viaEvri,
          recovers: (error) => carrierErrorKind(error) === 'not_found' || recoverableByDefault(error),
          run: ({ signal, remainingMs }) => trackPaackThroughEvri(trackingNumber, { signal, budgetMs: remainingMs },
            { fetcher: environment.fetcher, userAgent: environment.userAgent }),
        },
      ]);
    },
  };
};
