import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeMngKargoNumber, parseMngKargo, parseMngKargoForm, PROVIDER } from './parser.js';

const ORIGIN = 'https://www.dhlecommerce.com.tr';
/** The tracking page, whose form carries the anti-forgery token. */
const FORM = `${ORIGIN}/gonderitakip`;
/** Where the form posts the number. */
const LOOKUP = `${ORIGIN}/gonderi-takip`;
// The pages are about 50 and 85 kB.
const MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// The anti-forgery cookie, and the firewall's own.
const SESSION_COOKIE = /^(?:\.AspNetCore\.Antiforgery\.[A-Za-z0-9_-]{1,40}|TS[0-9a-f]{6,32})$/;
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
  if (![...jar.keys()].some(name => name.startsWith('.AspNetCore.Antiforgery.'))) {
    throw new IndeterminateError(PROVIDER, 'DHL eCommerce Türkiye did not open an anonymous session');
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** The tracker's answer for a number it does not know: back to the home page with its notice. */
function isNotFound(location: string): boolean {
  let target: URL;
  try { target = new URL(location, LOOKUP); }
  catch { throw new SchemaError(PROVIDER, 'DHL eCommerce Türkiye tracking redirect is invalid'); }
  const query = target.searchParams;
  return target.origin === ORIGIN && target.pathname === '/' && [...query.keys()].length === 2
    && query.get('ResultStatus') === 'True' && query.get('CargoCompany') === 'NotFound';
}

export class MngKargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMngKargoNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    // One attempt opens a session on the tracking page and posts the number with its token.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html', 'Accept-Language': 'tr-TR,tr;q=0.9' };
      const form = await fetchBounded(FORM, { signal, headers }, { provider: PROVIDER, timeoutMs: left(), maxBytes: MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
      if (form.response.status !== 200) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Türkiye tracking page is unavailable');
      const token = parseMngKargoForm(decodeText(form.bytes));
      const cookie = sessionCookies(form.response);
      signal.throwIfAborted();
      const lookup = await fetchBounded(LOOKUP, { method: 'POST', signal, headers: { ...headers, Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Referer: FORM },
      body: new URLSearchParams({ __RequestVerificationToken: token, form_shipment: number }) }, { provider: PROVIDER,
        timeoutMs: left(), maxBytes: MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(lookup.response.status)) {
        if (isNotFound(lookup.response.headers.get('location') ?? '')) throw new NotFoundError(PROVIDER);
        // An error page, such as a refused token, says nothing about the shipment.
        throw new IndeterminateError(PROVIDER, 'DHL eCommerce Türkiye did not answer the lookup');
      }
      if (lookup.response.status !== 200) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Türkiye tracking is unavailable');
      return parseMngKargo(decodeText(lookup.bytes), number);
    };
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'mng-kargo', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new MngKargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mng-kargo', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMngKargoNumber(number))),
  };
};
