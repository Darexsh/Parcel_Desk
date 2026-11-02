
/**
 * Postal Ninja (postal.ninja), an opt-in universal aggregator.
 *
 * Transport: TRAWL verifies through the embedded widget on `/en/tools`, then
 * opens the normal results page for its verified handle and captures the full
 * `/track/get` response. Local Chromium without TRAWL retains compact widget
 * capture. The main entry form has a separate verification gate.
 * The provider is disabled by default; selecting `Postal Ninja` in `providers`
 * puts it in the chain before 17TRACK.
 */
import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { ChallengeError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import type { TrawlClient, TrawlScrapeResponse } from '../../core/transport/index.js';
import { scrapeUniversalPage, type UniversalBrowserOptions } from '../../core/transport/browser.js';
import { isRecord } from '../../core/types.js';
import { capturedBodies, captureFailure, loadCapture, type CaptureSpec } from '../shared/capture.js';
import { classifyEvent, event, hasPrivateDeliveryDetails, isNotice, numberOf, result, text, type UniversalSource } from '../shared/result.js';
import { courierZone, universalCarrierHints } from '../shared/hints.js';
import { carrierHomeZone, originLeg, serviceZone, wallClock } from './clocks.js';

const SOURCE: UniversalSource = 'Postal Ninja';
const GET_API = 'https://postal.ninja/track/get';
const CHECK_API = 'https://postal.ninja/track/check';
const MAX_EVENTS = 1000;
/** How far a scan may run ahead of the reply's last read of the carrier: some scanners run early. */
const CLOCK_SKEW_MS = 3_600_000;
/** The furthest a wall clock runs ahead of UTC (UTC+14). */
const EARLIEST_ZONE_MS = 14 * 3_600_000;
/** A pickup deadline Postal Ninja lists among the scans (PostNord's "Last day to pickup", Posten Norge's "Last day for retrieval"). */
const DEADLINE = /^last day\b/i;
/** The states whose history the provider considers established. */
const TRACKED_STATES = ['TRACKING', 'FINISHED', 'STOPPED', 'ARCHIVED'];

function isMatchingResultPage(page: TrawlScrapeResponse, number: string): boolean {
  return page.capturedResponses.some((entry) => {
    if (entry.url !== GET_API || entry.status !== 200 || !entry.body || entry.truncated || entry.base64Encoded) return false;
    let payload: unknown;
    try { payload = JSON.parse(entry.body); } catch { return false; }
    return isRecord(payload) && payload.status === 'FOUND' && isRecord(payload.track)
      && payload.track.tc === number && payload.track.hid === payload.hid
      && typeof payload.hid === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(payload.hid)
      && page.url === `https://postal.ninja/en/track#/${payload.hid}`;
  });
}

export function parsePostalNinjaResponse(payload: unknown, trackingNumber: string, timezone: string | null = null,
  carrier: string | null = null): CarrierResult {
  const number = numberOf(trackingNumber);
  if (!isRecord(payload) || payload.status !== 'FOUND' || !isRecord(payload.track)
    || payload.track.tc !== number || payload.track.hid !== payload.hid
    || typeof payload.hid !== 'string' || !payload.hid
    || !TRACKED_STATES.includes(String(payload.track.state))) {
    throw new SchemaError(SOURCE, 'Postal Ninja has no matching shipment history');
  }
  // The embedded widget requests compact:true, which supplies only the first
  // and latest scan. Full /track/get responses instead carry events[].
  const rawEvents = payload.track.events === undefined
    ? [payload.track.firstEv, payload.track.lastEv].filter((value) => value != null)
    : payload.track.events;
  if (!Array.isArray(rawEvents) || rawEvents.length > MAX_EVENTS) throw new SchemaError(SOURCE, 'Postal Ninja returned invalid events');
  // Postal Ninja supplies events oldest first. Its dt values are wall times
  // without a zone, on a clock that depends on the service that reports the
  // scan (ds): UTC for some, the service's home zone wherever the scan
  // happened for others, the scanning office's for most. A scan is placed on
  // its service's established clock (clocks.ts). The scanning office's counts
  // only in a full history that service reports alone, and for a postal item
  // one that stays in its country: beside other services, a service can relay
  // their scans at their clocks or at none. Explicit offsets, when present,
  // are persisted as they are, but for the UTC suffix Postal Ninja writes on
  // some services' wall clocks (wallClock).
  const destination = text(payload.track.destCn) || null;
  const services = new Set((rawEvents as unknown[]).map((raw) => isRecord(raw) ? text(raw.ds) : ''));
  const journey = { number, destination, fallback: timezone ?? carrierHomeZone(carrier),
    alone: payload.track.events !== undefined && services.size === 1
      && (!isValidS10TrackingNumber(number) || number.slice(-2) === destination) };
  const scans: { wall: string | null; service: string; origin: boolean; zone: string | null | false; event: Omit<CarrierEvent, 'local_time'> }[] = [];
  for (const raw of rawEvents as unknown[]) {
    if (!isRecord(raw)) throw new SchemaError(SOURCE, 'Postal Ninja returned an invalid event');
    const description = text(raw.dsc);
    if (!description || isNotice(description) || DEADLINE.test(description)) continue;
    if (typeof raw.dt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?/.test(raw.dt)
      || !DateTime.fromISO(raw.dt, { zone: 'UTC' }).isValid) throw new SchemaError(SOURCE, 'Postal Ninja returned an invalid event date');
    const service = text(raw.ds);
    const wall = wallClock(service, raw.dt, text(raw.loc));
    if (/(?:Z|[+-]\d{2}:\d{2})$/.test(wall)) {
      const parsed = event(wall, description);
      if (parsed) scans.push({ wall: null, service, origin: false, zone: null, event: parsed });
    } else {
      const classified = classifyEvent(description);
      const { stage } = classified;
      if (stage !== 'delivered' && hasPrivateDeliveryDetails(description)) continue;
      // A scan's location (loc) is read only for its clock.
      const scan = { service, description, wall, location: text(raw.loc), delivered: stage === 'delivered' };
      scans.push({ wall, service, origin: originLeg(scan), zone: serviceZone(scan, journey),
        event: { description: stage === 'delivered' ? 'Delivered' : description, ...classified } });
    }
  }
  // A scan whose service's clock is unknown here borrows a zone: that of the
  // nearest earlier scan of the same service with an established one, else of
  // the nearest later one, else the carrier's, else, in a history the service
  // reports alone, the one its name gives. This is a guess, which keeps a reply
  // dated when its newest scan names no place. A scan whose hour is unknown
  // (false) keeps its wall time.
  const zoneAt = (index: number, wall: string): string | null => {
    const { zone, service, origin } = scans[index]!;
    if (zone !== null) return zone || null;
    // A service's scans on its origin's clock (a post's copies of the origin post's, Cainiao's in China) borrow among themselves.
    const established = (other: typeof scans[number]) => other.service === service && other.origin === origin
      && typeof other.zone === 'string' ? other.zone : null;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) { const borrowed = established(scans[earlier]!); if (borrowed) return borrowed; }
    for (let later = index + 1; later < scans.length; later += 1) { const borrowed = established(scans[later]!); if (borrowed) return borrowed; }
    return timezone ?? (journey.alone ? courierZone(service, number, wall) : null);
  };
  const events = scans.map((scan, index): CarrierEvent => {
    if (scan.wall === null) return scan.event;
    const zone = zoneAt(index, scan.wall);
    const instant = zone ? firstOccurrence(DateTime.fromISO(scan.wall, { zone })) : null;
    return instant?.isValid ? { time: instant.toUTC().toISO(), ...scan.event } : { local_time: scan.wall, ...scan.event };
  }).reverse();
  // A deadline is no scan, and placed it would be the parcel's newest instant.
  // Besides those it names, a row dated after Postal Ninja last read the
  // carrier (lastFetch) is one. A wall time is after that read only when it
  // is in every zone.
  const readAt = Date.parse(text(payload.track.lastFetch));
  const after = (scan: CarrierEvent) => (scan.time ? Date.parse(scan.time)
    : Date.parse(`${String(scan.local_time)}Z`) - EARLIEST_ZONE_MS) > readAt + CLOCK_SKEW_MS;
  const kept = events.filter((scan) => !after(scan));
  // Services on different clocks interleave in Postal Ninja's order. Once
  // every scan has an instant, they are ordered by it. The services that
  // reported the scans are discovery hints, as other providers' carrier names.
  return { ...result(kept, SOURCE, kept.some((scan) => !scan.time)),
    ...universalCarrierHints([...services].filter(Boolean).slice(0, 20), number) };
}

export interface PostalNinjaOptions extends Omit<UniversalBrowserOptions, 'signal'> {
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
}

export class PostalNinjaTracker {
  constructor(readonly options: PostalNinjaOptions = {}) {}

  async fetch(trackingNumber: string, budgetMs?: number, timezone: string | null = null, signal?: AbortSignal,
    carrier: string | null = null): Promise<CarrierResult> {
    const number = numberOf(trackingNumber);
    const timeoutMs = budgetMs ?? this.options.timeoutMs ?? 45_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError('Postal Ninja timeout must be between 1 and 60000 ms');
    let handle: string | undefined;
    const responseError = (payload: unknown): Error | undefined => {
      if (!isRecord(payload)) return;
      if (payload.tc === number && payload.status === 'PROCESSING' && typeof payload.hid === 'string' && payload.hid) {
        handle = payload.hid;
      }
      if (payload.status === 'CHLNG_REQ' && (payload.tc === number || (handle && payload.hid === handle))) {
        return new ChallengeError(SOURCE, 'Postal Ninja browser verification did not complete');
      }
      if (payload.status === 'UNTRACEABLE' && payload.tc === number) {
        return new NoHistoryError(SOURCE, 'Postal Ninja cannot track this number');
      }
      if (payload.status === 'FOUND' && isRecord(payload.track) && payload.track.tc === number
        && typeof payload.hid === 'string' && payload.hid && payload.track.hid === payload.hid
        && payload.track.state === 'NO_INFO' && !payload.inProgress) {
        return new NoHistoryError(SOURCE, 'Postal Ninja has no available tracking history');
      }
      return undefined;
    };
    return runSteps({ carrier: SOURCE, budgetMs: timeoutMs, signal, recorder: this.options.recorder }, [{
      id: 'trawl', enabled: Boolean(this.options.trawl),
      run: async ({ remainingMs, signal }) => {
        const spec: CaptureSpec = {
          source: SOURCE, url: `https://postal.ninja/en/tools#trawl-number=${number}`,
          apiUrl: GET_API, additionalApiUrls: [CHECK_API], budgetMs: remainingMs, fetcher: this.options.fetcher, signal,
          acceptResultPage: (page) => isMatchingResultPage(page, number),
        };
        const page = await loadCapture(this.options.trawl ?? null, spec);
        // Learn the submission's handle before interpreting a handle-only
        // retrieval challenge. Read history newest first to skip polling.
        let submissionError: Error | undefined;
        for (const body of [...capturedBodies(page, { ...spec, apiUrl: CHECK_API })].reverse()) {
          let payload: unknown;
          try { payload = JSON.parse(body); } catch { continue; }
          submissionError = responseError(payload) ?? submissionError;
        }
        let pending: Error | undefined;
        for (const body of capturedBodies(page, spec)) {
          let payload: unknown;
          try { payload = JSON.parse(body); } catch { continue; }
          const error = responseError(payload);
          if (error) throw error;
          // The compact widget response establishes the parcel's handle. A
          // TRAWL success must include the normal page's full history; otherwise
          // fallback providers should get a chance to return the missing scans.
          if (isRecord(payload) && isRecord(payload.track) && !Array.isArray(payload.track.events)) continue;
          try { return parsePostalNinjaResponse(payload, number, timezone, carrier); }
          catch (error) { if (error instanceof SchemaError) pending ??= error; else throw error; }
        }
        throw submissionError ?? pending ?? captureFailure(page, spec);
      },
    }, {
      id: 'browser',
      // A failed TRAWL attempt proceeds to the next universal provider. Do
      // not spend another browser budget on the known-unreliable Chromium path.
      enabled: !this.options.trawl,
      run: ({ remainingMs, signal }) => scrapeUniversalPage({ executablePath: this.options.executablePath, timeoutMs: Math.max(1, Math.floor(remainingMs)), signal }, {
        name: SOURCE, url: 'https://postal.ninja/en/tools', responseUrl: 'https://postal.ninja/track/get',
        responseErrors: {
          'https://postal.ninja/track/check': responseError,
          'https://postal.ninja/track/get': responseError,
        },
        submit: async (page) => {
          // The official embedded widget uses an automatic browser check. The
          // main tracking page can instead require an interactive challenge.
          const form = page.frameLocator('iframe[title="Package tracking widget"]').locator('form.tracker');
          await form.locator('input[type="text"]').fill(number);
          const save = form.locator('input[type="checkbox"]');
          if (await save.count()) await save.uncheck();
          await form.locator('button[type="submit"]').click();
        },
      }, (payload) => parsePostalNinjaResponse(payload, number, timezone, carrier)),
    }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostalNinjaTracker({
    trawl: environment.trawl, fetcher: environment.fetcher,
    executablePath: environment.browserExecutablePath ?? undefined,
    recorder: environment.recorder,
  });
  return {
    id: SOURCE,
    steps: [environment.trawl ? 'trawl' : 'browser'],
    track: (input, context) => tracker.fetch(input.number, context?.budgetMs, input.timezone ?? null, context?.signal, input.carrier ?? null),
  };
};
