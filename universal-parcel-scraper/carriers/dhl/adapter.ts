/**
 * DHL Paket and tracked mail, through the public recipient endpoint behind
 * www.dhl.de (`/int-verfolgen/data`).
 *
 * The lookup establishes a cookie and CSRF session on `/config`, then reads
 * `/search` with the same `verfolgen-CSRF-token` and `verfolgen-wg` headers
 * DHL's own recipient page sends. Cookies stay in memory. A rejected or
 * expired session, and an interrupted read, get one fresh HTTP session inside
 * the `direct` step; only then does the `trawl` step ask the private browser
 * service for a solved session, whose cookies and user agent seed a new HTTP
 * session. Rate limits and server errors stay errors: they are never routed
 * through a browser.
 *
 * A record that asks for the recipient's postcode gets it, when the caller gave
 * one, through the `/shipment` POST DHL's page sends.
 *
 * DHL's business API credentials are not needed for this public flow.
 */

import makeFetchCookie from 'fetch-cookie';
import { DateTime } from 'luxon';
import { Cookie, CookieJar } from 'tough-cookie';
import {
  lookupBudget, readerLanguage, recognizeFromLookup,
  type AdapterFactory, type LookupBudget, type Recognition, type TrackingContext,
} from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, RateLimitedError, SchemaError,
  type CarrierErrorOptions,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { carrierIdFromPartnerLinks } from '../../core/catalog/hints.js';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { runSteps, singleFlight, takeTurn } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { countryCode, isoTime } from '../../core/time/index.js';
import {
  clean as cleanText, fetchBounded, parseJsonBytes, type TrawlClient, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { withoutPartnerLink } from './identity.js';
import { stageForText, statusForStage } from './status.js';

const PROVIDER = 'DHL';
const TIMEZONE = 'Europe/Berlin';
const ORIGIN = 'https://www.dhl.de';
const DATA_PATH = '/int-verfolgen/data';
const CONFIG_URL = `${ORIGIN}${DATA_PATH}/config?domain=de&language=en`;
const TRACKING_PAGE = `${ORIGIN}/en/privatkunden/dhl-sendungsverfolgung.html`;
// Where DHL's page sends the recipient's postcode for a record that asks for it. Its answer
// stays in English, the language its refusal of a wrong postcode is read in.
const SHIPMENT_URL = `${ORIGIN}${DATA_PATH}/shipment?language=en`;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const MAX_BYTES = 2_000_000;

/** The languages DHL words its scans in; it answers any other in German. */
type DHLLanguage = 'de' | 'en';

/**
 * DHL status wording occasionally carries markup. Tags are dropped without a
 * separator, as this adapter has always done, before the shared cleaner
 * collapses whitespace and caps the length.
 */
function clean(value: unknown, limit = 500): string {
  return typeof value === 'string' ? cleanText(value.replace(/<[^>]*>/g, ''), limit) : '';
}

export function normalizeDHLTrackingNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{5,40}$/.test(value)) throw new InvalidInputError(PROVIDER, 'DHL tracking number is invalid');
  return value;
}

export function dhlTrackingUrl(number: string): string {
  const url = new URL(TRACKING_PAGE);
  url.searchParams.set('piececode', normalizeDHLTrackingNumber(number));
  return url.toString();
}

/**
 * DHL timestamps carry their own offset and its delivery window is a calendar
 * day; both are kept verbatim rather than normalized, so `core/time` is used
 * to validate them in the German zone only.
 */
function date(value: unknown): string {
  const raw = clean(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(raw)) return '';
  return isoTime(raw, TIMEZONE) ? raw : '';
}

function millis(value: unknown): number {
  return isoTime(value, TIMEZONE)?.timestamp ?? 0;
}

/**
 * A scan DHL places in another country, its own or a partner post's, shows
 * that country's wall clock under Germany's offset: Cargus, Canada Post and
 * CTT give the same scans the same wall clocks in their own zones. It keeps the
 * wall clock alone, for the country to date it. An offset that is not
 * Germany's stays as DHL states it.
 */
function clock(time: string, location: string): Pick<CarrierEvent, 'time' | 'local_time'> {
  const country = countryCode(location);
  const stated = /T.*[+-]\d{2}:\d{2}$/.test(time) ? DateTime.fromISO(time, { setZone: true }) : null;
  if (!country || country === 'DE' || !stated?.isValid || stated.offset !== stated.setZone(TIMEZONE).offset) return { time };
  return { local_time: stated.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
}

/** The destination country DHL names in `zielland`, never more of the address. */
function destination(details: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const name = clean(details.zielland, 60);
  if (!name) return {};
  const code = countryCode(name);
  return code ? { destination_country: code } : { destination_country_name: name };
}

function noData(): CarrierResult {
  return { status: 'unknown', last_status_text: 'DHL has not published tracking information for this shipment yet', last_update: null, expected_delivery: null, events: [] };
}

/** The one shipment DHL returned for the requested number. */
function matchingShipment(payload: unknown, trackingNumber: string): JsonObject {
  const requested = normalizeDHLTrackingNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'DHL returned an invalid tracking response');
  if (payload.rateLimited === true || payload.isRateLimited === true) throw new RateLimitedError(PROVIDER);
  if (!Array.isArray(payload.sendungen)) throw new SchemaError(PROVIDER, 'DHL returned an invalid tracking response');
  if (payload.sendungen.length === 0) throw new SchemaError(PROVIDER, 'DHL returned an empty tracking response');
  const matches = payload.sendungen.filter(isRecord).filter((shipment) => {
    const info = isRecord(shipment.sendungsinfo) ? shipment.sendungsinfo : {};
    const details = isRecord(shipment.sendungsdetails) ? shipment.sendungsdetails : {};
    const numbers = isRecord(details.sendungsnummern) ? details.sendungsnummern : {};
    return [shipment.id, info.gesuchteSendungsnummer, numbers.sendungsnummer]
      .some((value) => clean(value, 64).toUpperCase() === requested);
  });
  if (matches.length !== 1) throw new SchemaError(PROVIDER, 'DHL did not return one matching shipment');
  return matches[0]!;
}

/**
 * DHL holds several shipments under the number and shows this one for its recipient's postcode.
 * Its page then sends the postcode with the record's `international` flag. Not when the record
 * names no shipment, or asks for the sender's postcode or the shipping date instead.
 */
function recipientPostcodeAsked(payload: unknown, trackingNumber: string): { international: boolean } | null {
  const shipment = matchingShipment(payload, trackingNumber);
  const details = isRecord(shipment.sendungsdetails) ? shipment.sendungsdetails : {};
  const missing = isRecord(shipment.sendungNichtGefunden) ? shipment.sendungNichtGefunden : {};
  if (shipment.plzBenoetigt !== true || shipment.versandDatumBenoetigt === true || details.isShipperPlz === true
    || Object.values(missing).some((flag) => flag === true)) return null;
  return { international: details.international === true };
}

/** DHL holds the parcel, but not for the postcode given: the owner has to correct it. */
function postcodeMismatch(retryAfterMs?: number): InputRequiredError {
  return new InputRequiredError(PROVIDER, 'the delivery postcode', 'DHL has the parcel, but not for this postcode', {
    reason: 'postcode_mismatch', ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { retryAfterMs } : {}),
  });
}

/**
 * DHL refuses a postcode with its "Your input was incorrect" message, and after repeated ones
 * with the time it accepts another. Other refusals stay HTTP errors.
 */
function refusedPostcode(value: unknown): InputRequiredError | null {
  if (!isRecord(value)) return null;
  if (typeof value.blockTime === 'number') return postcodeMismatch(value.blockTime - Date.now());
  return /\bincorrect\b/i.test(clean(value.error)) ? postcodeMismatch() : null;
}

/** Parse only public status fields: never persist recipient, address, signature or service data. */
export function parseDHLTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const shipment = matchingShipment(payload, trackingNumber);
  const missing = isRecord(shipment.sendungNichtGefunden) ? shipment.sendungNichtGefunden : {};
  if (shipment.plzBenoetigt === true || shipment.versandDatumBenoetigt === true) {
    // DHL asks the recipient's postcode to show a parcel it holds; a record it also calls not found names none.
    const held = shipment.plzBenoetigt === true && !Object.values(missing).some((flag) => flag === true);
    throw new InputRequiredError(PROVIDER, 'a postcode or shipping date', 'DHL requires additional verification on its tracking website',
      held ? { reason: 'parcel_found' } : undefined);
  }
  // DHL Paket's tracker answered that it holds no Paket shipment under the number. Another DHL
  // service may still know it, so it stays inconclusive, but it is an answer, not an outage.
  if (missing.keineDhlPaketSendung === true || missing.sendungsnummerNichtSuchbar === true) {
    throw new IndeterminateError(PROVIDER, 'This DHL service needs its own tracking website', { reason: 'portal_not_found' });
  }
  const details = isRecord(shipment.sendungsdetails) ? shipment.sendungsdetails : {};
  const timeline = isRecord(details.sendungsverlauf) ? details.sendungsverlauf : {};
  if (timeline.events !== undefined && !Array.isArray(timeline.events)) throw new SchemaError(PROVIDER, 'DHL returned invalid tracking events');
  const rows = (Array.isArray(timeline.events) ? timeline.events : []).filter(isRecord);
  // Arrival notices link to the delivery operator. The catalog resolves its
  // identity; the host still confirms progress through that operator's adapter.
  // The reader sees the notice without the link.
  const deliveryCarrier = carrierIdFromPartnerLinks(rows.map((event) => clean(event.status)), 'dhl');
  const scans = rows.flatMap((event) => {
    const description = withoutPartnerLink(clean(event.status));
    if (!description) return [];
    return [{ time: date(event.datum), location: clean(event.ort, 160), description, stage: stageForText(description) }];
  });
  if (listsNewestFirst(scans) === false) scans.reverse();
  const events: CarrierEvent[] = scans.sort((left, right) => millis(right.time) - millis(left.time)).slice(0, 100)
    .map(({ time, ...event }) => ({ ...event, ...clock(time, event.location) }));
  const summary = withoutPartnerLink(clean(timeline.status));
  if (!events.length && !summary && details.istZugestellt !== true) {
    if (Object.values(missing).some((flag) => flag === true)) return noData();
    throw new SchemaError(PROVIDER, 'DHL returned no usable tracking status');
  }
  const currentText = summary || events[0]?.description || 'Delivered';
  const fallback = Number(timeline.fortschritt) <= 1 ? 'registered' : String(events[0]?.stage || 'in_transit');
  const stage = details.istZugestellt === true
    ? details.ruecksendung === true ? 'returned' : 'delivered'
    : stageForText(currentText, fallback);
  const delivery = isRecord(details.zustellung) ? details.zustellung : {};
  const expected = date(delivery.zustellzeitfensterVon) || date(delivery.zustellzeitfensterBis);
  const stated = date(timeline.datumAktuellerStatus);
  const newest = events[0];
  // The status DHL dates as its newest scan abroad keeps that scan's wall clock.
  const local = newest?.local_time && (!stated || clock(stated, newest.location ?? '').local_time === newest.local_time)
    ? newest.local_time : undefined;
  return {
    status: statusForStage(stage), current_stage: stage,
    last_status_text: currentText,
    last_update: local ? null : stated || newest?.time || null,
    ...(local ? { last_update_local: local } : {}),
    expected_delivery: ['delivered', 'returned'].includes(stage) ? null : expected.slice(0, 10) || null,
    timezone: TIMEZONE, events,
    ...(deliveryCarrier ? { delivery_carrier: deliveryCarrier } : {}),
    ...destination(details),
  };
}

/**
 * DHL answered with a redirect, an unauthorized status or a non-JSON body:
 * the session is no longer accepted and has to be established again, from a
 * browser when plain HTTP keeps being refused.
 */
export class DHLSessionError extends ChallengeError {
  constructor(options?: CarrierErrorOptions) {
    super(PROVIDER, 'DHL rejected the tracking session', options);
    this.name = 'DHLSessionError';
  }
}

/** A rejected session or an interrupted read may be retried; anything else is an answer. */
/**
 * DHL's edge stops answering a session about two hours after it was opened. It
 * does not reject it: the request hangs until the timeout, and only then does
 * the renewal below succeed in well under a second. Replace the session before
 * that age so the refresh that crosses it does not wait out the timeout first.
 */
const SESSION_MAX_AGE_MS = 100 * 60_000;

function renewable(error: unknown): boolean {
  return error instanceof DHLSessionError || error instanceof UpstreamNetworkError;
}

/** What every request of one lookup shares: a signal that aborts on the caller's signal or a spent budget, and when that budget ends. */
type Limits = Pick<LookupBudget, 'signal' | 'deadline'>;

/** A request's own timeout, shortened to what is left of the lookup budget. */
function capped(timeoutMs: number, { deadline }: Limits): number {
  return Math.max(1, Math.floor(Math.min(timeoutMs, deadline - performance.now())));
}

/** A lookup that was cancelled or ran out of time starts nothing more: no renewal, no browser. */
function over(signal: AbortSignal | undefined, deadline: number): boolean {
  return signal?.aborted === true || deadline - performance.now() < 1;
}

class DHLSession {
  readonly jar = new CookieJar();
  readonly fetcher: typeof fetch;
  private userAgent = USER_AGENT;
  private token = '';
  private wg = '0';

  constructor(readonly timeoutMs: number, fetcher?: typeof fetch) {
    this.fetcher = makeFetchCookie(fetcher ?? fetch, this.jar);
  }

  async seed(cookies: unknown[], userAgent: unknown): Promise<void> {
    this.userAgent = clean(userAgent, 1_024) || USER_AGENT;
    for (const value of cookies) {
      if (!isRecord(value)) continue;
      const domain = clean(value.domain).toLowerCase().replace(/^\./, '');
      if (domain !== 'dhl.de' && !domain.endsWith('.dhl.de')) continue;
      const name = clean(value.name);
      if (!name || typeof value.value !== 'string') continue;
      const path = clean(value.path).startsWith('/') ? clean(value.path) : '/';
      await this.jar.setCookie(new Cookie({
        key: name, value: value.value, domain, path,
        secure: value.secure === true, httpOnly: value.httpOnly === true,
        expires: typeof value.expires === 'number' && value.expires > 0 ? new Date(value.expires * 1_000) : 'Infinity',
      }), `https://${domain}${path}`);
    }
  }

  async fetch(number: string, limits: Limits, postcode?: string | null, language: DHLLanguage = 'en'): Promise<CarrierResult> {
    if (!this.token) {
      const config = await this.request(CONFIG_URL, limits);
      if (typeof config.verfolgenCsrfToken !== 'string' || !config.verfolgenCsrfToken) throw new DHLSessionError();
      this.token = config.verfolgenCsrfToken;
      this.wg = typeof config.initialWG === 'number' ? String(config.initialWG) : '0';
    }
    const url = new URL(`${ORIGIN}${DATA_PATH}/search`);
    url.search = new URLSearchParams({ piececode: number, noRedirect: 'true', language }).toString();
    const payload = await this.request(url, limits);
    const asked = postcode ? recipientPostcodeAsked(payload, number) : null;
    if (!asked) return parseDHLTrackingResponse(payload, number);
    const answer = await this.request(SHIPMENT_URL, limits, { piececode: number, zip: postcode, international: asked.international });
    if (recipientPostcodeAsked(answer, number)) throw postcodeMismatch();
    return parseDHLTrackingResponse(answer, number);
  }

  /** A read, or with a body the JSON POST DHL's page sends, which carries no `verfolgen-wg`. */
  private async request(url: string | URL, limits: Limits, body?: JsonObject): Promise<JsonObject> {
    const { response, bytes } = await fetchBounded(url, {
      signal: limits.signal,
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: {
        Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': this.userAgent, Referer: TRACKING_PAGE,
        'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { 'verfolgen-CSRF-token': this.token, ...(body ? {} : { 'verfolgen-wg': this.wg }) } : {}),
      },
    }, {
      provider: PROVIDER, timeoutMs: capped(this.timeoutMs, limits), maxBytes: MAX_BYTES,
      fetcher: this.fetcher, redirect: 'manual', allowHttpError: true,
    });
    if ([301, 302, 303, 307, 308, 401, 403, 419].includes(response.status)) throw new DHLSessionError();
    const json = response.headers.get('content-type')?.includes('application/json') === true;
    if (!response.ok) {
      let refused: InputRequiredError | null = null;
      if (body && json && response.status < 500) {
        try {
          refused = refusedPostcode(parseJsonBytes(bytes, PROVIDER));
        } catch {
          // An unreadable refusal stays the HTTP error it is.
        }
      }
      throw refused ?? new UpstreamHttpError(PROVIDER, response.status);
    }
    if (!json) throw new DHLSessionError();
    const value = parseJsonBytes(bytes, PROVIDER);
    if (!isRecord(value)) throw new SchemaError(PROVIDER, 'DHL returned an invalid tracking response');
    const token = response.headers.get('verfolgen-CSRF-token');
    if (token) this.token = token;
    return value;
  }
}

export interface DHLTrackerOptions {
  /** Budget for one browser solve; also the ceiling for the whole lookup. */
  timeoutMs?: number;
  /** Budget for a single HTTP request of the direct session. */
  directTimeoutMs?: number;
  budgetMs?: number;
  /** The host's browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  /** Clock used for the session age; injectable for tests. */
  now?: () => number;
}

export class DHLTracker {
  readonly timeoutMs: number;
  readonly directTimeoutMs: number;
  readonly budgetMs: number;
  private readonly trawl: TrawlClient | null;
  private readonly fetcher?: typeof fetch;
  private readonly recorder: StepRecorder;
  private readonly serialize = singleFlight();
  private readonly now: () => number;
  private session: DHLSession | null = null;
  private sessionOpenedAt = 0;

  constructor(options: DHLTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.directTimeoutMs = options.directTimeoutMs ?? 15_000;
    // Two direct sessions (config plus search each) and a browser solve
    // followed by the session it seeds, with room for the transport itself.
    this.budgetMs = options.budgetMs ?? this.timeoutMs + 4 * this.directTimeoutMs + 30_000;
    this.trawl = options.trawl ?? null;
    this.fetcher = options.fetcher;
    this.recorder = options.recorder ?? NOOP_RECORDER;
    this.now = options.now ?? Date.now;
  }

  private open(session: DHLSession): DHLSession {
    this.session = session;
    this.sessionOpenedAt = this.now();
    return session;
  }

  /**
   * Lookups share one session, so two parcels never renew it at the same time. The recipient's
   * postcode is sent only when DHL asks for it. `language` words the scans.
   */
  async fetch(
    trackingNumber: string, context: TrackingContext = {}, postcode?: string | null, language: DHLLanguage = 'en',
  ): Promise<CarrierResult> {
    const number = normalizeDHLTrackingNumber(trackingNumber);
    const zip = postcode ? deliveryPostcodeText(postcode) : null;
    if (zip !== null && !DELIVERY_POSTCODE.test(zip)) throw new InvalidInputError(PROVIDER, 'DHL delivery postcode is invalid');
    return takeTurn(this.serialize, 'dhl', context, (left) => this.lookup(number, left, zip, language));
  }

  /**
   * Whether DHL Paket knows the number, over HTTP alone: the direct session,
   * renewed as for a lookup, and never the browser. DHL's explicit no-data
   * answer is unknown; a postcode request for a parcel DHL holds is known; a
   * rejected session or another DHL service stays inconclusive.
   */
  async recognizes(trackingNumber: string, context: TrackingContext = {}): Promise<Recognition> {
    return takeTurn(this.serialize, 'dhl', context, (left) => {
      const { signal, deadline } = lookupBudget(left, 4 * this.directTimeoutMs, PROVIDER);
      return recognizeFromLookup(async () => {
        try {
          return await this.direct(normalizeDHLTrackingNumber(trackingNumber), { signal, deadline });
        } catch (error) {
          if (renewable(error)) this.session = null;
          throw error;
        }
      });
    });
  }

  private async lookup(number: string, context: TrackingContext, postcode: string | null, language: DHLLanguage): Promise<CarrierResult> {
    const { signal } = context;
    // The caller may have left while the lookup waited for its turn.
    signal?.throwIfAborted();
    const budgetMs = context.budgetMs ?? this.budgetMs;
    const deadline = performance.now() + budgetMs;
    // The direct step's own signal: once it has aborted, the lookup is over and no browser follows.
    let ended: AbortSignal | undefined;
    const trawl = this.trawl;
    try {
      return await runSteps<CarrierResult>({ carrier: 'dhl', budgetMs, signal, recorder: this.recorder }, [
        {
          id: 'direct',
          run: (step) => {
            ended = step.signal;
            return this.direct(number, { signal: step.signal, deadline }, postcode, language);
          },
        },
        {
          id: 'trawl', enabled: trawl !== null,
          recovers: (error) => renewable(error) && !over(ended, deadline),
          run: (step) => this.browser(trawl!, number, { signal: step.signal, deadline }, postcode, language),
        },
      ]);
    } catch (error) {
      // A session that ended the lookup is never reused by the next one.
      if (renewable(error)) this.session = null;
      throw error;
    }
  }

  /** The direct session, renewing a stale one or an interrupted read once. */
  private async direct(number: string, limits: Limits, postcode?: string | null, language: DHLLanguage = 'en'): Promise<CarrierResult> {
    if (this.session !== null && this.now() - this.sessionOpenedAt >= SESSION_MAX_AGE_MS) this.session = null;
    const cached = this.session !== null;
    const session = this.session ?? this.open(new DHLSession(this.directTimeoutMs, this.fetcher));
    try {
      return await session.fetch(number, limits, postcode, language);
    } catch (error) {
      // A fresh session that was rejected outright needs a browser, not a
      // second identical attempt; a cached one may simply have expired.
      if (!renewable(error) || (!cached && !(error instanceof UpstreamNetworkError))) throw error;
      if (over(limits.signal, limits.deadline)) throw error;
      return await this.open(new DHLSession(this.directTimeoutMs, this.fetcher)).fetch(number, limits, postcode, language);
    }
  }

  /** A solved browser session, replayed over HTTP with its cookies and user agent. */
  private async browser(
    trawl: TrawlClient, number: string, limits: Limits, postcode: string | null, language: DHLLanguage,
  ): Promise<CarrierResult> {
    this.session = null;
    const timeoutMs = capped(this.timeoutMs, limits);
    const solved = await trawl.scrape(
      { url: dhlTrackingUrl(number), skipHttp: true, maxTier: 3, maxTimeout: timeoutMs },
      { provider: `TRAWL while fetching ${PROVIDER}`, timeoutMs, maxBytes: 10_000_000, fetcher: this.fetcher, signal: limits.signal },
    );
    const session = new DHLSession(this.directTimeoutMs, this.fetcher);
    await session.seed(solved.cookies, solved.userAgent);
    const result = await session.fetch(number, limits, postcode, language);
    this.open(session);
    return result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DHLTracker({
    fetcher: environment.fetcher, trawl: environment.trawl, recorder: environment.recorder,
  });
  return {
    id: 'dhl',
    steps: ['direct', 'trawl'],
    // DHL words its scans in German or English: a German reader reads German, anyone else English.
    track: (input, context) => tracker.fetch(input.number, context, input.postcode, readerLanguage(input, ['de']) ?? 'en'),
    recognize: (number, context) => tracker.recognizes(number, context),
  };
};
