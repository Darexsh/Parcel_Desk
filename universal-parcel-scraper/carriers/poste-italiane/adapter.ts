import { BrowserRouteTrial, browserContextProxy, retryShare, type BrowserContextProxy } from '../../core/transport/browserRouteTrial.js';
import { fetchPosteItalianeInBrowser } from './browser.js';

import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isPosteItalianeLookup } from '../../core/detection/posteItaliane.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, ImportCharges } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { clean, fetchBounded, parseJsonBytes, UpstreamHttpError, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { runSteps } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { classifyPosteItalianeStatus, posteItalianeMovementWording } from './status.js';

// Protocol provenance:
// - Prior art (structure + vocabulary, verified independently below, MIT):
//   https://github.com/ha-parcel-integrations/ha-poste-italiane (api.py,
//   parcels.py status map, tests/payloads.py — keyless DoveQuando endpoint,
//   esitoRicerca envelope, epoch-millis dataOra, Europe/Rome ETA text).
// - Live verification 2026-09-10: unknown codes answer HTTP 200 with
//   esitoRicerca "1"; old expired parcels answer without esitoRicerca and
//   with empty listaMovimenti. The success vocabulary in status.ts was
//   confirmed against a real parcel 2026-08-24 by the prior-art client.
// - Deep link verified live in a real browser session: .../cerca/index.html
//   #/risultati-spedizioni/{code} resolves the code and renders the tracker
//   (expired parcels show the documented "Tracciatura non disponibile").
const TRACKING_ENDPOINT = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
const DEFAULT_TIMEOUT_MS = 15_000;
/** `fetchBounded` repeats a request that failed in transit once, after this pause. */
const TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_RETURN = 20;

const ITALIAN_MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

function expectedDeliveryDay(value: unknown): string | null {
  // dataPrevistaConsegna reads like "Consegna prevista entro Giovedì 1 Gennaio
  // 2026": reduce it to the local calendar day, never a timestamp.
  if (typeof value !== 'string') return null;
  // Note: \w is ASCII-only in JS without the u flag and would choke on accented
  // weekday names like "Venerdì", so the weekday group excludes spaces/digits
  // instead (Python's \w would have matched; kept equivalent here).
  const match = /(?:consegna prevista(?: entro)?\s+)(?:[^\s\d]+\s+)?(\d{1,2})\s+([a-zà]+)\s+(\d{4})/i.exec(value);
  if (!match) return null;
  const month = ITALIAN_MONTHS[match[2]!.toLocaleLowerCase('it-IT')];
  if (!month) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  if (!Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year)) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/**
 * dataOra is epoch milliseconds (numbers, occasionally numeric strings).
 * `core/time`'s epochMillisTime suppresses milliseconds in its ISO output;
 * this adapter has always emitted them, and the value is persisted, so the
 * local helper stays rather than silently rewriting stored timestamps.
 */
function parsedTime(value: unknown): { iso: string; timestamp: number } | null {
  const millis = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  return { iso, timestamp: millis };
}

/**
 * A depot scan's place is a town and its province, as "PESCARA (PE)" or
 * "NAPOLI NA", and a delivery reads "dalla sede operativa di" that town. Any
 * other place, such as a post office's street address or a street named with
 * its province, stays out. The country follows the province, which would
 * otherwise read as one: "TORINO (TO)" is not in Tonga.
 */
const STREET = /^(?:VIA|VIALE|VICOLO|PIAZZA|PIAZZALE|PIAZZETTA|CORSO|LARGO|STRADA|LUNGOMARE|LUNGOTEVERE|CONTRADA|LOCALIT(?:À|A'?)|FRAZIONE|SALITA)(?:\s|$)/u;
function townLabel(value: unknown): string {
  const text = clean(value, 120).replace(/^dalla sede operativa di\s+/u, '');
  const match = /^([A-ZÀ-Ý][A-ZÀ-Ý' .-]{1,40}?)\s+(?:\(([A-Z]{2})\)|([A-Z]{2}))$/u.exec(text);
  return match && !STREET.test(match[1]!) ? `${match[1]} (${match[2] ?? match[3]}), IT` : '';
}

/** The product the parcel travels under; letter-post items echo their own number instead. */
function serviceName(value: unknown, trackingNumber: string): string {
  const text = clean(value, 80);
  return /^[\p{L}][\p{L}\d '+.&-]{2,59}$/u.test(text) && !/\d{6}/.test(text)
    && text.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '') !== trackingNumber ? text : '';
}

// Poste's import charges, in euro cents: customs duty and VAT together, and its own
// clearance fee as paid on delivery and as paid online beforehand ("Smart"), which the
// fee table on its page for receiving from abroad prices at €21.00 and €18.00 above €150.
const CHARGES = { customs: 'importoDirittiDoganali', carrier_fee: 'importoDirittiPostali', carrier_fee_online: 'importoDirittiPostaliSmart' } as const;

/** The import charges an item from outside the EU owes, as `oneri` lists them. */
function importCharges(value: unknown): { import_charges: ImportCharges } | Record<string, never> {
  if (!isRecord(value)) return {};
  const charges: ImportCharges = { currency: 'EUR' };
  for (const [field, key] of Object.entries(CHARGES) as Array<[keyof typeof CHARGES, string]>) {
    const cents = clean(value[key], 12);
    if (/^\d{1,9}$/.test(cents)) charges[field] = Number(cents) / 100;
  }
  // PAGATO is paid. FINESTRA_PAGAMENTO_CHIUSA closes the online payment window: what is
  // left is paid on delivery, so the online price no longer applies. It says nothing sure
  // about payment, and stays a code like any other.
  const status = clean(value.statoOneri, 60);
  if (status === 'PAGATO') charges.paid = true;
  if (status === 'FINESTRA_PAGAMENTO_CHIUSA') delete charges.carrier_fee_online;
  if (/^[A-Z][A-Z_]*$/.test(status)) charges.status_code = status;
  return Object.keys(charges).length > 1 ? { import_charges: charges } : {};
}

/**
 * How many searches are sent through one transport in an hour. The service asks for its CAPTCHA
 * once an address has sent twenty in the past hour, the refused ones included, and until the
 * hour holds fewer: a search over the limit would only prolong the refusals.
 */
export const HOURLY_SEARCHES = 18;
/**
 * How long after a CAPTCHA no search is sent, since searches this transport did not send drew it,
 * and after an HTTP 429 that names no wait of its own.
 */
export const CAPTCHA_PAUSE_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * When one transport sent its past hour's searches and until when the service asked it to wait.
 * The service counts an address's searches, so every tracker in the process that sends through
 * the same fetcher, recognition included, shares this. A restart forgets it.
 */
interface SearchState { sentAt: number[]; pausedUntil: number }
const searchStates = new WeakMap<object, SearchState>();
const GLOBAL_FETCH = {};

function searchState(fetcher: typeof fetch | undefined): SearchState {
  const key = transportOf(fetcher) ?? GLOBAL_FETCH;
  let state = searchStates.get(key);
  if (!state) searchStates.set(key, state = { sentAt: [], pausedUntil: 0 });
  return state;
}

/** How long until the transport may search again, 0 when it may now. */
function pacedMs(state: SearchState, now: number): number {
  const sentAt = state.sentAt = state.sentAt.filter((at) => now - at < HOUR_MS);
  const hourly = sentAt.length < HOURLY_SEARCHES ? 0 : sentAt[sentAt.length - HOURLY_SEARCHES]! + HOUR_MS - now;
  return Math.max(hourly, state.pausedUntil - now);
}

/**
 * An HTTP 429 pauses the transport's searches for the wait its Retry-After names, in seconds or as
 * a date, at most an hour, else for the CAPTCHA's pause. The lookup fails as rate-limited with the
 * time until the transport searches again.
 */
function rateLimited(state: SearchState, retryAfter: string | null | undefined): RateLimitedError {
  const value = retryAfter?.trim() ?? '';
  const named = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  const waitMs = Number.isFinite(named) && named > 0 ? Math.min(named, HOUR_MS) : CAPTCHA_PAUSE_MS;
  state.pausedUntil = Math.max(state.pausedUntil, Date.now() + waitMs);
  return new RateLimitedError('Poste Italiane', pacedMs(state, Date.now()));
}

/**
 * After a burst of searches from one address, the service refuses more with HTTP 400 and an
 * error envelope until the caller solves its CAPTCHA.
 */
function captchaRequired(bytes: Uint8Array): boolean {
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(payload) && payload.tipo === 'error' && /captcha/i.test(clean(payload.descrizione, 200));
  } catch {
    return false;
  }
}

export function normalizePosteItalianeTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!isPosteItalianeLookup(value)) {
    throw new InvalidInputError('Poste Italiane', 'Poste Italiane tracking requires a Poste Italiane identifier or a postal S10 number');
  }
  return value;
}

export function posteItalianeTrackingUrl(rawTrackingNumber: string): string {
  return `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${encodeURIComponent(normalizePosteItalianeTrackingNumber(rawTrackingNumber))}`;
}

export function parsePosteItalianeTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const requested = normalizePosteItalianeTrackingNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('Poste Italiane', 'Poste Italiane returned an invalid tracking response');
  const returned = clean(payload.idTracciatura, 64).toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!returned) throw new SchemaError('Poste Italiane', 'Poste Italiane did not return a shipment identifier');
  if (returned !== requested) throw new SchemaError('Poste Italiane', 'Poste Italiane returned a different shipment');
  const esito = clean(payload.esitoRicerca, 8);
  // Native negative outcomes remain distinct from HTTP endpoint failures.
  if (esito === '1' || esito === '2') throw new NotFoundError('Poste Italiane');
  if (Object.hasOwn(payload, 'esitoRicerca') && esito !== '3') {
    throw new SchemaError('Poste Italiane', 'Poste Italiane returned an invalid result envelope');
  }
  const rawMovements = payload.listaMovimenti;
  // A letter-post code Poste does not know, such as one whose check digit fails, answers as
  // letter post (tipoSpedizione C) at stato 1 with neither a product nor a movement list.
  if (esito === '3' && payload.tipoSpedizione === 'C' && clean(payload.stato, 8) === '1'
    && !Object.hasOwn(payload, 'listaMovimenti') && !Object.hasOwn(payload, 'tipoProdotto')) {
    throw new NotFoundError('Poste Italiane');
  }
  if (!Array.isArray(rawMovements)) {
    throw new SchemaError('Poste Italiane', 'Poste Italiane returned invalid tracking history');
  }
  const parsed: Array<{
    event: CarrierEvent; classified: ClassifiedStatus | undefined; returnTrip: boolean | undefined; timestamp: number; index: number;
  }> = [];
  const seen = new Set<string>();
  rawMovements.filter(isRecord).slice(0, 500).forEach((rawEvent, index) => {
    const wording = posteItalianeMovementWording(clean(rawEvent.statoLavorazione, 500), rawEvent.box);
    const time = parsedTime(rawEvent.dataOra);
    if (!time || !wording) return;
    const identity = `${time.iso}\u0000${wording}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyPosteItalianeStatus(wording);
    parsed.push({
      // A post-office scan names its office, which becomes the location; the
      // office's address, postcode and hours are not kept. Other scans keep
      // luogo only when it is a town and province. Sender, dimensions and
      // pickup-office blocks on the envelope are never retained either.
      // Unmapped wording keeps no stage: the sync classifies it and records
      // where the stage came from instead of assuming movement here.
      event: {
        time: time.iso,
        location: clean(rawEvent.denominazioneUfficio, 80) || townLabel(rawEvent.luogo),
        description: wording,
        ...(classified ? { stage: classified.stage } : {}),
      },
      classified: classified ?? undefined,
      returnTrip: typeof rawEvent.flagRitorno === 'boolean' ? rawEvent.flagRitorno : undefined,
      timestamp: time.timestamp,
      index,
    });
  });
  // Movements come oldest first, so of two sharing an instant the later one is newer.
  parsed.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const events = parsed.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  const service = serviceName(payload.tipoProdotto, requested);
  const facts = { ...(service ? { service_name: service } : {}), ...importCharges(payload.oneri) };
  if (rawMovements.length > 0 && events.length === 0) {
    throw new SchemaError('Poste Italiane', 'Poste Italiane returned unusable tracking history');
  }
  // A return after the newest delivery outranks it: a parcel left at a pickup
  // point and not collected goes back to the sender.
  const delivery = parsed.findIndex((item) => item.classified?.stage === 'delivered');
  const returnedSince = delivery > 0
    && parsed.slice(0, delivery).some((item) => item.returnTrip === true || item.classified?.stage === 'returned');
  const sentBack = (): CarrierResult => ({
    status: 'exception',
    current_stage: 'returned',
    last_status_text: events[0]?.description ?? 'Returned',
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...facts,
    events,
  });
  // Envelope stato "5" forces delivered; otherwise the newest mapped event wins
  // and unmapped wording stays unknown with its raw text preserved.
  if (payload.stato === '5' || payload.stato === 5) {
    // A parcel sent back ends with its delivery to the sender. That delivery
    // carries the return flag; without per-movement flags, the envelope flag
    // and an earlier return scan say the same.
    const newest = parsed[0];
    const backToSender = returnedSince || (newest?.returnTrip
      ?? (payload.flagRitorno === true && parsed.slice(1).some((item) => item.classified?.stage === 'returned')));
    if (backToSender) return sentBack();
    return {
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: events[0]?.description ?? 'Delivered',
      last_update: events[0]?.time ?? null,
      expected_delivery: null,
      ...facts,
      events,
    };
  }
  if (returnedSince) return sentBack();
  const latest = parsed.find((item) => item.classified);
  if (!latest) {
    if (events.length > 0) {
      // Movements exist but none map: report unknown with the newest raw
      // wording preserved rather than a wrong status or a false pending.
      return {
        status: 'unknown',
        last_status_text: events[0]!.description,
        last_update: events[0]?.time ?? null,
        expected_delivery: expectedDeliveryDay(payload.dataPrevistaConsegna),
        ...facts,
        events,
      };
    }
    if (esito === '3') {
      return {
        status: 'pending',
        current_stage: 'registered',
        last_status_text: 'Tracking information received',
        last_update: null,
        expected_delivery: expectedDeliveryDay(payload.dataPrevistaConsegna),
        ...facts,
        events,
      };
    }
    // The observed expired parcel carries a native parcel type and an explicit
    // empty movement array, with no search outcome. An echoed identifier alone
    // or another unrecognized envelope is not this negative contract.
    if (!Object.hasOwn(payload, 'esitoRicerca') && payload.tipoSpedizione === 'P') {
      throw new NotFoundError('Poste Italiane');
    }
    throw new IndeterminateError('Poste Italiane', 'Poste Italiane returned no shipment activity or native result');
  }
  return {
    status: latest.classified!.status,
    current_stage: latest.classified!.stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time ?? null,
    expected_delivery: expectedDeliveryDay(payload.dataPrevistaConsegna),
    ...facts,
    events,
  };
}

export class PosteItalianeTracker {
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch | undefined;
  private readonly userAgent: string;
  private readonly retryProxy: BrowserContextProxy | null;
  private readonly retryProxyShare: number;

  constructor(private readonly options: { timeoutMs?: number; fetcher?: typeof fetch; userAgent?: string; trawl?: TrawlClient | null; recorder?: StepRecorder; browserWsEndpoint?: string | null; browserRetryProxy?: string | null; browserRetryShare?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Poste Italiane tracking timeout must be positive');
    }
    this.userAgent = userAgentOf(options.userAgent);
    this.retryProxy = options.browserRetryProxy ? browserContextProxy(options.browserRetryProxy) : null;
    this.retryProxyShare = retryShare(options.browserRetryShare ?? 0.5);
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizePosteItalianeTrackingNumber(rawTrackingNumber);
    const trial = new BrowserRouteTrial<BrowserContextProxy | null>({ primary: null, alternative: this.retryProxy,
      route: 'residential', share: this.retryProxyShare, steps: ['trawl', 'browser'], recorder: this.options.recorder });
    return runSteps({ carrier: 'poste-italiane', signal: context.signal, recorder: trial.recorder,
      budgetMs: context.budgetMs ?? ((this.options.trawl || this.options.browserWsEndpoint) ? 45_000 : 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS) }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.direct(trackingNumber, { signal, budgetMs: remainingMs }) },
      { id: 'trawl', enabled: !!this.options.trawl, recovers: error => error instanceof ChallengeError,
        run: ({ signal, remainingMs, previousError }) => {
          if (remainingMs < 8000) throw previousError;
          trial.primary();
          return this.browser(trackingNumber, signal, remainingMs).then(result => trial.result(result));
        } },
      { id: 'browser', enabled: !!this.options.browserWsEndpoint, recovers: error => error instanceof ChallengeError,
        run: async ({ signal, remainingMs, previousError }) => {
          if (remainingMs < 4000) throw previousError;
          const payload = await fetchPosteItalianeInBrowser(trackingNumber, this.options.browserWsEndpoint!, signal,
            Math.min(15_000, remainingMs - 1000), trial.retry());
          const result = parsePosteItalianeTrackingResponse(payload, trackingNumber);
          // Residential replies can omit an older movement despite an unchanged latest scan.
          // Keep richer sources eligible until this route's full-history coverage is established.
          return trial.result(trial.isAlternate && result.events?.length ? { ...result, history_truncated: true } : result);
        } },
    ]);
  }

  private async direct(trackingNumber: string, context: TrackingContext): Promise<CarrierResult> {
    // The default budget covers the request, the pause and the one transient retry.
    const budget = lookupBudget(context, 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS);
    const state = searchState(this.fetcher);
    const waitMs = pacedMs(state, Date.now());
    if (waitMs > 0) {
      throw new RateLimitedError('Poste Italiane', waitMs, 'Poste Italiane was searched as often as an hour allows', { reason: 'self_paced' });
    }
    budget.signal.throwIfAborted();
    state.sentAt.push(Date.now());
    const { response, bytes } = await fetchBounded(TRACKING_ENDPOINT, {
      method: 'POST',
      signal: budget.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Origin: 'https://www.poste.it',
        Referer: 'https://www.poste.it/',
        'User-Agent': this.userAgent,
      },
      body: JSON.stringify({ codiceSpedizione: trackingNumber, tipoRichiedente: 'WEB', periodoRicerca: 1 }),
    }, {
      provider: 'Poste Italiane tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      retryTransient: true,
      allowHttpError: true,
      fetcher: this.fetcher,
    });
    budget.signal.throwIfAborted();
    if ([404, 410].includes(response.status)) {
      throw new TransportError('Poste Italiane', 'Poste Italiane tracking endpoint is unavailable', {
        cause: new UpstreamHttpError('Poste Italiane tracking', response.status),
      });
    }
    if (response.status === 429) throw rateLimited(state, response.headers.get('retry-after'));
    if (response.status === 400 && captchaRequired(bytes)) {
      state.pausedUntil = Math.max(state.pausedUntil, Date.now() + CAPTCHA_PAUSE_MS);
      throw new ChallengeError('Poste Italiane', 'Poste Italiane asks for a CAPTCHA before more searches');
    }
    if (!response.ok) throw new UpstreamHttpError('Poste Italiane tracking', response.status);
    return parsePosteItalianeTrackingResponse(parseJsonBytes(bytes, 'Poste Italiane tracking'), trackingNumber);
  }

  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const timeoutMs = Math.floor(remainingMs - 2000);
    const page = await this.options.trawl!.scrape({ url: posteItalianeTrackingUrl(number), skipHttp: true, maxTier: 3,
      captureResponses: [TRACKING_ENDPOINT], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
    { provider: 'Poste Italiane', timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 6 * MAX_RESPONSE_BYTES });
    signal.throwIfAborted();
    const responses = page.capturedResponses.filter(row => row.url === TRACKING_ENDPOINT);
    const response = responses.at(-1);
    if (!response || responses.length > 10) throw new ChallengeError('Poste Italiane', 'Poste Italiane returned no matching browser response');
    if (response.status === 429) throw rateLimited(searchState(this.fetcher), response.headers['retry-after'] ?? response.headers['Retry-After']);
    const bytes = new TextEncoder().encode(response.body ?? '');
    if ([401, 403].includes(response.status) || (response.status === 400 && captchaRequired(bytes))) {
      throw new ChallengeError('Poste Italiane', 'Poste Italiane still requires verification');
    }
    if (response.status >= 400) throw new UpstreamHttpError('Poste Italiane', response.status);
    if (response.status !== 200 || response.error || response.truncated || response.base64Encoded || !response.body) {
      throw new TransportError('Poste Italiane', 'Poste Italiane returned an incomplete browser response');
    }
    if (bytes.length > MAX_RESPONSE_BYTES) throw new SchemaError('Poste Italiane', 'Poste Italiane returned excessive browser data');
    return parsePosteItalianeTrackingResponse(parseJsonBytes(bytes, 'Poste Italiane'), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const options = { fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder };
  const endpoint = environment.env.POSTE_ITALIANE_BROWSER_WS_ENDPOINT?.trim() || null;
  const tracker = new PosteItalianeTracker({ ...options, trawl: environment.trawl, browserWsEndpoint: endpoint,
    browserRetryProxy: environment.env.POSTE_ITALIANE_RETRY_PROXY_URL,
    browserRetryShare: environment.env.POSTE_ITALIANE_RETRY_PROXY_PERCENT === undefined ? 0.5
      : Number(environment.env.POSTE_ITALIANE_RETRY_PROXY_PERCENT) / 100 });
  // Cheap recognition never opens a browser or spends the shared audio allowance.
  const recognition = new PosteItalianeTracker(options);
  return {
    id: 'poste-italiane',
    recordsSteps: true,
    steps: endpoint ? ['direct', 'trawl', 'browser'] : ['direct', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => recognition.fetch(number, context), () => accepted(() => normalizePosteItalianeTrackingNumber(number))),
  };
};
