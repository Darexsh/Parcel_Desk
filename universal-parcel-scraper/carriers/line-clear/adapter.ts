import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  LINE_CLEAR_MAX_BYTES, lineClearBranches, normalizeLineClearNumber, parseLineClear, parseLineClearBranches, PROVIDER,
  withLineClearPlaces,
} from './parser.js';

/** The lookup the tracking page on lineclearexpress.com makes for the numbers typed in. */
export const LINE_CLEAR_API = 'https://lineclearexpressonline.com/ce/1.0/viewandtrack';
/** The page's lookup of the places its branch codes stand for. */
export const LINE_CLEAR_BRANCHES = 'https://lineclearexpress.com/my/api/branchplace';
// The bearer token the tracking page's script sends with every lookup, the same for every visitor.
const PAGE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.QkVTVF9MQ1VOSV9FU1NQTA.1FcVvOUwquYYuoyA5yBrPcOLNUDf8iJaAZCqNZgjVys'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker reads a missing waybill from a 200 reply: a 404 is a moved route.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const DEFAULT_BUDGET_MS = 15_000;
// Branch places learned, kept for later lookups; the network has a few hundred branches and hubs.
const MAX_PLACES = 2_000;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Line Clear answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Line Clear returned a reply that is not JSON', { cause });
  }
}

export class LineClearTracker {
  private readonly places = new Map<string, string>();

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The tracker's reply for one waybill, as the page posts it. */
  private async lookup(number: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(LINE_CLEAR_API, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Authorization: `Bearer ${PAGE_TOKEN}`,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ SearchType: 'WayBillNumber', WayBillNumber: [number] }) }, { provider: PROVIDER,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LINE_CLEAR_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE, 500] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Line Clear redirected its tracking lookup', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Line Clear tracking lookup is unavailable', { status: response.status });
    const body = decodeText(bytes);
    if (response.status === 500) {
      // The tracker answers a refused token, and a request it cannot read, with HTTP 500 and a message.
      let message = '';
      try {
        const reply: unknown = JSON.parse(body);
        if (reply && typeof reply === 'object' && 'message' in reply && typeof reply.message === 'string') message = reply.message;
      } catch { /* An error page without a message. */ }
      if (/^Authorization failed$/i.test(message.trim())) throw new ChallengeError(PROVIDER, 'Line Clear refused the tracking page\'s key');
      throw new IndeterminateError(PROVIDER, 'Line Clear could not complete the lookup', { status: 500 });
    }
    return json(body);
  }

  /** The places of branch codes, from the lookup the page makes after the scans. */
  private async branches(codes: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<Map<string, string>> {
    const { response, bytes } = await fetchBounded(`${LINE_CLEAR_BRANCHES}?search=${codes.join(',')}`, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 64 * 1024, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Line Clear branch lookup is unavailable', { status: response.status });
    return parseLineClearBranches(json(decodeText(bytes)), codes);
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number, named: boolean): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const result = parseLineClear(await this.lookup(number, signal, timeoutMs), number);
    if (!named) return result;
    // Scans name branches by code, which the page replaces with their places. A place that
    // cannot be read fails the lookup: a scan stored once under its code and once under its
    // place would show twice.
    const codes = lineClearBranches(result);
    const places = new Map(codes.flatMap((code) => (this.places.has(code) ? [[code, this.places.get(code)!] as const] : [])));
    const missing = codes.filter((code) => !places.has(code));
    if (missing.length) {
      for (const [code, place] of await this.branches(missing, signal, deadline - performance.now())) {
        places.set(code, place);
        if (this.places.size >= MAX_PLACES) this.places.clear();
        this.places.set(code, place);
      }
    }
    return withLineClearPlaces(result, places);
  }

  /** `named: false` keeps branch codes, for a recognition that needs no places. */
  async fetch(raw: string, context: TrackingContext = {}, named = true): Promise<CarrierResult> {
    const number = normalizeLineClearNumber(raw);
    // A read that fails to reach Line Clear, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'line-clear', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs), named) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs, named)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LineClearTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'line-clear', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, false),
      () => accepted(() => normalizeLineClearNumber(number))),
  };
};
