import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  hispapostBarcode, hispapostFormToken, HISPAPOST_MAX_BYTES, normalizeHispapostNumber, parseHispapost, parseHispapostRefusal, PROVIDER,
} from './parser.js';

/** The tracking page hispapost.es links to; its form posts back to the same address. */
export const HISPAPOST_TRACKING = 'https://intranet.hispapost.es/tracking';
const SESSION = /^_hispapost_session=[A-Za-z0-9%._~+/=-]{1,4096}$/;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 20_000;

/** The session cookie the page sets, which the form's token is bound to. */
function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().map((header) => header.split(';', 1)[0]!.trim()).find((part) => SESSION.test(part));
  if (!cookie) throw new SchemaError(PROVIDER, 'Hispapost’s tracking page set no session');
  return cookie;
}

export class HispapostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async request(init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<{ status: number; html: string; response: Response }> {
    const { response, bytes } = await fetchBounded(HISPAPOST_TRACKING, { ...init, signal, headers: {
      ...init.headers as Record<string, string>, Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HISPAPOST_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, 422] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Hispapost tracking page is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Hispapost refused the lookup', { status: 403 });
    return { status: response.status, html: decodeText(bytes), response };
  }

  /** The page, for its form token and session, then the form posted with the barcode. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, deadline - performance.now());
    const page = await this.request({ method: 'GET' }, signal, left());
    if (page.status !== 200) throw new TransportError(PROVIDER, 'Hispapost redirected its tracking page', { status: page.status });
    const token = hispapostFormToken(page.html);
    const cookie = sessionCookie(page.response);
    const answer = await this.request({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ authenticity_token: token, barcode: hispapostBarcode(number) }).toString() }, signal, left());
    // A token the session does not match sends the form to the staff sign-in.
    if (REDIRECTS.includes(answer.status)) throw new SchemaError(PROVIDER, 'Hispapost refused the tracking page’s form token', { status: answer.status });
    if (answer.status === 422) parseHispapostRefusal(answer.html, number);
    return parseHispapost(answer.html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHispapostNumber(raw);
    // A lookup that fails to reach Hispapost, or hangs, starts again with a
    // new page once: the first try gets half of the budget.
    return runSteps({ carrier: 'hispapost', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HispapostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'hispapost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
