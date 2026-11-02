import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { COURIERSPLEASE_MAX_BYTES, couriersPleaseToken, normalizeCouriersPleaseNumber, parseCouriersPlease, PROVIDER } from './parser.js';

/** The tracking page, which opens the session its lookup needs. */
export const COURIERSPLEASE_PAGE = 'https://www.couriersplease.com.au/tools-track';
/** The lookup the tracking page makes for the numbers typed in. */
export const COURIERSPLEASE_API = 'https://www.couriersplease.com.au/api/track/locate';
const ORIGIN = 'https://www.couriersplease.com.au';
const PAGE_MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Azure Front Door's own page when its firewall refuses a request: a 429 for
// too many requests at once, a 403 for a blocked client.
const BLOCKED = /<title>\s*Service unavailable\s*<\/title>|The request is blocked\./i;
// Bot checks a CDN could put in place of the page or the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|challenge-platform/i;
// The session cookie the page sets beside its token.
const SESSION = /^__Host-csrf=[A-Za-z0-9._~+/=-]{8,512}$/;

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim() ?? '';
  return /^\d{1,5}$/.test(value) ? Number(value) * 1000 : undefined;
}

/** A refusal before any reply: a rate limit, a firewall block or a moved route. */
function refusal(response: Response, body: string, stage: string): never {
  if (response.status === 429) {
    throw new RateLimitedError(PROVIDER, retryAfterMs(response), `CouriersPlease rate limited its ${stage}`, { status: 429 });
  }
  if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
    throw new TransportError(PROVIDER, `CouriersPlease ${stage} is unavailable`, { status: response.status });
  }
  if (BLOCKED.test(body) || CHALLENGE.test(body)) throw new ChallengeError(PROVIDER, `CouriersPlease blocked its ${stage}`, { status: response.status });
  throw new ChallengeError(PROVIDER, `CouriersPlease refused its ${stage}`, { status: response.status });
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000)) || CHALLENGE.test(body.slice(0, 64_000))) {
      throw new ChallengeError(PROVIDER, 'CouriersPlease answered with a block page', { cause });
    }
    throw new SchemaError(PROVIDER, 'CouriersPlease returned a reply that is not JSON', { cause });
  }
}

export class CouriersPleaseTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCouriersPleaseNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page and the lookup share the attempt's time.
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const page = await fetchBounded(COURIERSPLEASE_PAGE, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent,
      } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: PAGE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE, 403, 429] });
      const html = decodeText(page.bytes);
      if (page.response.status !== 200) refusal(page.response, html.slice(0, 64_000), 'tracking page');
      if (BLOCKED.test(html.slice(0, 64_000)) || CHALLENGE.test(html.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'CouriersPlease answered the tracking page with a block page');
      }
      // The lookup takes the page's token with the cookie it was minted for.
      const token = couriersPleaseToken(html);
      const cookie = page.response.headers.getSetCookie().map((header) => header.split(';', 1)[0]!.trim()).find((part) => SESSION.test(part));
      if (!token || !cookie) throw new SchemaError(PROVIDER, 'CouriersPlease tracking page opened no session');

      const { response, bytes } = await fetchBounded(COURIERSPLEASE_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent, Origin: ORIGIN,
        // The service answers only requests its own pages make, as browsers mark them.
        'Sec-Fetch-Site': 'same-origin', 'csrf-token': token, Cookie: cookie,
      }, body: JSON.stringify({ trackingCode: number }) }, { provider: PROVIDER, timeoutMs: left(), maxBytes: COURIERSPLEASE_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 403, 429] });
      const body = decodeText(bytes);
      if (response.status === 400 || response.status === 403) {
        // The session the page just opened was refused: a fresh one is the only remedy.
        if (/CSRF/i.test(body.slice(0, 4_000))) throw new IndeterminateError(PROVIDER, 'CouriersPlease refused the tracking page’s session');
        if (response.status === 400 && !BLOCKED.test(body.slice(0, 4_000))) throw new IndeterminateError(PROVIDER, 'CouriersPlease did not take the lookup');
      }
      if (response.status !== 200) refusal(response, body.slice(0, 64_000), 'tracking lookup');
      return parseCouriersPlease(json(body), number);
    };
    // A page or lookup that fails to reach CouriersPlease, or hangs, gets one
    // more try with a new session: the first gets half of the budget.
    return runSteps({ carrier: 'couriersplease', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CouriersPleaseTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'couriersplease', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCouriersPleaseNumber(number))),
  };
};
