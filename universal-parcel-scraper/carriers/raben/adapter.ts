import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeRabenNumber, parseRaben, PROVIDER, RABEN_MAX_BYTES } from './parser.js';

/** The deep link raben-group.com's tracking form opens, and the endpoint of the page it starts. */
export const RABEN_LINK = 'https://oftc.myraben.com/link/ShipmentInformation';
export const RABEN_SESSION = 'https://oftc.myraben.com/xas/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown number in its session: a missing route is not a missing shipment.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;
// The session the deep link opens, and the cookie naming its server.
const SESSION_COOKIE = /^(?:XASSESSIONID|XASID)$/;
const COOKIE_VALUE = /^[^\s;,]{1,256}$/;
// The page's own request for its session's data, with the deep link's search in it.
const SESSION_DATA = JSON.stringify({ action: 'get_session_data', params: { hybrid: false, offline: false, referrer: null, profile: '',
  timezoneoffset: 0, timezoneId: 'UTC', preferredLanguages: ['en'], version: 2 } });

function sessionCookies(response: Response, body: string): string {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (separator > 0 && SESSION_COOKIE.test(name) && COOKIE_VALUE.test(value)) jar.set(name, value);
  }
  if (!jar.has('XASSESSIONID')) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Raben answered with a browser check');
    throw new IndeterminateError(PROVIDER, 'Raben did not open an anonymous session');
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Raben answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Raben returned a reply that is not JSON', { cause });
  }
}

export class RabenTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRabenNumber(raw);
    const link = `${RABEN_LINK}?${new URLSearchParams({ ShipmentNumber: number, Language: 'EN' })}`;
    // One attempt opens the deep link, which starts an anonymous session on the number,
    // then asks for that session's data, as the page does when it loads.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      const opened = await fetchBounded(link, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgent } }, { provider: PROVIDER,
        timeoutMs: left(), maxBytes: RABEN_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (GONE.includes(opened.response.status)) throw new TransportError(PROVIDER, 'Raben tracking link moved', { status: opened.response.status });
      if (opened.response.status === 403) throw new ChallengeError(PROVIDER, 'Raben refused the tracking link', { status: 403 });
      const cookie = sessionCookies(opened.response, decodeText(opened.bytes));
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(RABEN_SESSION, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie, 'User-Agent': userAgent,
      }, body: SESSION_DATA }, { provider: PROVIDER, timeoutMs: left(), maxBytes: RABEN_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 401, 403] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Raben session endpoint moved', { status: response.status });
      }
      // The server refuses the session it has just opened: nothing is said about the shipment.
      if (response.status === 401) throw new IndeterminateError(PROVIDER, 'Raben refused its own session', { status: 401 });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Raben refused the session request', { status: 403 });
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (!body) throw new IndeterminateError(PROVIDER, 'Raben returned an empty reply');
      return parseRaben(json(body), number);
    };
    // An attempt that fails to reach Raben, or hangs, gets one more in a new session:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'raben', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RabenTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'raben', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeRabenNumber(number))),
  };
};
