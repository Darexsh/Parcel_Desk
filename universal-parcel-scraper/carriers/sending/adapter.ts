import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSendingNumber, parseSending, PROVIDER, SENDING_MAX_BYTES } from './parser.js';

const ORIGIN = 'https://info.sending.es';
/** Where the search form on sending.es posts the number, as `localizador`. */
export const SENDING_LOOKUP = `${ORIGIN}/fgts/pub/locNumSeguimiento.seam?web=S`;
/** The pages the lookup redirects to: one shipment's tracking, or the tracker's not-found notice. */
const ANSWERS = new Set(['/fgts/priv/expediciones/tracking_expedicion_seguimiento.seam', '/fgts/no_encontrado_2.seam']);
const SIGN_IN = '/fgts/login.seam';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

/** The session the lookup opened; its answer page is bound to it. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const match = /^JSESSIONID=([A-Za-z0-9._:~-]{1,256})(?:;|$)/.exec(header);
    if (match) return `JSESSIONID=${match[1]}`;
  }
  throw new IndeterminateError(PROVIDER, 'Sending did not open a session for the lookup');
}

/** The answer page the lookup redirects to, without the session it repeats in its path. */
function answerUrl(location: string | null): URL {
  if (!location || location.length > 2_000) throw new SchemaError(PROVIDER, 'Sending returned an incomplete redirect');
  let url: URL;
  try { url = new URL(location, ORIGIN); } catch { throw new SchemaError(PROVIDER, 'Sending returned an invalid redirect'); }
  const path = url.pathname.replace(/;jsessionid=[A-Za-z0-9._:~-]{1,256}$/, '');
  const conversation = url.searchParams.get('cid') ?? '';
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => key !== 'cid')
    || url.searchParams.getAll('cid').length !== 1 || !/^\d{1,12}$/.test(conversation)) {
    throw new SchemaError(PROVIDER, 'Sending redirected the lookup to an unexpected address');
  }
  if (path === SIGN_IN) throw new IndeterminateError(PROVIDER, 'Sending sent the lookup to its sign-in page');
  if (!ANSWERS.has(path)) throw new SchemaError(PROVIDER, 'Sending redirected the lookup to an unexpected page');
  return new URL(`${ORIGIN}${path}?${new URLSearchParams({ cid: conversation })}`);
}

export class SendingTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSendingNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const request = async (url: string | URL, init: RequestInit & { headers: Record<string, string> }) => {
        const result = await fetchBounded(url, { ...init, signal, headers: {
          Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent), ...init.headers,
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: SENDING_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
        if (result.response.status === 403) throw new ChallengeError(PROVIDER, 'Sending refused the lookup', { status: 403 });
        if (GONE.includes(result.response.status)) {
          throw new IndeterminateError(PROVIDER, 'Sending tracking page is unavailable', { status: result.response.status });
        }
        return result;
      };
      // The search form's own request; the tracker answers it with a redirect
      // to a page bound to the session it opens.
      const lookup = await request(SENDING_LOOKUP, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ localizador: number }).toString() });
      if (!REDIRECTS.includes(lookup.response.status)) return parseSending(decodeText(lookup.bytes), number);
      const url = answerUrl(lookup.response.headers.get('location'));
      const answer = await request(url, { method: 'GET', headers: { Cookie: sessionCookie(lookup.response) } });
      if (REDIRECTS.includes(answer.response.status)) {
        throw new TransportError(PROVIDER, 'Sending redirected its answer page', { status: answer.response.status });
      }
      return parseSending(decodeText(answer.bytes), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try in
    // a new session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'sending', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SendingTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sending', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSendingNumber(number))),
  };
};
