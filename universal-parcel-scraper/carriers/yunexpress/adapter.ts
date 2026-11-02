import { DateTime, FixedOffsetZone } from 'luxon';
import type { Response as BrowserResponse } from 'playwright-core';
import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { carrierIdsFromPartnerLinks } from '../../core/catalog/hints.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { explicitOffsetTime, EXPLICIT_OFFSET_PATTERN, firstOccurrence } from '../../core/time/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean, type TrawlClient, type TrawlScrapeResponse } from '../../core/transport/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { isRecord } from '../../core/types.js';
import { hasSeveralClocks, mainZone } from '../../places/zones.js';
import { chinaPostAirline, chinaPostDestinationScan } from '../china-post/status.js';
import { chinaPostOffice, chinaPostRelayEnglish, isYunExpressNotice, withoutMarkup, withoutRepeatedParts, yunExpressCodeStatus, yunExpressStatus } from './status.js';

const API = 'https://services.yuntrack.com/Track/Query';
const MAX_BYTES = 1_000_000;

export function normalizeYunExpressNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^YT\d{16}$/.test(number)) throw new InvalidInputError('YunExpress', 'YunExpress requires a YT parcel reference');
  return number;
}

export function yunExpressTrackingUrl(raw: string): string {
  return `https://www.yuntrack.com/parcelTracking?id=${normalizeYunExpressNumber(raw)}`;
}

function eventClock(raw: string, offset?: string): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  if (EXPLICIT_OFFSET_PATTERN.test(raw)) {
    const parsed = explicitOffsetTime(raw);
    if (!parsed) throw new SchemaError('YunExpress', 'YunExpress returned an invalid scan time');
    return { time: parsed.iso };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) throw new SchemaError('YunExpress', 'YunExpress returned an invalid scan time');
  const parsed = DateTime.fromISO(`${raw}${offset ?? ''}`, { setZone: true, zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError('YunExpress', 'YunExpress returned an invalid scan time');
  const iso = parsed.toISO({ suppressMilliseconds: true, includeOffset: Boolean(offset) });
  return offset ? { time: iso } : { local_time: iso };
}

const wording = (event: CarrierEvent) => (event.description ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const IN_CHINA = /(?:^|[\s,])(?:CN|China)$/i;
const ORIGIN_ZONE = 'Asia/Shanghai';
/** The offset the latest-scan record states for China Post's scans. */
const CHINA_OFFSET = '+08:00';
const ARRIVAL = 'international flight has arrived';
// A hand-over to the last-mile carrier, which relays what follows.
const HANDOVER = /^shipment (?:is )?in transit to (?:carrier|dhl)$/;
// GOFO names its own facilities on its scans after the flight in.
const GOFO_FACILITY = /^arrived at gofo\b/;
/**
 * La Poste's scans at its sorting platforms, as the feed relays them in
 * France: their wall clocks are UTC, whatever offset the latest-scan record
 * states. Its arrival in France at 13:21:33 is La Poste's 14:21:33+01:00, and
 * 16:08:37 in summer its 18:08:37+02:00; a departure to the delivery centre
 * follows the platform's scan only on UTC. Its delivery office's scans keep
 * the office's clock.
 */
const LA_POSTE_UTC = new Set(['arrived at destination', 'handled by local carrier', 'transport to delivery centre']);

/**
 * Dates the rows without a place that China's leg holds, up to the flight
 * out, on China's clock when the nearest row with a place, the older one
 * first, is in China. A departure stated as the latest scan carries +08:00,
 * and read on the destination's clock the flight would land hours too soon.
 * Events are newest first.
 */
function dateOriginLeg(events: CarrierEvent[]): CarrierEvent[] {
  const arrival = events.map(wording).lastIndexOf(ARRIVAL);
  const start = events.findIndex((event, at) => at > arrival
    && (IN_CHINA.test(event.location ?? '') || wording(event) === 'international flight has departed'));
  if (start < 0) return events;
  const placed = (at: number) => events[at]?.location ?? '';
  return events.map((event, at) => {
    if (at < start || event.location || !event.local_time || event.time) return event;
    let place = '';
    for (let older = at + 1; !place && older < events.length; older += 1) place = placed(older);
    for (let newer = at - 1; !place && newer >= start; newer -= 1) place = placed(newer);
    if (!IN_CHINA.test(place)) return event;
    const time = firstOccurrence(DateTime.fromISO(event.local_time, { zone: ORIGIN_ZONE })).toISO({ suppressMilliseconds: true })!;
    return { ...event, time, time_zone: ORIGIN_ZONE, time_zone_basis: 'neighbour' };
  });
}

/** A scan China Post relays in Chinese; a line with kana or hangul is a partner's. */
function chinaPostRelay(description: string): boolean {
  return /\p{Script=Han}/u.test(description) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(description);
}

/**
 * Dates China Post's scans, which the feed relays in Chinese, on China's clock
 * wherever they happen: China Post dates its own scans abroad on Beijing time,
 * and the feed states +08:00 for its arrival at the destination (到达寄达地).
 * The destination post's own scans, which China Post copies on that post's wall
 * clock, take the destination's where it keeps one, else wait for the scans
 * around them.
 */
function dateChinaPostScans(events: CarrierEvent[], destination: string): CarrierEvent[] {
  const zone = /^[A-Z]{2}$/.test(destination) && !hasSeveralClocks(destination) ? mainZone(destination) : null;
  return events.map((event) => {
    if (event.time || !event.local_time || !chinaPostRelay(event.description ?? '')) return event;
    if (!chinaPostDestinationScan(event.description ?? '')) {
      return { ...event, time: eventClock(event.local_time, '+08:00').time, time_zone: ORIGIN_ZONE, time_zone_basis: 'carrier' };
    }
    const time = zone && firstOccurrence(DateTime.fromISO(event.local_time, { zone })).toISO({ suppressMilliseconds: true });
    return zone && time ? { ...event, time, time_zone: zone, time_zone_basis: 'destination' } : event;
  });
}

/**
 * Dates the destination leg's rows on the offset the latest-scan record
 * states, when no row of that leg names a place: one partner relays the leg,
 * and with no place the facade would read it on China's clock. The leg is
 * what follows the flight in, else the hand-over to the last-mile carrier,
 * else it starts at GOFO's first facility; a parcel sent within its
 * destination country is one leg. Events are newest first, and the newest is
 * the stated scan.
 */
function dateDestinationLeg(events: CarrierEvent[], offset: string | undefined, domestic: boolean): CarrierEvent[] {
  const zone = offset ? FixedOffsetZone.parseSpecifier(`UTC${offset}`) : null;
  if (!offset || !zone) return events;
  const arrival = events.map(wording).indexOf(ARRIVAL);
  const handover = events.findIndex((event) => HANDOVER.test(wording(event)));
  const facility = events.map((event) => GOFO_FACILITY.test(wording(event))).lastIndexOf(true);
  const end = arrival >= 0 ? arrival : domestic ? events.length : handover >= 0 ? handover : facility + 1;
  if (events.slice(0, end).some((event) => event.location)) return events;
  return events.map((event, at) => at >= end || event.time || !event.local_time ? event
    : { ...event, time: eventClock(event.local_time, offset).time, time_zone: zone.name, time_zone_basis: 'neighbour' });
}

/**
 * China Post's arrivals and departures, relayed after the hand-over to it, name
 * their office in the wording; the office becomes the scan's place, in place
 * of the city the feed gives. An airline the feed gives as a place (邮政航空)
 * is none, as in China Post's own adapter. China Post's scans show the English
 * its adapter gives them; their stage was read from the Chinese. Clocks are
 * dated first, on the feed's places.
 */
function officesAsPlaces(events: CarrierEvent[]): CarrierEvent[] {
  return events.map((event) => {
    const scan = chinaPostOffice(event.description ?? '');
    const english = chinaPostRelayEnglish(event.description ?? '');
    const placed = scan ? { ...event, description: scan.wording, location: scan.office }
      : chinaPostAirline(event.location ?? '') ? { ...event, location: '' } : event;
    return english ? { ...placed, description: english } : placed;
  });
}

/** The one reference the relayed rows' contact links carry, as a partner's markup gives it. */
function contactReference(contents: string[]): string | undefined {
  const found = new Set(contents.flatMap((content) => [...content.matchAll(/[?&]tracNum=([A-Z0-9]{4,40})(?![A-Z0-9])/gi)]
    .map((match) => match[1]!.toUpperCase())));
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * The last-mile carrier whose official site the notes link to. The catalog
 * knows the host, and that carrier's own detection must offer the declared
 * reference: a brand's host can serve regional networks outside its scope.
 */
function linkedPartner(notes: unknown, reference: string): string | undefined {
  if (typeof notes !== 'string' || notes.length > MAX_BYTES) return undefined;
  const [partner, ...others] = carrierIdsFromPartnerLinks([notes], 'yunexpress');
  if (!partner || others.length) return undefined;
  return (detectCarrierMatch(reference).candidates as string[]).includes(partner) ? partner : undefined;
}

/**
 * The carrier a contact link's reference belongs to: the one the notes link
 * to, else the one whose detection alone claims the whole reference and that
 * delivers in the destination country.
 */
function contactPartner(notes: unknown, reference: string, country: string): string | undefined {
  const linked = linkedPartner(notes, reference);
  if (linked) return linked;
  const detected = detectCarrierMatch(reference);
  return detected.confidence === 'high' && detected.carrier !== 'yunexpress'
    && CARRIER_DEFINITIONS[detected.carrier]?.countries?.includes(country) ? detected.carrier : undefined;
}

export function parse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeYunExpressNumber(trackingNumber);
  if (isRecord(payload) && [1003, 1004].includes(Number(payload.Code))) throw new ChallengeError('YunExpress', 'YunExpress requires its interactive tracking verification');
  if (!isRecord(payload) || !Array.isArray(payload.ResultList)) throw new SchemaError('YunExpress');
  const matches = payload.ResultList.filter((item) => isRecord(item) && item.Id === number);
  if (matches.length !== 1 || !isRecord(matches[0])) throw new SchemaError('YunExpress', 'YunExpress returned a different or ambiguous shipment');
  const item = matches[0];
  if (!isRecord(item.TrackInfo) || item.TrackInfo.WaybillNumber !== number || !isRecord(item.TrackData)) throw new SchemaError('YunExpress', 'YunExpress returned inconsistent parcel identity');
  const info = item.TrackInfo;
  const groups = item.TrackData.ProcessGroupList;
  if (!Array.isArray(groups)) throw new SchemaError('YunExpress');
  if (item.Status === 0 && info.TrackingStatus === 0 && groups.length === 0
    && info.TrackEventCount === 0 && item.TrackData.ChildCount === 0
    && Array.isArray(info.TrackEventDetails) && info.TrackEventDetails.length === 0
    && isRecord(info.LastTrackEvent) && info.LastTrackEvent.TrackingStatus === 0
    && info.LastTrackEvent.ProcessDate === '' && info.LastTrackEvent.ProcessContent === ''
    && info.LastTrackEvent.ProcessLocation === '') throw new NotFoundError('YunExpress');
  if (!groups.length) throw new IndeterminateError('YunExpress', 'YunExpress returned no parcel scans');
  if (groups.length > 500) throw new SchemaError('YunExpress');
  const last = isRecord(info.LastTrackEvent) ? info.LastTrackEvent : {};
  const lastOffset = /^GMT([+-]\d{2}:\d{2})$/.exec(clean(last.GmtProcessTimezone, 32))?.[1];
  const country = clean(info.DestinationCountryCode, 8).toUpperCase();
  const deliveryNumber = clean(info.TrackingNumber, 64).toUpperCase();
  const declared = deliveryNumber !== number && /^[A-Z0-9]{4,40}$/.test(deliveryNumber) ? deliveryNumber : '';
  const laPosteRelay = country === 'FR' && declared !== '' && (detectCarrierMatch(declared).candidates as string[]).includes('la-poste');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  const contents: string[] = [];
  let scans = 0;
  let current: ClassifiedStatus | undefined;
  let decider: CarrierEvent | undefined;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.ProcessDetailList) || !group.ProcessDetailList.length) throw new SchemaError('YunExpress');
    for (const raw of group.ProcessDetailList) {
      if (!isRecord(raw) || typeof raw.ProcessContent !== 'string' || ++scans > 500) throw new SchemaError('YunExpress');
      const content = clean(raw.ProcessContent, MAX_BYTES);
      contents.push(content);
      const rawTime = clean(raw.ProcessDate, 64);
      // The feed joins wording and place with "----". A relayed line can give
      // a dash as its place, which runs into the divider and is no place. A
      // wording ending in a dash before an empty place reads the same, so the
      // newest row takes the split its latest-scan record confirms.
      let dashes = 0;
      while (dashes < content.length && content[content.length - 1 - dashes] === '-') dashes += 1;
      const splits = [...new Set([dashes > 4 ? content.length - dashes : content.lastIndexOf('----'), content.lastIndexOf('----')])]
        .map((divider) => ({
          fullDescription: clean(divider < 0 ? content : content.slice(0, divider), MAX_BYTES),
          fullLocation: divider < 0 ? '' : clean(content.slice(divider + 4), MAX_BYTES),
        }));
      // Only the separately described latest scan supplies a verified offset.
      // Storage/creation timezone fields say nothing about earlier scan clocks.
      const isLast = (split: { fullDescription: string; fullLocation: string }) => rawTime === last.ProcessDate
        && split.fullDescription === clean(last.ProcessContent, MAX_BYTES) && split.fullLocation === clean(last.ProcessLocation, MAX_BYTES);
      const { fullDescription, fullLocation } = (events.length === 0 ? splits.find(isLast) : undefined) ?? splits[0]!;
      const description = clean(withoutMarkup(fullDescription), 500);
      const location = /^-+$/.test(fullLocation) ? '' : withoutRepeatedParts(clean(withoutMarkup(fullLocation), 200));
      // The portal can list an older row with a place but no wording. It names
      // no status, so it is skipped; the newest row must still say something.
      if (!description && events.length) continue;
      if (!description) throw new SchemaError('YunExpress', 'YunExpress returned an empty scan');
      const exactLast = isLast({ fullDescription, fullLocation });
      const utc = laPosteRelay && LA_POSTE_UTC.has(description.replace(/\s+/g, ' ').trim().toLowerCase());
      // The record states China's offset for China Post's latest scan, also when it is the
      // destination post's, which keeps that post's clock (dateChinaPostScans).
      const abroad = lastOffset === CHINA_OFFSET && chinaPostRelay(description) && chinaPostDestinationScan(description);
      const clock = eventClock(rawTime, utc ? '+00:00' : exactLast && !abroad ? lastOffset : undefined);
      if (events.length === 0 && !exactLast) throw new IndeterminateError('YunExpress', 'YunExpress latest summary does not match its first scan');
      const key = JSON.stringify([clock, description, location]);
      if (seen.has(key)) continue;
      seen.add(key);
      const classified = yunExpressStatus(description, exactLast ? last.TrackingStatus : undefined);
      const event: CarrierEvent = { ...clock, description, location, ...(classified ? { stage: classified.stage } : {}) };
      // A relayed notice leaves the status to the scan before it.
      if (!decider && (classified || !isYunExpressNotice(description))) {
        current = classified;
        decider = event;
      }
      events.push(event);
    }
  }
  if (!events.length) throw new IndeterminateError('YunExpress');
  if (Array.isArray(info.TrackEventDetails) && info.TrackEventDetails.length > scans) {
    throw new IndeterminateError('YunExpress', 'YunExpress returned incomplete parcel history');
  }
  const domestic = /^[A-Z]{2}$/.test(country) && clean(info.OriginCountryCode, 8).toUpperCase() === country;
  const dated = officesAsPlaces(dateDestinationLeg(dateChinaPostScans(dateOriginLeg(events), country), lastOffset, domestic));
  const latest = dated[0]!;
  const classified = current;
  // A partner's relayed row can link its contact page with its own reference,
  // the only place the reply gives it; it counts once a carrier owns it.
  const linked = declared ? undefined : contactReference(contents);
  const linkedCarrier = linked && linked !== number ? contactPartner(info.AdditionalNotes, linked, country) : undefined;
  const handoff = declared || (linkedCarrier ? linked! : '');
  const partner = declared ? linkedPartner(info.AdditionalNotes, declared) : linkedCarrier;
  // The first event is the exact latest event, so its code belongs to it.
  return { status: classified?.status ?? yunExpressCodeStatus(last.TrackingStatus) ?? 'unknown', ...(classified ? { current_stage: classified.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(classified?.stage === 'delivered' && decider?.time ? { delivered_at: decider.time } : {}),
    ...(handoff ? { delivery_tracking_number: handoff, ...(partner ? { delivery_carrier: partner } : {}) } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}), events: dated.slice(0, 100) };
}

/** A later captured reply is final; never silently reuse an earlier success. */
export function parseCaptured(page: TrawlScrapeResponse, number: string): CarrierResult {
  const capture = page.capturedResponses.filter((entry) => entry.url === API).at(-1);
  if (!capture) throw new TransportError('YunExpress', 'The browser service did not capture YunExpress history');
  if (capture.status >= 400) {
    if ([401, 403, 405].includes(capture.status)) throw new ChallengeError('YunExpress', 'YunExpress rejected the browser tracking request', { status: capture.status });
    throw new UpstreamHttpError('YunExpress', capture.status);
  }
  if (capture.status !== 200 || capture.truncated || capture.error || capture.body === null || capture.body.length > MAX_BYTES) throw new IndeterminateError('YunExpress', 'The browser returned incomplete YunExpress history');
  const body = capture.base64Encoded ? Buffer.from(capture.body, 'base64').toString('utf8') : capture.body;
  let payload: unknown;
  try { payload = JSON.parse(body); } catch (error) { throw new SchemaError('YunExpress', 'YunExpress returned unreadable tracking JSON', { cause: error }); }
  return parse(payload, number);
}

function localBrowser(number: string, executablePath: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
  return withLocalBrowser({ provider: 'YunExpress', executablePath, signal, timeoutMs }, async ({ browser, signal: session, remainingMs }) => {
    let rejectHistory!: (error: unknown) => void;
    let resolveHistory!: (result: CarrierResult) => void;
    let settled = false;
    const history = new Promise<CarrierResult>((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject; });
    void history.catch(() => {});
    const fail = (error: unknown) => { if (!settled) { settled = true; rejectHistory(error); } };
    // A reply that arrives after the lookup ended is never history.
    session.addEventListener('abort', () => { settled = true; }, { once: true });
    const page = await browser.newPage({ locale: 'en-US' });
    // Request interception makes the same fresh session receive API 405.
    // Observe response events without altering the browser's network requests.
    page.on('response', async (response: BrowserResponse) => {
      if (settled || response.url() !== API || response.request().method() !== 'POST') return;
      try {
        const body = response.request().postDataJSON() as unknown;
        if (!isRecord(body) || !Array.isArray(body.NumberList) || body.NumberList.length !== 1 || body.NumberList[0] !== number) throw new SchemaError('YunExpress', 'The browser submitted a different parcel');
        if (response.status() !== 200) {
          if ([401, 403, 405].includes(response.status())) throw new ChallengeError('YunExpress', 'YunExpress rejected the browser tracking request', { status: response.status() });
          throw new UpstreamHttpError('YunExpress', response.status());
        }
        if (Number(response.headers()['content-length']) > MAX_BYTES) throw new SchemaError('YunExpress', 'YunExpress returned excessive tracking data');
        const bytes = await response.body();
        if (bytes.length > MAX_BYTES) throw new SchemaError('YunExpress', 'YunExpress returned excessive tracking data');
        const result = parse(JSON.parse(bytes.toString('utf8')) as unknown, number);
        if (!settled) { settled = true; resolveHistory(result); }
      } catch (error) { fail(error instanceof SyntaxError ? new SchemaError('YunExpress', 'YunExpress returned unreadable tracking JSON', { cause: error }) : error); }
    });
    const navigation = page.goto(yunExpressTrackingUrl(number), { waitUntil: 'domcontentloaded', timeout: remainingMs() }).then((response) => {
      if (!response || response.status() !== 200) throw new TransportError('YunExpress', 'YunExpress tracking page is unavailable');
      return history;
    });
    void navigation.catch(() => {});
    return await Promise.race([navigation, history]);
  });
}

export class YunExpressTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; executablePath?: string | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeYunExpressNumber(raw);
    const budgetMs = context.budgetMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('YunExpress timeout must be positive');
    if (!this.options.trawl && !this.options.executablePath) throw new ChallengeError('YunExpress', 'YunExpress requires a configured tracking browser');
    return runSteps({ carrier: 'yunexpress', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      // The shared launcher serves a lookup for at most 60 s; a longer budget gives the browser that much.
      { id: 'browser', enabled: Boolean(this.options.executablePath), run: ({ signal, remainingMs }) => localBrowser(number, this.options.executablePath!, signal, Math.min(60_000, Math.max(1, Math.floor(remainingMs)))) },
      // Keep the local runtime primary. Service capture needs the matching
      // decoded-response hook and is used only without local Chromium.
      { id: 'trawl', enabled: !this.options.executablePath && Boolean(this.options.trawl), run: async ({ signal, remainingMs }) => {
        const timeoutMs = Math.max(1, Math.min(25_000, Math.floor(remainingMs)));
        const page = await this.options.trawl!.scrape({ url: yunExpressTrackingUrl(number), skipHttp: true, maxTier: 2,
          maxTimeout: timeoutMs, captureResponses: [API], settleTimeout: 5_000 }, {
          provider: 'TRAWL while fetching YunExpress', timeoutMs, maxBytes: 2_000_000, fetcher: this.options.fetcher, signal });
        return parseCaptured(page, number);
      } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment: AdapterEnvironment) => {
  const tracker = new YunExpressTracker({ trawl: environment.trawl, executablePath: environment.browserExecutablePath,
    fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'yunexpress', recordsSteps: true, steps: ['browser', 'trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
