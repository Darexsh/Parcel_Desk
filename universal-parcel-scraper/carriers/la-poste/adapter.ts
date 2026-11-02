
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { CarrierError, InvalidInputError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepSpec } from '../../core/runner/index.js';
import { firstAttemptMs, isNetworkFailure } from '../../core/runner/networkRetry.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { countryTimeZone, explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { eventStage, eventStatus, GROUP_STATUSES } from './status.js';

// Protocol provenance:
// - `suivi-unifie` is the keyless feed the public tracking page calls: one
//   array entry per requested number, each with a `returnCode`, a `shipment`
//   and its `event` list. It covers Colissimo, tracked mail, Chronopost and
//   Delivengo, which is why those carriers share this adapter.
// - The response is matched on `shipment.idShip`: a feed entry for another
//   number is refused rather than projected. A Smart Data number typed without
//   its optional check character comes back under the full fifteen characters.
// - `returnCode` 104 is the positive "unknown shipment"; any other non-zero
//   code is an inconclusive provider failure.
// - An HTTP 400 whose `response.returnCode` is 412 ("numéro non postal") is
//   La Poste refusing a number outside its formats, so it is invalid input.
//   Any other 400 stays an HTTP failure.
// - Production HTTP 403s carried La Poste's "Site indisponible - Incident en
//   cours" page and immediately following checks succeeded, so a 403 is
//   retried up to three times inside the original deadline (see README.md).
// - A request that hangs would otherwise take the whole budget, so a network
//   failure or timeout is retried once too, and an attempt gets at most half
//   of what is left while that retry remains.
// - The tracking page links the point holding a parcel to La Poste's locator,
//   `localiser.laposte.fr/{idPoint}`, which redirects to the point's page. That
//   page carries the point's record, address included, as JSON in
//   `Yext["profile"]`; `meta.id` repeats the point's id.
const TRACKING_API = 'https://www.laposte.fr/ssu/sun/back/suivi-unifie';
const TRACKING_PAGE = 'https://www.laposte.fr/outils/suivre-vos-envois';
const LOCATOR = 'https://localiser.laposte.fr';
const TIMEZONE = 'Europe/Paris';
const DEFAULT_TIMEOUT_MS = 15_000;
/** The locator answers from a cache within a fraction of a second. */
const ADDRESS_TIMEOUT_MS = 3_000;
/** Points whose address a tracker remembers: a waiting parcel is looked up again and again. */
const MAX_REMEMBERED_POINTS = 500;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_EVENTS_TO_RETURN = 100;
/** The provider's "unknown shipment" return code. */
const UNKNOWN_SHIPMENT_CODE = 104;
/** The return code of an HTTP 400 for a number La Poste does not issue. */
const NOT_POSTAL_CODE = 412;

function number(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** The `response.returnCode` of a rejected request, or null. */
function rejectionCode(bytes: Uint8Array): number | null {
  try {
    const body: unknown = JSON.parse(decodeText(bytes));
    return isRecord(body) && isRecord(body.response) ? number(body.response.returnCode) : null;
  } catch {
    return null;
  }
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function eventOrder(event: JsonObject): number {
  return number(event.order) ?? -1;
}

/**
 * Scans in France carry their Paris offset, so the provider's own string is
 * retained verbatim; only calendar-impossible values are dropped.
 */
function safeDate(value: unknown): string {
  const raw = clean(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:+.Z-]+)?$/i.test(raw)) return '';
  return isoTime(raw, TIMEZONE) ? raw : '';
}

/** France and the overseas places where La Poste scans items itself. */
const LA_POSTE_COUNTRIES = new Set(['FR', 'GP', 'MQ', 'GF', 'RE', 'YT', 'PM', 'BL', 'MF']);

/** An international tracked letter La Poste sends abroad: `L`, a letter, nine digits and `FR`. */
const EXPORTED_LETTER = /^L[A-Z]\d{9}FR$/;

const IMPORT = 'lettre et ppi import suivi';

/**
 * A partner post's scan abroad shows that office's wall clock, mislabelled:
 * Colissimo gives it Paris's offset, and tracked mail, imported or an
 * international tracked letter sent from France, reads it as UTC and shows it on
 * Paris's clock (a Dutch scan of such a letter reached the feed before the
 * instant it was labelled). It is read in the country's zone, or kept as a wall
 * clock when the country has several. Null at home, where an imported item's
 * arrival and transit keep the instant the relaying post shows to the minute,
 * and for other products, whose partner scans have not been compared with the
 * partner's own.
 */
function partnerClock(raw: string, country: string, product: string, exportedLetter: boolean): { time: string; local_time?: string } | null {
  if (!country || LA_POSTE_COUNTRIES.has(country) || !explicitOffsetTime(raw)) return null;
  const labelled = DateTime.fromISO(raw, { setZone: true });
  const shown = product === 'colissimo' ? labelled
    : product === IMPORT || (exportedLetter && product !== 'chronopost') ? labelled.toUTC() : null;
  const wall = shown?.toISO({ includeOffset: false, suppressMilliseconds: true });
  if (!wall) return null;
  const zone = countryTimeZone(country);
  const placed = zone ? isoTime(wall, zone) : null;
  return placed ? { time: placed.iso } : { time: '', local_time: wall };
}

/**
 * The sender's announcement (group EXPANN, code DR1), which some senders date
 * by its day alone: La Poste then gives it midnight on Paris's clock, where the
 * others carry their time of day. It keeps that day rather than a midnight
 * nobody scanned.
 */
function announcedDay(group: string, code: string, time: string): string | null {
  if (group !== 'EXPANN' || code !== 'DR1' || !explicitOffsetTime(time)) return null;
  const paris = DateTime.fromISO(time, { setZone: true }).setZone(TIMEZONE);
  return paris.isValid && paris.toFormat('HH:mm:ss.SSS') === '00:00:00.000' ? paris.toISODate() : null;
}

function expectedDate(value: unknown): string | null {
  const text = safeDate(value);
  return /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? null;
}

/**
 * A provider `returnCode` that is not a success. Code 104 is a positive
 * not-found; anything else only proves the feed could not answer.
 */
export class LaPosteTrackingError extends CarrierError {
  readonly code: number | null;

  constructor(code: number | null) {
    super(
      code === UNKNOWN_SHIPMENT_CODE ? 'not_found' : 'indeterminate',
      'La Poste',
      code === UNKNOWN_SHIPMENT_CODE
        ? 'La Poste could not locate the shipment'
        : 'La Poste tracking is unavailable',
    );
    this.name = 'LaPosteTrackingError';
    this.code = code;
  }
}

export function normalizeLaPosteTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  const domestic = /^[A-Z0-9]{2}\d{11}$/.test(value);
  const international = /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(value);
  const numericMail = /^\d{14,15}$/.test(value);
  const numericWithLetter = /^\d{14}[A-Z]$/.test(value);
  if (!domestic && !international && !numericMail && !numericWithLetter) {
    throw new InvalidInputError('La Poste', 'La Poste tracking numbers must use a supported 13-, 14- or 15-character format');
  }
  return value;
}

/** The feed's identity for the requested number, which may add a Smart Data check character. */
function sameShipment(idShip: string, requested: string): boolean {
  if (idShip === requested) return true;
  return /^\d{14}$/.test(requested) && idShip.length === 15 && dpdParcelNumber(idShip) === requested;
}

/** A two-letter country, or nothing. */
function countryCode(value: unknown): string {
  const code = clean(value, 80).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

/**
 * `arrivalCountry` repeats `originCountry` on some international items, whatever
 * the route: inbound ones name their origin and some outbound ones name France.
 * Such a pair stands only while every scan stays in that country; otherwise the
 * country of a delivery scan is the destination.
 */
function destinationCountry(context: JsonObject, events: CarrierEvent[], latest: CarrierEvent | undefined): string {
  const arrival = countryCode(context.arrivalCountry);
  if (!arrival || arrival !== countryCode(context.originCountry)) return arrival;
  if (events.every((event) => !event.location || countryCode(event.location) === arrival)) return arrival;
  return latest?.stage === 'delivered' ? countryCode(latest.location) : '';
}

export function laPosteTrackingUrl(trackingNumber: string): string {
  const url = new URL(TRACKING_PAGE);
  url.searchParams.set('code', normalizeLaPosteTrackingNumber(trackingNumber));
  return url.toString();
}

export function laPosteTrackingApiUrl(trackingNumber: string): string {
  const normalized = normalizeLaPosteTrackingNumber(trackingNumber);
  const url = new URL(`${TRACKING_API}/${encodeURIComponent(normalized)}`);
  url.searchParams.set('lang', 'fr');
  return url.toString();
}

/**
 * The street and town of the point a locator page describes, a line each, if it is the
 * requested one. Its phone, opening hours, services and coordinates are not read.
 */
function pointAddress(html: string, id: string): string {
  const marker = 'Yext["profile"] = ';
  const start = html.indexOf(marker);
  const end = start < 0 ? -1 : html.indexOf('; return Yext;', start);
  if (end < 0) return '';
  let profile: unknown;
  try {
    profile = JSON.parse(html.slice(start + marker.length, end));
  } catch {
    return '';
  }
  if (!isRecord(profile) || !isRecord(profile.meta) || clean(profile.meta.id, 40) !== id || !isRecord(profile.address)) return '';
  const street = clean(profile.address.line1, 120);
  const city = clean(profile.address.city, 80);
  if (!street || !city) return '';
  return `${street}\n${[clean(profile.address.postalCode, 16), city].filter(Boolean).join(' ')}`;
}

export function parseLaPosteTrackingResponse(
  payload: unknown,
  trackingNumber: string,
): CarrierResult {
  return parseShipment(payload, trackingNumber).result;
}

/** `point` is the locator id of the pickup point the result names, else empty. */
function parseShipment(payload: unknown, trackingNumber: string): { result: CarrierResult; point: string } {
  const requested = normalizeLaPosteTrackingNumber(trackingNumber);
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new SchemaError('La Poste', 'La Poste returned an invalid tracking response');
  }

  const responses = payload.filter(isRecord);
  if (responses.length === 0) {
    throw new SchemaError('La Poste', 'La Poste returned an invalid tracking response');
  }
  const response = responses.find((candidate) => {
    const shipment = isRecord(candidate.shipment) ? candidate.shipment : {};
    return sameShipment(clean(shipment.idShip, 64).toLocaleUpperCase('en-US'), requested);
  });
  if (!response) {
    const providerError = responses.find((candidate) => ![0, 200].includes(number(candidate.returnCode) ?? -1));
    if (providerError) {
      throw new LaPosteTrackingError(number(providerError.returnCode));
    }
    throw new SchemaError('La Poste', 'La Poste returned a different shipment');
  }

  const returnCode = number(response.returnCode);
  if (returnCode === null || ![0, 200].includes(returnCode)) {
    throw new LaPosteTrackingError(returnCode);
  }
  const shipment = isRecord(response.shipment) ? response.shipment : {};
  const rawEvents = records(shipment.event).sort((left, right) => {
    const orderDifference = eventOrder(right) - eventOrder(left);
    if (orderDifference !== 0) return orderDifference;
    return safeDate(right.date).localeCompare(safeDate(left.date));
  });
  // Projection allowlist: nothing but status wording, time, coarse location and
  // the provider's own codes leaves this function. Recipient blocks, addresses
  // and proof-of-delivery fields in the payload are never read.
  const product = clean(shipment.product, 40).toLocaleLowerCase('en-US');
  const kept = rawEvents.slice(0, MAX_EVENTS_TO_RETURN).filter((event) => clean(event.label) || safeDate(event.date));
  const events: CarrierEvent[] = kept.map((event) => {
    const description = clean(event.label);
    const group = clean(event.group, 40).toLocaleUpperCase('en-US');
    const code = clean(event.code, 40).toLocaleUpperCase('en-US');
    const time = safeDate(event.date);
    const location = clean(event.country, 80);
    const day = announcedDay(group, code, time);
    return {
      ...(day ? { local_time: day } : { time, ...partnerClock(time, countryCode(location), product, EXPORTED_LETTER.test(requested)) }),
      location,
      description: description || 'Tracking update',
      stage: eventStage(group, code, description),
      ...(group || code ? { provider_code: [group, code].filter(Boolean).join('/') } : {}),
    };
  });

  const timeline = records(shipment.timeline)
    .filter((step) => step.status === true)
    .sort((left, right) => (number(right.id) ?? -1) - (number(left.id) ?? -1));
  // A finished shipment, or one whose progress bar ends on a delivery, keeps
  // that state: a pre-advice La Poste files after it is paperwork, not a step
  // back to registered.
  const finished = shipment.isFinal === true
    || GROUP_STATUSES.get(clean(timeline[0]?.code, 40).toLocaleUpperCase('en-US')) === 'delivered';
  const current = finished ? Math.max(0, events.findIndex((event) => event.stage !== 'registered')) : 0;
  const latestRaw = (current > 0 ? kept[current] : rawEvents[0]) ?? {};
  const latest = events[current];
  const currentState = isRecord(shipment.currentState) ? shipment.currentState : {};
  const fallbackLabel = clean(currentState.shortLabel) || clean(timeline[0]?.shortLabel);
  const latestLabel = latest?.description || fallbackLabel || clean(response.returnMessage);
  const latestGroup = clean(latestRaw.group, 40);
  const latestCode = clean(latestRaw.code, 40);
  const context = isRecord(shipment.contextData) ? shipment.contextData : {};
  const destination = destinationCountry(context, events, latest);
  const shipped = clean(shipment.idShip, 64).toLocaleUpperCase('en-US');
  // The merchant La Poste shows on the tracking page. Recipient blocks stay unread.
  const sender = clean(context.merchantName, 200);
  // The post office, locker or shop holding the parcel: its name, and its id
  // on La Poste's locator, which gives its address.
  const removal = isRecord(context.removalPoint) ? context.removalPoint : {};
  const pickupPoint = latest?.stage === 'ready_for_pickup' && clean(removal.type, 20) ? clean(removal.name, 200) : '';
  const point = clean(removal.idPoint, 40);
  // A Chronopost item names Chronopost, whose own tracking holds the scans after
  // export and the partner references this feed can omit. Its number there is
  // the feed's identity, which only differs from the input by a check character.
  const chronopost = clean(shipment.product, 40).toLocaleLowerCase('en-US') === 'chronopost';
  const partner = isRecord(context.partner) ? context.partner : {};
  const deliveryCarrier = chronopost ? 'chronopost' : carrierIdFromPartner(clean(partner.name, 80), clean(partner.url, 2048));
  const deliveryNumber = !chronopost ? clean(partner.reference, 64).toUpperCase() : shipped !== requested ? shipped : '';
  const result: CarrierResult = {
    status: eventStatus(latestGroup, latestCode, latestLabel, events.length > 0),
    // The status vocabulary has no pickup or customs value; without the stage
    // the sync would re-read the sentence and fall back to "out for delivery".
    ...(latest?.stage ? { current_stage: latest.stage } : {}),
    last_status_text: latestLabel || 'Tracking information received',
    last_update: events[0]?.time || (events[0]?.local_time ? null : safeDate(timeline[0]?.date) || null),
    ...(!events[0]?.time && events[0]?.local_time ? { last_update_local: events[0].local_time } : {}),
    // A delivered item can stay non-final with its delivery time as the estimate.
    expected_delivery: shipment.isFinal === true || latest?.stage === 'delivered' ? null : expectedDate(shipment.estimDate),
    ...(latest?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(sender ? { sender_name: sender } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(shipped !== requested ? { canonical_tracking_number: shipped } : {}),
    timezone: TIMEZONE,
    ...(destination ? { destination_country: destination } : {}),
    ...(deliveryCarrier ? {
      delivery_carrier: deliveryCarrier,
      ...(/^[A-Z0-9]{4,40}$/.test(deliveryNumber) ? { delivery_tracking_number: deliveryNumber } : {}),
    } : {}),
    events,
  };
  return { result, point: pickupPoint && /^[A-Za-z0-9]{1,20}$/.test(point) ? point : '' };
}

export interface LaPosteTrackerOptions {
  timeoutMs?: number;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

export class LaPosteTracker {
  readonly timeoutMs: number;
  private readonly fetcher?: typeof fetch;
  private readonly recorder?: StepRecorder;
  private readonly userAgent: string;
  /** The locator's page for a point is large and its address does not change. */
  private readonly addresses = new Map<string, string>();

  constructor(options: LaPosteTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('La Poste timeout must be positive');
    }
    this.fetcher = options.fetcher;
    this.recorder = options.recorder;
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const normalized = normalizeLaPosteTrackingNumber(trackingNumber);
    const budgetMs = context.budgetMs ?? this.timeoutMs;
    const deadline = performance.now() + budgetMs;
    const request = async (timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(laPosteTrackingApiUrl(normalized), {
        signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9',
          Referer: laPosteTrackingUrl(normalized),
          'User-Agent': this.userAgent,
        },
      }, {
        provider: 'La Poste tracking',
        timeoutMs: Math.max(1, Math.floor(Math.min(this.timeoutMs, timeoutMs))),
        maxBytes: MAX_RESPONSE_BYTES,
        fetcher: this.fetcher,
        allowHttpStatuses: [400],
      });
      if (response.status === 400) {
        if (rejectionCode(bytes) === NOT_POSTAL_CODE) throw new InvalidInputError('La Poste', 'La Poste does not issue this tracking number', { reason: 'wrong_number' });
        throw new UpstreamHttpError('La Poste tracking', 400);
      }
      const { result, point } = parseShipment(parseJsonBytes(bytes, 'La Poste'), normalized);
      // The feed names the point holding the parcel without its address, which the locator adds.
      if (point) {
        const address = await this.pointAddress(point, signal, deadline - performance.now());
        if (address) result.pickup_point = `${result.pickup_point}\n${address}`;
      }
      return result;
    };
    // La Poste's edge answers single lookups with an HTTP 403 "Site indisponible
    // - Incident en cours" page while another parcel, or the same one a moment
    // later, is answered normally. It is a hiccup of that one request, not
    // maintenance, so the page is retried like any other 403: three immediate
    // retries sharing the original deadline. A real incident still fails every
    // attempt within seconds and reaches the router. A request that fails to
    // reach La Poste, or hangs until its timeout, gets one retry as well. Until
    // that retry is spent, an attempt gets at most half of what is left, so a
    // hang leaves it time. Do not retry other HTTP or parsing failures, nor a
    // not-found. Once the deadline is spent the retry is refused, so the caller
    // still sees the provider's own rejection rather than a budget error.
    let networkRetried = false;
    const retriable = (error: unknown): boolean => deadline - performance.now() >= 1
      && ((error instanceof UpstreamHttpError && error.status === 403) || (!networkRetried && isNetworkFailure(error)));
    const retry: StepSpec<CarrierResult> = {
      id: 'retry',
      recovers: retriable,
      run: ({ remainingMs, signal, previousError }) => {
        if (isNetworkFailure(previousError)) networkRetried = true;
        return request(networkRetried ? remainingMs : firstAttemptMs(remainingMs), signal);
      },
    };
    return await runSteps<CarrierResult>({
      carrier: 'la-poste', budgetMs, signal: context.signal, recorder: this.recorder,
    }, [
      { id: 'direct', run: ({ remainingMs, signal }) => request(firstAttemptMs(remainingMs), signal) },
      retry,
      { ...retry },
      { ...retry },
    ]);
  }

  /**
   * The point's street and town, or nothing: the parcel is found, and its pickup point keeps its
   * name without them. The request gets at most half of what is left, so the result still has
   * time to return.
   */
  private async pointAddress(id: string, signal: AbortSignal, remainingMs: number): Promise<string> {
    const known = this.addresses.get(id);
    if (known) return known;
    const timeoutMs = Math.floor(Math.min(ADDRESS_TIMEOUT_MS, remainingMs / 2));
    if (timeoutMs < 1) return '';
    try {
      const { bytes } = await fetchBounded(`${LOCATOR}/${encodeURIComponent(id)}`, {
        signal,
        headers: { Accept: 'text/html', 'Accept-Language': 'fr-FR,fr;q=0.9', 'User-Agent': this.userAgent },
      }, {
        provider: 'La Poste locator',
        timeoutMs,
        maxBytes: MAX_RESPONSE_BYTES,
        // The point's id redirects to its page, named after its town.
        redirect: 'follow',
        fetcher: this.fetcher,
      });
      const address = pointAddress(decodeText(bytes), id);
      if (address) {
        if (this.addresses.size >= MAX_REMEMBERED_POINTS) this.addresses.delete(this.addresses.keys().next().value!);
        this.addresses.set(id, address);
      }
      return address;
    } catch {
      signal.throwIfAborted();
      return '';
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LaPosteTracker({
    fetcher: environment.fetcher,
    recorder: environment.recorder,
    userAgent: environment.userAgent,
  });
  return {
    id: 'la-poste', plannedScans: true,
    // One keyless request, then up to three immediate retries of the same
    // request after a transient HTTP 403, and one after a network failure or
    // timeout, inside the original deadline.
    steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeLaPosteTrackingNumber(number))),
  };
};
