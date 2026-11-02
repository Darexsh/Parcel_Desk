import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { CDEK_ERRORS, CDEK_MAX_BYTES, cdekErrorCode, normalizeCdekNumber, parseCdek, PROVIDER } from './parser.js';

// The guest lookup of CDEK's app and of its order page on my.cdek.ru. It asks
// for no key, cookie or phone confirmation. The tracker on www.cdek.ru sits
// behind a bot check that gives a headless browser a CAPTCHA.
export const CDEK_ENDPOINT = 'https://my.cdek.ru/api/lkfl/v3/tracing/trackInfoBeta/';
// The service's own refusals come with a JSON code; 404 is also its answer for an unknown number.
const ANSWERS = [400, 403, 404, 422, 429];
// ServicePipe's bot check, which fronts CDEK's sites and can answer with HTTP 200.
const BLOCKED = /servicepipe\.tech|js-challenge-loader|id_captcha_frame_div|get_cookie_spsn|<title>\s*(?:403 )?Forbidden/i;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

export class CdekTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCdekNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${CDEK_ENDPOINT}${encodeURIComponent(number)}`, {
        signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CDEK_MAX_BYTES,
        allowHttpStatuses: ANSWERS, fetcher: this.options.fetcher });
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (response.status === 403 || BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) {
          throw new ChallengeError(PROVIDER, 'CDEK answered with its bot check', { cause });
        }
        if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), undefined, { cause });
        if (!response.ok) throw new TransportError(PROVIDER, `CDEK tracking service answered HTTP ${response.status}`, { cause });
        throw new SchemaError(PROVIDER, 'CDEK returned invalid tracking JSON', { cause });
      }
      if (response.ok) return parseCdek(payload, number);
      switch (cdekErrorCode(payload)) {
        // Only the service's own notice is a missing order; a missing route is not.
        case CDEK_ERRORS.notFound: throw new NotFoundError(PROVIDER);
        case CDEK_ERRORS.limit: throw new RateLimitedError(PROVIDER, retryAfterMs(response), 'CDEK limits how many numbers a client tracks');
        case CDEK_ERRORS.later: throw new IndeterminateError(PROVIDER, 'CDEK asked to try the number again later');
        case CDEK_ERRORS.short:
        case CDEK_ERRORS.long: throw new InvalidInputError(PROVIDER, 'CDEK refused the number\'s length', { reason: 'wrong_number' });
      }
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response));
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'CDEK refused the guest lookup');
      throw new TransportError(PROVIDER, `CDEK tracking service answered HTTP ${response.status}`);
    };
    // A request that fails to reach CDEK, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'cdek', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CdekTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'cdek', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCdekNumber(number))),
  };
};
