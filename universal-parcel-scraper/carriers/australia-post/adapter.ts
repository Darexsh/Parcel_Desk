
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { furtherAlong } from '../../core/status/progress.js';
import { recoverableByDefault, runSteps } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { canadaProvinceTimeZone, countryCode, countryTimeZone, explicitOffsetTime, epochMillisTime, isoTime,
  mislabeledLocalTime, mislabeledWallTime, usStateTimeZone } from '../../core/time/index.js';
import { clean, fetchBounded, TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { australiaPostCode, australiaPostCodeParts, australiaPostStatus } from './status.js';

const PROVIDER = 'Australia Post';
const DETAIL = 'https://auspost.com.au/mypost/track/details/';
const API = 'https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments';
const MAX_BYTES = 1_000_000;
const TRANSPORT_ALLOWANCE_MS = 15_000;
const DIRECT_TIMEOUT_MS = 10_000;
// The gateway's bot protection passes the official Android app's HTTP client and
// channel; other clients get a captcha reply. So does fetch's default `Accept-Language: *`.
const APP_HEADERS = { Accept: 'application/json', 'Accept-Language': 'en-AU', AP_APP_ID: 'MYPOST', AP_CHANNEL_NAME: 'ANDROID',
  'User-Agent': 'okhttp/4.12.0' };
// fetch's `no-store` adds a browser reload's cache headers and `no-cache` a `max-age=0`, which
// the gateway refuses from this client. The app sends neither, and Node's fetch keeps no cache.
const asApp = (fetcher?: typeof fetch): typeof fetch => (input, init) => (fetcher ?? fetch)(input, { ...init, cache: 'default' });

export function normalizeAustraliaPostNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{10,34}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Australia Post requires a 10-to-34-character tracking number');
  }
  return number;
}

export function australiaPostTrackingUrl(raw: string): string {
  return `${DETAIL}${normalizeAustraliaPostNumber(raw)}`;
}

export function australiaPostApiUrl(raw: string): string {
  return `${API}?${new URLSearchParams({ trackingIds: normalizeAustraliaPostNumber(raw) })}`;
}

function country(block: unknown): string | null {
  return isRecord(block) ? countryCode(clean(block.country, 60)) : null;
}

/** The zone of a scan abroad: a country its location names, its US state or Canadian province, else a single-zone country. */
function abroadZone(location: string, abroad: string): string | null {
  const named = countryCode(location.split(',').pop()?.replace(/\(.*?\)/g, '').trim());
  if (named && named !== abroad) return countryTimeZone(named);
  const region = /\s([A-Z]{2})$/.exec(location)?.[1];
  if (region && abroad === 'US') return usStateTimeZone(region);
  if (region && abroad === 'CA') return canadaProvinceTimeZone(region);
  return countryTimeZone(abroad);
}

/** Scans that leave the parcel at an Australian post office or parcel locker for collection. */
const COLLECTION_SCANS = new Set(['DD-ER4', 'NT-ER4']);
/** Deliveries left in a safe place, at the door. */
const SAFE_PLACE = new Set(['DD-ER15', 'DD-ER38']);
/** A scan's event code, without the milestone label its provider code adds. */
const eventCode = (event: CarrierEvent) => australiaPostCodeParts(event.provider_code ?? '').code;

/**
 * The post office or locker its awaiting-collection scan names: the newest scan while the
 * parcel waits there, or the scan just before its delivery once it is collected there. A
 * delivery left in a safe place was not collected.
 */
function collectionPoint(stage: string | undefined, events: readonly CarrierEvent[]): string | undefined {
  const index = events.findIndex((event) => event.stage !== 'delivered');
  const placed = stage === 'ready_for_pickup' ? index === 0
    : stage === 'delivered' && index > 0 && !events.slice(0, index).some((event) => SAFE_PLACE.has(eventCode(event)));
  const scan = placed ? events[index] : undefined;
  if (!scan || !COLLECTION_SCANS.has(eventCode(scan))) return undefined;
  return /^Awaiting collection at (.+)$/i.exec(scan.description ?? '')?.[1]?.trim() || undefined;
}

/** The one lookup entry and article must independently match the submitted reference. */
export function parse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeAustraliaPostNumber(trackingNumber);
  if (!Array.isArray(payload) || !payload.length || payload.length > 20 || payload.some((entry) => !isRecord(entry))) {
    throw new SchemaError(PROVIDER, 'Australia Post returned an invalid tracking response');
  }
  const entries = payload.filter(isRecord).filter((entry) => Array.isArray(entry.trackingIds) && entry.trackingIds.includes(number));
  if (entries.length !== 1) throw new SchemaError(PROVIDER, 'Australia Post returned a different or ambiguous lookup');
  const entry = entries[0]!;
  // The gateway answers a reference it cannot process with an internal error, which says
  // nothing about the parcel.
  if (entry.status === 500 && entry.shipment === undefined) throw new IndeterminateError(PROVIDER);
  if (entry.status === 400 && isRecord(entry.error) && entry.error.errorCode === 21
    && entry.error.error === 'Invalid Tracking ID' && entry.error.status === 'Failed'
    && entry.shipment === undefined) throw new NotFoundError(PROVIDER);
  if (entry.status !== 200 || !isRecord(entry.shipment) || entry.shipment.status !== 'Success') {
    throw new SchemaError(PROVIDER, 'Australia Post could not confirm the shipment');
  }
  const shipment = entry.shipment;
  if (typeof shipment.consignmentId !== 'string' || !shipment.consignmentId
    || !Array.isArray(shipment.articles) || !shipment.articles.length || shipment.articles.length > 100
    || shipment.articles.some((article) => !isRecord(article))) {
    throw new SchemaError(PROVIDER, 'Australia Post returned invalid articles');
  }
  const articles = shipment.articles.filter(isRecord);
  const matches = articles.filter((article) => article.articleId === number);
  // A consignment can contain several independent deliveries. An exact article answers for
  // itself, and a consignment through its articles.
  if (matches.length === 1) return articleResult(matches[0]!, shipment.consignmentId);
  if (!matches.length && shipment.consignmentId === number) {
    return articles.length === 1 ? articleResult(articles[0]!, number) : consignmentResult(articles, number);
  }
  throw new SchemaError(PROVIDER, 'Australia Post returned a different or ambiguous article');
}

/**
 * A consignment of several articles answers as one parcel only while they are in one state:
 * every article delivered, or every newest scan coded, worded and placed alike, though each
 * article is scanned at its own moment. The consignment reached that state with its last
 * article, whose history answers. Articles in different states leave it inconclusive, since
 * one delivered sibling doesn't mean the others are.
 */
function consignmentResult(articles: readonly Record<string, unknown>[], consignmentId: string): CarrierResult {
  const results: CarrierResult[] = [];
  for (const article of articles) {
    try {
      results.push(articleResult(article, consignmentId));
    } catch (error) {
      // An article without history is in a state of its own.
      if (!(error instanceof IndeterminateError)) throw error;
    }
  }
  const state = ({ status, current_stage, last_status_text, events }: CarrierResult) => status === 'delivered' ? status
    : JSON.stringify([status, current_stage, last_status_text, ...['provider_code', 'description', 'location', 'stage'].map((key) => events?.[0]?.[key])]);
  if (results.length < articles.length || new Set(results.map(state)).size > 1) {
    throw new IndeterminateError(PROVIDER, 'Australia Post lists articles in different states under this consignment', { reason: 'several_parcels' });
  }
  const reached = (result: CarrierResult) => Date.parse(result.last_update ?? '') || 0;
  return results.reduce((last, result) => reached(result) > reached(last) ? result : last);
}

/** One article's history and state; its single detail object must repeat the article and consignment. */
function articleResult(selected: Record<string, unknown>, consignmentId: string): CarrierResult {
  if (typeof selected.articleId !== 'string' || !selected.articleId || !Array.isArray(selected.details)
    || selected.details.length !== 1 || !isRecord(selected.details[0])) {
    throw new SchemaError(PROVIDER, 'Australia Post returned invalid article details');
  }
  const details = selected.details[0];
  if (details.articleId !== selected.articleId || details.consignmentId !== consignmentId) {
    throw new SchemaError(PROVIDER, 'Australia Post returned mismatched article details');
  }
  // A known article without scans, shown as "Updating Status": its history is gone or never began,
  // as for a label not yet scanned. Australia Post has answered for it, so it is no outage.
  if (Array.isArray(details.events) && !details.events.length) throw new NoHistoryError(PROVIDER, 'Australia Post shows no history for this article');
  if (!Array.isArray(details.events) || details.events.length > 500) {
    throw new SchemaError(PROVIDER, 'Australia Post returned incomplete tracking history');
  }
  // Australia Post's own scans carry their offset. Those it relays from the post
  // abroad carry that office's wall clock labelled as UTC.
  const destination = country(details.address);
  // The product as the page names it ("Parcel Post Large Satchel"); its family alone names no service.
  const service = clean(details.productSubType, 80);
  const crossings = [...new Set([destination, country(details.fromAddress)].filter((code) => code && code !== 'AU'))];
  const abroad = crossings.length === 1 ? crossings[0]! : null;
  const events: Array<{ event: CarrierEvent; timestamp: number; classified?: ClassifiedStatus }> = [];
  const zones = new Set<string>();
  const seen = new Set<string>();
  for (const raw of details.events) {
    if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Australia Post returned an invalid event');
    const offset = explicitOffsetTime(raw.localeDateTime);
    const epoch = typeof raw.dateTime === 'number' && Number.isSafeInteger(raw.dateTime) && raw.dateTime > 100_000_000_000
      ? epochMillisTime(raw.dateTime) : null;
    if (offset && epoch && offset.timestamp !== epoch.timestamp) throw new SchemaError(PROVIDER, 'Australia Post returned conflicting event dates');
    if (!(offset ?? epoch)) throw new SchemaError(PROVIDER, 'Australia Post returned an invalid event date');
    const code = clean(raw.eventCode, 64);
    const description = clean(raw.description);
    const location = clean(raw.location, 200);
    if (!description) throw new SchemaError(PROVIDER, 'Australia Post returned an empty event');
    const zone = abroad && offset?.iso.endsWith('Z') ? abroadZone(location, abroad) : undefined;
    if (zone) zones.add(zone);
    const at = zone ? mislabeledLocalTime(raw.localeDateTime, zone) : offset ?? epoch;
    // Without a zone the wall clock stays local; its label still orders it as the reply does.
    const wall = zone === null ? mislabeledWallTime(raw.localeDateTime)?.replace(/\.000$/, '') : undefined;
    if (!at) throw new SchemaError(PROVIDER, 'Australia Post returned an invalid event date');
    const milestone = clean(raw.milestone, 64);
    const classified = australiaPostStatus(milestone, code);
    const event: CarrierEvent = { ...(wall ? { local_time: wall } : { time: at.iso }),
      description: classified?.stage === 'delivered' ? 'Delivered' : description,
      ...(location ? { location } : {}), ...(classified ? { stage: classified.stage } : {}),
      ...(/^[A-Z0-9_-]{1,64}$/.test(code) ? { provider_code: australiaPostCode(code, milestone) } : {}),
    };
    const key = JSON.stringify([at.timestamp, event.description, location, code]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ event, timestamp: at.timestamp, ...(classified ? { classified } : {}) });
  }
  // A wall clock without a zone sorts on the clock the reply's other scans abroad keep, when they keep one.
  const keeping = zones.size === 1 ? [...zones][0]! : null;
  for (const entry of keeping ? events : []) {
    if (typeof entry.event.local_time === 'string') entry.timestamp = isoTime(entry.event.local_time, keeping!)?.timestamp ?? entry.timestamp;
  }
  if (listsNewestFirst(events.map(({ event }) => event)) === false) events.reverse();
  events.sort((a, b) => b.timestamp - a.timestamp);
  const summary = clean(selected.trackStatusOfArticle)
    || (isRecord(selected.status) ? clean(selected.status.statusAttributeValue) : '');
  if (!summary) throw new SchemaError(PROVIDER, 'Australia Post returned no article status');
  // A summary the map does not know ("Despatched" abroad) takes the newest scan's stage. A summary
  // label groups several scans ("In transit" covers customs on the way in): the newest scan's event
  // code places the parcel further along when the map lists it. A summary that stages the parcel as
  // that scan's own milestone does ("In transit" over an acceptance abroad filed under "It's on its
  // way") says no more than the scan, so its code stands either way.
  const latest = events[0]!;
  const labelled = australiaPostStatus(summary);
  const { code: latestCode, milestone: latestMilestone } = australiaPostCodeParts(String(latest.event.provider_code ?? ''));
  const coded = australiaPostStatus('', latestCode);
  const echoed = labelled && latestMilestone !== undefined && australiaPostStatus(latestMilestone)?.stage === labelled.stage;
  const status = labelled && coded && (echoed || furtherAlong(labelled.stage, coded.stage)) ? coded : labelled ?? latest.classified;
  const deliveredAt = status?.status === 'delivered' ? events.find(({ event }) => event.stage === 'delivered')?.event.time : null;
  // The reply names the point but gives no address for it.
  const pickup = collectionPoint(status?.stage, events.map(({ event }) => event));
  // Summary modification/milestone timestamps are not scan times. In the
  // observed reply they differed from the delivery event by about ten hours.
  return {
    status: status?.status ?? 'unknown', ...(status ? { current_stage: status.stage } : {}),
    last_status_text: status?.status === 'delivered' ? 'Delivered' : summary,
    last_update: latest.event.time ?? null,
    ...(typeof latest.event.local_time === 'string' ? { last_update_local: latest.event.local_time } : {}),
    expected_delivery: null, ...(service ? { service_name: service } : {}), ...(pickup ? { pickup_point: pickup } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}), ...(destination ? { destination_country: destination } : {}),
    events: events.slice(0, 100).map(({ event }) => event),
  };
}

export interface AustraliaPostTrackerOptions {
  trawl: TrawlClient | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  recorder?: StepRecorder;
}

export class AustraliaPostTracker {
  constructor(private readonly options: AustraliaPostTrackerOptions) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAustraliaPostNumber(raw);
    const budgetMs = context.budgetMs ?? this.options.timeoutMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('Australia Post budget must be between 1 and 60000 ms');
    context.signal?.throwIfAborted();
    const trawl = this.options.trawl;
    return runSteps({ carrier: 'australia-post', budgetMs, signal: context.signal, recorder: this.options.recorder }, [{
      id: 'direct', run: async ({ signal, remainingMs }) => {
        const { response, bytes } = await fetchBounded(australiaPostApiUrl(number), { signal, headers: APP_HEADERS }, {
          provider: PROVIDER, timeoutMs: Math.max(1, Math.min(DIRECT_TIMEOUT_MS, Math.floor(remainingMs))),
          maxBytes: MAX_BYTES, allowHttpStatuses: [401, 403, 429], fetcher: asApp(this.options.fetcher),
        });
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          throw new RateLimitedError(PROVIDER, retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : undefined);
        }
        if (response.status !== 200) {
          throw new ChallengeError(PROVIDER, trawl ? undefined : 'Australia Post requires the browser tracking service');
        }
        let payload: unknown;
        try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new SchemaError(PROVIDER, 'Australia Post returned invalid tracking JSON'); }
        return parse(payload, number);
      },
    }, {
      // The browser reads the same gateway, so it cannot improve on an inconclusive entry.
      enabled: trawl !== null, recovers: (error) => recoverableByDefault(error) && !(error instanceof IndeterminateError),
      id: 'trawl', run: async ({ signal, remainingMs }) => {
        const timeoutMs = Math.floor(remainingMs - TRANSPORT_ALLOWANCE_MS);
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, budgetMs);
        const apiUrl = australiaPostApiUrl(number);
        const page = await trawl!.scrape({ url: australiaPostTrackingUrl(number), skipHttp: true, maxTier: 3,
          maxTimeout: timeoutMs, captureResponses: [apiUrl], settleTimeout: Math.min(timeoutMs, 10_000),
        }, { provider: 'TRAWL while fetching Australia Post', timeoutMs, signal, maxBytes: 6_000_000, requireSolved: false });
        signal.throwIfAborted();
        if (![2, 3].includes(page.tier) || ![200, 304].includes(page.statusCode)) {
          throw new TransportError(PROVIDER, 'The browser service did not load Australia Post tracking');
        }
        const captures = page.capturedResponses.filter((capture) => capture.url === apiUrl && capture.status !== 204);
        if (!captures.length || captures.length > 20) throw new TransportError(PROVIDER, 'Australia Post returned no matching browser response');
        const capture = captures[captures.length - 1]!;
        if (capture.status === 429) {
          const retry = capture.headers['retry-after'];
          throw new RateLimitedError(PROVIDER, retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : undefined);
        }
        if ([401, 403].includes(capture.status)) throw new ChallengeError(PROVIDER);
        if (capture.status >= 400) throw new UpstreamHttpError(PROVIDER, capture.status);
        if (capture.status !== 200 || capture.error || capture.truncated || capture.base64Encoded || capture.body === null) {
          throw new TransportError(PROVIDER, 'Australia Post returned an incomplete browser response');
        }
        if (Buffer.byteLength(capture.body, 'utf8') > MAX_BYTES) throw new SchemaError(PROVIDER, 'Australia Post returned an unexpectedly large response');
        let payload: unknown;
        try { payload = JSON.parse(capture.body); } catch { throw new SchemaError(PROVIDER, 'Australia Post returned invalid tracking JSON'); }
        return parse(payload, number);
      },
    }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AustraliaPostTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  // Recognition is plain HTTP: it asks the gateway alone, and a refusal there fails instead of starting a browser.
  // A recognition budget can be longer than the minute a lookup takes at most.
  const gateway = new AustraliaPostTracker({ trawl: null, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'australia-post', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => gateway.fetch(number, { ...context, budgetMs: Math.min(context?.budgetMs ?? 45_000, 60_000) }),
      () => accepted(() => normalizeAustraliaPostNumber(number))) };
};
