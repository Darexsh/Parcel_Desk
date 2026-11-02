import { createHash } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { recoverableByDefault, runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { dhlPolandBrowser } from './browser.js';
import { normalizeDhlEcommercePlNumber, parseDhlEcommercePl, parseDhlEcommercePlChallenge, parseDhlEcommercePlRejection,
  type DhlEcommercePlChallenge } from './parser.js';

const PROVIDER = 'DHL eCommerce Poland';
// The guest routes behind mojdhl.pl. They return the current status and none
// of the recipient's details.
const BASE = 'https://mojdhl.pl/api/dhl/public';

/**
 * The proof of work the page computes for every visitor before a lookup: the
 * number whose SHA-256 with the salt is the challenge, sent back with the
 * signed challenge.
 */
export async function solveDhlEcommercePlChallenge(task: DhlEcommercePlChallenge, signal: AbortSignal, deadline: number, budgetMs: number): Promise<string> {
  for (let number = 0; number <= task.maxnumber; number += 1) {
    if (createHash('sha256').update(task.salt + number).digest('hex') === task.challenge) {
      return Buffer.from(JSON.stringify({ algorithm: task.algorithm, challenge: task.challenge, number, salt: task.salt, signature: task.signature })).toString('base64');
    }
    if (number % 2048 === 2047) {
      // Let cancellation and deadline timers run during the search.
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new BudgetExceededError(PROVIDER, budgetMs);
    }
  }
  throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland sent a request challenge without a solution');
}

export class DhlEcommercePlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDhlEcommercePlNumber(raw);
    const budgetMs = context.budgetMs ?? (this.options.trawl ? 65_000 : 15_000);
    let confirmed: CarrierResult | undefined;
    let waybill: string | undefined;
    const read = async (signal: AbortSignal, remainingMs: number) => {
      signal.throwIfAborted();
      // One deadline covers the challenge, its solution and the lookup.
      const deadline = performance.now() + remainingMs;
      const left = () => {
        const ms = Math.floor(deadline - performance.now());
        if (ms <= 0) throw new BudgetExceededError(PROVIDER, budgetMs);
        return ms;
      };
      // A page in place of JSON is a block, whatever its status says.
      const json = (bytes: Uint8Array): unknown => {
        try { return parseJsonBytes(bytes, PROVIDER); }
        catch {
          if (/Request Rejected|The requested URL was rejected|Access Denied|cf-chl-|_cf_chl_opt|cf-turnstile|Incapsula incident|<title>\s*(?:Just a moment|Attention Required)/i.test(decodeText(bytes.subarray(0, 64000)))) {
            throw new ChallengeError(PROVIDER, 'DHL eCommerce Poland returned a browser challenge');
          }
          throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland returned a page instead of tracking JSON');
        }
      };
      // The signed per-request proof stays out of failure diagnostics. Each
      // retry obtains a fresh challenge rather than replaying a spent proof.
      const request = async (url: string, init: RequestInit, options: Parameters<typeof fetchBounded>[2]) => {
        try { return await fetchBounded(url, { ...init, signal }, options); }
        catch (error) {
          if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
          if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, new Error('DHL eCommerce Poland tracking request failed'));
          throw error;
        }
      };
      const headers = { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent) };
      const issued = await request(`${BASE}/auth/captcha/challenge`, { signal, headers }, {
        provider: PROVIDER, timeoutMs: left(), maxBytes: 20_000, fetcher: this.options.fetcher,
      });
      const proof = await solveDhlEcommercePlChallenge(parseDhlEcommercePlChallenge(json(issued.bytes)), signal, deadline, budgetMs);
      signal.throwIfAborted();
      const { response, bytes } = await request(`${BASE}/shipment/status`, { method: 'POST', signal,
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ number1: number, 'captcha-payload': proof }) }, {
        provider: PROVIDER, timeoutMs: left(), maxBytes: 500_000, allowHttpStatuses: [400, 422], fetcher: this.options.fetcher,
      });
      if (response.status === 422) return parseDhlEcommercePlRejection(json(bytes));
      // A 400 is the portal refusing the proof: nothing was looked up.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland returned an inconclusive tracking response');
      const payload = json(bytes);
      const result = parseDhlEcommercePl(payload, number);
      // Parsing first establishes the whole submitted number and one shipment.
      const entry: unknown = Array.isArray(payload) ? payload[0] : undefined;
      const shipment: unknown = isRecord(entry) && Array.isArray(entry.shipments) ? entry.shipments[0] : undefined;
      const alias = isRecord(shipment) ? shipment.shipmentNumber : undefined;
      waybill = typeof alias === 'string' && /^\d{11}$/.test(alias) ? alias : /^\d{11}$/.test(number) ? number : undefined;
      confirmed = result;
      return result;
    };
    return runSteps({ carrier: 'dhl-ecommerce-pl', budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'trawl', enabled: !!this.options.trawl, run: async ({ signal, remainingMs }) => {
        const started = performance.now();
        const summary = await read(signal, Math.min(15_000, firstAttemptMs(remainingMs)));
        if (!waybill) throw new IndeterminateError(PROVIDER, 'DHL Poland returned no waybill for its history page');
        const history = await dhlPolandBrowser(this.options.trawl!, waybill, signal, remainingMs - (performance.now() - started) - 500);
        return { ...summary, ...history };
      } },
      { id: 'direct', recovers: error => confirmed !== undefined || recoverableByDefault(error),
        run: async ({ signal, remainingMs }) => confirmed ?? read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const options = { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent };
  const tracker = new DhlEcommercePlTracker({ ...options, trawl: environment.trawl });
  const http = new DhlEcommercePlTracker(options);
  return { id: 'dhl-ecommerce-pl', recordsSteps: true, steps: ['trawl', 'direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeDhlEcommercePlNumber(number))) };
};
