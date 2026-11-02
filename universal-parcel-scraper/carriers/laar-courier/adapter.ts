import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { LAAR_MAX_BYTES, laarCurrentState, laarLabelRow, laarSearchRow, normalizeLaarNumber, parseLaar, PROVIDER } from './parser.js';

/** The API the tracking page on fenix.laarcourier.com reads a guía from. */
export const LAAR_API = 'https://fenix.laarcourier.com/Tracking/api';
// The page's script sends both with every request, the same for every visitor.
const AUTHORIZATION = 'Basic YWRtaW46YWRtaW4='; // gitleaks:allow
const API_KEY = 'hL4bA4nB4yI0vI0fC8fH7eT6'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// The API answers an unknown guía in its reply: a missing route is not a missing parcel.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com|captcha/i;

export type LaarRoute = 'search' | 'label' | 'steps' | 'transit' | 'incidents';

/** The request the page makes on each route, for the whole guía. */
export function laarRequest(route: LaarRoute, number: string, state = 0): { url: string; method: 'GET' | 'POST'; body?: string } {
  const query = new URLSearchParams({ guia: number });
  switch (route) {
    case 'search': return { url: `${LAAR_API}/buscar/guia?${query}`, method: 'GET' };
    case 'label': return { url: `${LAAR_API}/etiqueta/deprati?${query}`, method: 'GET' };
    case 'transit': return { url: `${LAAR_API}/estadosTransito?${query}`, method: 'GET' };
    case 'steps': return { url: `${LAAR_API}/estados`, method: 'POST', body: JSON.stringify({ idEstado: state, guia: number, tipoConsulta: 0 }) };
    case 'incidents': return { url: `${LAAR_API}/novedades`, method: 'POST', body: JSON.stringify({ guia: number, tipoConsulta: 0 }) };
  }
}

function json(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Laar answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Laar returned a reply that is not JSON', { cause });
  }
}

export class LaarCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(route: LaarRoute, number: string, signal: AbortSignal, timeoutMs: number, state?: number): Promise<unknown> {
    const { url, method, body } = laarRequest(route, number, state);
    const { response, bytes } = await fetchBounded(url, { method, signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Authorization: AUTHORIZATION, API_KEY_LAAR: API_KEY,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, ...(body ? { body } : {}) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LAAR_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 401, 403] });
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'Laar tracking lookup is unavailable', { status: response.status });
    }
    // The API refuses a request without the page's key or its basic credentials with HTTP 401, whatever the guía.
    if (response.status === 401) throw new ChallengeError(PROVIDER, 'Laar refused the tracking page\'s key', { status: 401 });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Laar refused the lookup', { status: 403 });
    return json(decodeText(bytes));
  }

  /**
   * The page's reads in its order: the guía's record, which tells an unknown
   * guía, then its label, which names it and gives the current state, then
   * the timeline, the problems reported and the transit details the page asks
   * for when its in-transit step is opened, together. When one of those
   * fails, the others are cancelled.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The attempt's requests share its time.
    const started = performance.now();
    const left = () => Math.max(1, Math.floor(timeoutMs - (performance.now() - started)));
    const search = await this.get('search', number, signal, left());
    laarSearchRow(search);
    const label = await this.get('label', number, signal, left());
    const state = laarCurrentState(laarLabelRow(label, number));
    const sibling = new AbortController();
    const all = AbortSignal.any([signal, sibling.signal]);
    const settle = (route: LaarRoute) => this.get(route, number, all, left(), state).catch((error: unknown) => {
      sibling.abort(error);
      throw error;
    });
    const [steps, transit, incidents] = await Promise.all([settle('steps'), settle('transit'), settle('incidents')]);
    return parseLaar({ search, label, steps, transit, incidents }, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLaarNumber(raw);
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'laar-courier', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LaarCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'laar-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLaarNumber(number))),
  };
};
