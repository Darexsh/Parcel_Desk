
import { load } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult, type CarrierStatus, type EventPoint } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, type TrawlClient } from '../../core/transport/index.js';
import { isDeliveryStatusCell } from './identity.js';
import { classifyStatus, comparableText, includesAny } from './status.js';

// Protocol provenance:
// - DPD France publishes a server-rendered recipient page rather than a
//   reusable JSON feed, so the timeline is read out of `#tableTrace`: one row
//   per scan, four cells (date, clock, wording, operational location), plus a
//   details block per leg (`#infos1` outbound, `#infos2` return).
// - One page can describe two parcels: an outbound number and its return
//   number. The requested number decides which leg is read; the other leg's
//   rows never enter the result.
// - Cloudflare challenges every anonymous direct request, so the page is
//   fetched through the private browser service's native scrape API when one
//   is configured, and directly only without one.
const TRACKING_BASE = 'https://trace.dpd.fr/fr/trace';
const TIMEZONE = 'Europe/Paris';
const DEFAULT_TIMEOUT_MS = 90_000;
const DIRECT_TIMEOUT_MS = 20_000;
/** The browser service keeps its own transport allowance on top of this budget. */
const SOLVER_ALLOWANCE_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

/** Cloudflare interrupted the trace page with an interactive challenge. */
export class DPDFranceChallengeError extends ChallengeError {
  constructor(message = 'DPD France returned a Cloudflare browser challenge') {
    super('DPD France', message);
    this.name = 'DPDFranceChallengeError';
  }
}

/** DPD France positively reports that it does not know the parcel number. */
export class DPDFranceTrackingError extends NotFoundError {
  constructor() {
    super('DPD France', 'DPD France could not locate the shipment');
    this.name = 'DPDFranceTrackingError';
  }
}

/** A request's own timeout, shortened to what the lookup budget has left. */
function capped(timeoutMs: number, remainingMs: number): number {
  return Math.min(timeoutMs, Math.max(1, Math.floor(remainingMs)));
}

function challenged(status: number, headers: Headers, html: string): boolean {
  return (status === 403 && headers.get('cf-mitigated') === 'challenge')
    || /Just a moment|Performing security verification|Enable JavaScript and cookies/i.test(html);
}

/** Trace rows carry naive Paris wall-clock times in two separate cells. */
function parsedEventTime(date: string, clock: string): { iso: string; timestamp: number } | null {
  return zonedTime(`${date} ${clock}`, 'dd/MM/yyyy HH:mm', TIMEZONE);
}

/** "1.2 Kg" in the details block; absent, zero and implausible values are dropped. */
function weightKg(value: string): number | null {
  const match = /^(\d+(?:[.,]\d+)?)\s*kg$/i.exec(clean(value, 32));
  const weight = match ? Number(match[1]!.replace(',', '.')) : Number.NaN;
  return Number.isFinite(weight) && weight > 0 && weight < 10_000 ? weight : null;
}

/** The details block prints a plain calendar day; only the day is retained. */
function expectedDeliveryDate(value: string): string | null {
  const parsed = zonedTime(value, 'dd/MM/yyyy', TIMEZONE, { maxLength: 32 });
  return parsed ? parsed.iso.slice(0, 10) : null;
}

/**
 * Labels print a `250` parcel number with a GS1 check digit as a sixteenth
 * digit. The trace page takes that form and shows the fifteen-digit number, so
 * it is looked up by those fifteen digits; a wrong check digit is a typo.
 */
export function normalizeDPDFranceTrackingNumber(raw: string): string {
  const value = raw.replace(/[\s.-]/g, '');
  if (/^250\d{13}$/.test(value) && hasGs1CheckDigit(value)) return value.slice(0, 15);
  if (!/^(?:[01]\d{11,14}|250\d{9,12})$/.test(value)) {
    throw new InvalidInputError('DPD France', 'DPD France tracking numbers must start with 0, 1, or 250 and contain 12 to 15 digits');
  }
  return value;
}

export function dpdFranceTrackingUrl(raw: string): string {
  const number = normalizeDPDFranceTrackingNumber(raw);
  return `${TRACKING_BASE}/${encodeURIComponent(number)}`;
}

/**
 * The delivering depot's number and map marker, from the page's depot tab
 * ("DPD France SAS Etablissement 067"). Scan rows name depots by the same
 * number: "Agence DPD de Strasbourg (67)". Its street address is never read.
 */
function deliveringDepot($: ReturnType<typeof load>): { number: number; point: EventPoint } | null {
  const depot = $('#agence');
  // Only the first line, which names the depot: <br> carries no text, so .text() would join it to the street.
  const heading = (depot.find('.agInfos').first().html() ?? '').split(/<br\s*\/?>/i)[0]!;
  const number = /\bEtablissement\s+(\d{1,4})\s*$/i.exec(clean(load(heading).text(), 200))?.[1];
  const marker = depot.find('.marker-default').first();
  const point = eventPoint(marker.attr('data-lat'), marker.attr('data-lng'));
  // Mainland France and Corsica: DPD France's depots.
  if (!number || !point || point.latitude < 41 || point.latitude > 51.5 || point.longitude < -5.5 || point.longitude > 10) {
    return null;
  }
  return { number: Number(number), point };
}

export function parseDPDFranceTrackingHtml(html: string, rawTrackingNumber: string): CarrierResult {
  const trackingNumber = normalizeDPDFranceTrackingNumber(rawTrackingNumber);
  if (!html.trim()) throw new SchemaError('DPD France', 'DPD France returned an empty tracking response');
  if (/Just a moment|Performing security verification|Enable JavaScript and cookies/i.test(html)) {
    throw new DPDFranceChallengeError();
  }

  const $ = load(html);
  const displayedNumbers = (selector: string) => $(selector).map((_, element) => (
    clean($(element).text(), 64).replace(/\D/g, '')
  )).get().filter(Boolean);
  const detailsNumbers = (selector: string) => $(`${selector} .tableInfosAR`).map((_, element) => {
    const row = $(element);
    return comparableText(row.find('strong').text()) === 'n colis'
      ? clean(row.find('.tdInfos').text(), 64).replace(/\D/g, '')
      : '';
  }).get().filter(Boolean);
  const outboundNumbers = [
    ...displayedNumbers('.parcelNumberAller'),
    ...detailsNumbers('#infos1'),
  ];
  const returnNumbers = [
    ...displayedNumbers('.parcelNumberRetour'),
    ...detailsNumbers('#infos2'),
  ];
  const responseNumbers = [...new Set([...outboundNumbers, ...returnNumbers])];

  if (responseNumbers.length === 0) {
    if (/pas en mesure de retrouver le num[eé]ro de colis|num[eé]ro de colis inconnu/i.test(html)) {
      throw new DPDFranceTrackingError();
    }
    throw new SchemaError('DPD France', 'DPD France did not return tracking details');
  }
  if (!responseNumbers.includes(trackingNumber)) {
    throw new SchemaError('DPD France', 'DPD France returned a different shipment');
  }
  const isReturn = !outboundNumbers.includes(trackingNumber) && returnNumbers.includes(trackingNumber);
  const eventSelector = isReturn
    ? '#tableTrace tr.tabTraceColisRetour'
    : '#tableTrace tr.tabTraceColisAller';
  const detailsSelector = isReturn ? '#infos2' : '#infos1';

  const depot = deliveringDepot($);
  const parsedEvents: Array<{
    event: CarrierEvent;
    status: CarrierStatus;
    timestamp: number;
    sourceIndex: number;
  }> = [];
  const seen = new Set<string>();
  $(eventSelector).slice(0, MAX_EVENTS_TO_INSPECT).each((sourceIndex, element) => {
    const row = $(element);
    const cells = row.children('td');
    const date = clean(cells.eq(0).text(), 32);
    const clock = clean(cells.eq(1).text(), 32);
    const description = clean(cells.eq(2).text());
    const cell = clean(cells.eq(3).text());
    // The delivered row's cell repeats the delivery, which is no place.
    const location = isDeliveryStatusCell(cell) ? '' : cell;
    const time = parsedEventTime(date, clock);
    if (!time || !description) return;
    const identity = JSON.stringify([time.iso, location, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    // Wording the map does not recognize carries no stage: the sync's
    // classifier decides, and the row still stays visible in the history.
    const mapped = classified.status !== 'unknown';
    const depotNumber = /\((\d{1,4})\)$/.exec(location)?.[1];
    const point = depot && depotNumber && Number(depotNumber) === depot.number ? depot.point : null;
    parsedEvents.push({
      event: {
        time: time.iso,
        location,
        description,
        ...(mapped ? { stage: classified.stage } : {}),
        ...(point ? { point } : {}),
      },
      status: classified.status,
      timestamp: time.timestamp,
      sourceIndex,
    });
  });
  parsedEvents.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  const events = parsedEvents.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  const latest = parsedEvents.find((event) => event.status !== 'unknown');
  const status = latest?.status ?? 'unknown';
  const lastStatusText = events[0]?.description ?? 'Tracking information received';

  const details = $(`${detailsSelector} .tableInfosAR`).toArray().map((element) => {
    const row = $(element);
    return { label: comparableText(row.find('strong').text()), value: row.find('.tdInfos').text() };
  });
  const expectedDelivery = details
    .filter(({ label }) => includesAny(label, ['livraison prevue', 'date de livraison prevue']))
    .map(({ value }) => expectedDeliveryDate(value))
    .find(Boolean) ?? null;
  const weight = details
    .filter(({ label }) => label.startsWith('poids'))
    .map(({ value }) => weightKg(value))
    .find((value) => value !== null) ?? null;
  const deliveredAt = status === 'delivered'
    ? events.find((event) => event.stage === 'delivered')?.time
    : undefined;

  return {
    status,
    last_status_text: lastStatusText,
    last_update: events[0]?.time ?? null,
    expected_delivery: ['delivered', 'exception'].includes(status) ? null : expectedDelivery,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    timezone: TIMEZONE,
    events,
  };
}

export interface DPDFranceTrackerOptions {
  timeoutMs?: number;
  directTimeoutMs?: number;
  /** Whole-lookup budget; defaults to both tiers plus the solver's own allowance. */
  budgetMs?: number;
  fetcher?: typeof fetch;
  trawl?: TrawlClient | null;
  recorder?: StepRecorder;
}

export class DPDFranceTracker {
  readonly timeoutMs: number;
  readonly directTimeoutMs: number;
  readonly budgetMs: number;
  private readonly fetcher?: typeof fetch;
  private readonly trawl: TrawlClient | null;
  private readonly recorder?: StepRecorder;

  constructor(options: DPDFranceTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.directTimeoutMs = Math.max(1_000, Math.min(
      this.timeoutMs,
      options.directTimeoutMs ?? DIRECT_TIMEOUT_MS,
    ));
    this.budgetMs = options.budgetMs
      ?? this.directTimeoutMs + this.timeoutMs + SOLVER_ALLOWANCE_MS;
    this.fetcher = options.fetcher;
    this.trawl = options.trawl ?? null;
    this.recorder = options.recorder;
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDPDFranceTrackingNumber(rawTrackingNumber);
    const url = dpdFranceTrackingUrl(number);
    const trawl = this.trawl;
    const direct = async (timeoutMs: number, signal: AbortSignal): Promise<string> => {
      try {
        return await this.directGet(url, capped(this.directTimeoutMs, timeoutMs), signal);
      } catch (error) {
        // The GET runs only without a browser service, so the challenge has
        // to carry the operator's next step itself.
        if (!(error instanceof DPDFranceChallengeError)) throw error;
        throw new DPDFranceChallengeError(
          'DPD France requires a browser challenge solver; configure FLARESOLVERR_URL',
        );
      }
    };
    const html = await runSteps<string>({
      carrier: 'dpd-fr', budgetMs: context.budgetMs ?? this.budgetMs, signal: context.signal, recorder: this.recorder,
    }, [
      // Cloudflare challenges every plain GET, so a browser service, when
      // there is one, is asked at once. Without one, a GET that fails to
      // reach DPD, or hangs, is sent once more: the first gets at most half
      // of what is left, so the second fits in the rest.
      { id: 'direct', enabled: trawl === null, run: ({ remainingMs, signal }) => direct(firstAttemptMs(remainingMs), signal) },
      { ...networkRetryStep(({ remainingMs, signal }) => direct(remainingMs, signal)), enabled: trawl === null },
      {
        id: 'trawl',
        enabled: trawl !== null,
        run: async ({ remainingMs, signal }) => {
          const timeoutMs = capped(this.timeoutMs, remainingMs);
          return (await trawl!.scrape({
            url,
            skipHttp: true,
            maxTier: 3,
            maxTimeout: timeoutMs,
          }, {
            provider: 'TRAWL while fetching DPD France',
            timeoutMs,
            maxBytes: MAX_RESPONSE_BYTES,
            fetcher: this.fetcher,
            signal,
          })).html;
        },
      },
    ]);
    const result = parseDPDFranceTrackingHtml(html, number);
    result.tracking_url = url;
    result.tracking_source = 'rendered-page';
    return result;
  }

  private async directGet(url: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
    const result = await fetchBounded(url, {
      signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      },
    }, {
      provider: 'DPD France tracking',
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'follow',
      allowHttpError: true,
      fetcher: this.fetcher,
    });
    const html = decodeText(result.bytes);
    if (challenged(result.response.status, result.response.headers, html)) {
      throw new DPDFranceChallengeError();
    }
    if (!result.response.ok) {
      throw new IndeterminateError('DPD France', `DPD France tracking returned HTTP ${result.response.status}`);
    }
    return html;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DPDFranceTracker({
    fetcher: environment.fetcher,
    trawl: environment.trawl,
    recorder: environment.recorder,
  });
  return {
    id: 'dpd-fr',
    // The browser service's native scrape API, or a direct HTML GET without one.
    steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
