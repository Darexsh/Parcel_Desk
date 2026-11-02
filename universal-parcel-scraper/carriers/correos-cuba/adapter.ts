import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  assertNotChallenged, CORREOS_CUBA_MAX_BYTES, correosCubaPageToken, isExpiredCorreosCubaToken, normalizeCorreosCubaNumber, parseCorreosCuba, PROVIDER,
} from './parser.js';

/** The tracker page, which gives every visitor the token its lookups carry. */
export const CORREOS_CUBA_PAGE = 'https://www.correos.cu/rastreador-de-envios/';
/** The lookup the page's script posts the code, the year and the token to. */
export const CORREOS_CUBA_LOOKUP = 'https://www.correos.cu/wp-json/correos-api/enviosweb/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown code in its reply: a missing route is not a missing item.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;
const ZONE = 'America/Havana';

export class CorreosCubaTracker {
  // The page gives every visitor the same token, which lasts beyond one lookup.
  private token: string | undefined;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  private async pageToken(signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(CORREOS_CUBA_PAGE, { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: CORREOS_CUBA_MAX_BYTES, redirect: 'manual',
      allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'The Correos de Cuba tracker moved', { status: response.status });
    }
    this.token = correosCubaPageToken(decodeText(bytes));
    return this.token;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCorreosCubaNumber(raw);
    // The tracker finds an item in the year asked and the one before; the page asks Havana's current year.
    const year = String(DateTime.fromMillis(this.options.now?.() ?? Date.now(), { zone: ZONE }).year);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - Date.now()));
      const lookup = async (token: string): Promise<unknown> => {
        const { response, bytes } = await fetchBounded(CORREOS_CUBA_LOOKUP, { method: 'POST', signal, headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01', 'Accept-Language': 'es',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
          Referer: CORREOS_CUBA_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
        }, body: new URLSearchParams({ codigo: number, anno: year, token, user: '' }).toString() },
        { provider: PROVIDER, timeoutMs: left(), maxBytes: CORREOS_CUBA_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
        if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
          throw new TransportError(PROVIDER, 'The Correos de Cuba lookup moved', { status: response.status });
        }
        const body = decodeText(bytes);
        if (!body.trim()) throw new IndeterminateError(PROVIDER, 'Correos de Cuba returned an empty reply');
        try {
          return JSON.parse(body);
        } catch (cause) {
          assertNotChallenged(body);
          throw new SchemaError(PROVIDER, 'Correos de Cuba returned a reply that is not JSON', { cause });
        }
      };
      const cached = this.token;
      let payload = await lookup(cached ?? await this.pageToken(signal, left()));
      // A reused token the tracker has dropped is replaced once.
      if (isExpiredCorreosCubaToken(payload) && cached) {
        this.token = undefined;
        payload = await lookup(await this.pageToken(signal, left()));
      }
      if (isExpiredCorreosCubaToken(payload)) {
        this.token = undefined;
        throw new ChallengeError(PROVIDER, 'Correos de Cuba refused its own page token');
      }
      return parseCorreosCuba(payload, number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'correos-cuba', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreosCubaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'correos-cuba', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCorreosCubaNumber(number))),
  };
};
