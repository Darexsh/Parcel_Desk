import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTforceFreightNumber, parseTforceFreight, parseTforceFreightForm, PROVIDER } from './parser.js';

/** The tracking page: its search form, and where the form posts the PROs. */
export const TFORCE_FREIGHT_TRACKING = 'https://www.tforcefreight.com/ltl/apps/Tracking';
// The pages are about 180 to 220 kB.
const MAX_BYTES = 1_000_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// The anti-forgery cookie, named after the application's path, and the firewall's own.
const SESSION_COOKIE = /^(?:__RequestVerificationToken(?:_[A-Za-z0-9_-]{1,40})?|TS[0-9a-f]{6,32})$/;
const COOKIE_VALUE = /^[^\s;,]{1,1024}$/;

function sessionCookies(response: Response): string {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (separator > 0 && SESSION_COOKIE.test(name) && COOKIE_VALUE.test(value)) jar.set(name, value);
  }
  if (![...jar.keys()].some(name => name.startsWith('__RequestVerificationToken'))) {
    throw new IndeterminateError(PROVIDER, 'TForce Freight did not open an anonymous session');
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

export class TforceFreightTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const pro = normalizeTforceFreightNumber(raw);
    const budgetMs = context.budgetMs ?? 20_000;
    // One attempt opens a session on the tracking page and posts the PRO with its token, as the page's search does.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' };
      const read = async (init: RequestInit) => {
        const reply = await fetchBounded(TFORCE_FREIGHT_TRACKING, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
        if (reply.response.status !== 200) throw new TransportError(PROVIDER, 'TForce Freight tracking page moved');
        return reply;
      };
      const form = await read({ headers });
      const token = parseTforceFreightForm(decodeText(form.bytes));
      const cookie = sessionCookies(form.response);
      signal.throwIfAborted();
      // The page's script ends each PRO with a semicolon. The CAPTCHA answer stays empty while the page asks for none.
      const lookup = await read({ method: 'POST', headers: { ...headers, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ __RequestVerificationToken: token, ProNumbers: `${pro};`, TrackingByPROresponseToken: '' }) });
      return parseTforceFreight(decodeText(lookup.bytes), pro);
    };
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tforce-freight', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new TforceFreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tforce-freight', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTforceFreightNumber(number))),
  };
};
