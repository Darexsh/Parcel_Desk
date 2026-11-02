import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseSuratHistory, PROVIDER, SURAT_BLOCKED, SURAT_HISTORY, SURAT_ORIGIN, SURAT_PAGE, suratHistoryTokens, suratKargoNumber, suratKargoResult } from './parser.js';

export class SuratKargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = suratKargoNumber(raw);
    return runSteps({ carrier: 'surat-kargo', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const deadline = performance.now() + remainingMs;
      const userAgent = userAgentOf(this.options.userAgent);
      const pageUrl = `${SURAT_ORIGIN}${SURAT_PAGE}?${new URLSearchParams({ kargotakipno: number })}`;
      const read = async (url: string, init: RequestInit) => {
        let response: Response;
        let bytes: Uint8Array;
        try {
          ({ response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, fetcher,
            timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: 1_000_000, redirect: 'manual', allowHttpStatuses: [404, 410] }));
        } catch (error) {
          // Transport details can hold the guest capability or session cookie.
          // Keep the failure kind, status, retry window and network cause.
          if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
          if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
          throw error;
        }
        if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'Sürat Kargo tracking endpoint is unavailable');
        if (SURAT_BLOCKED.test(decodeText(bytes).slice(0, 16_000))) throw new ChallengeError(PROVIDER, 'Sürat Kargo answered with a block page');
        return bytes;
      };
      const html = decodeText(await read(pageUrl, { method: 'GET', headers: { Accept: 'text/html', 'User-Agent': userAgent } }));
      const tokens = suratHistoryTokens(html, number, pageUrl);
      const histories = [];
      for (const token of tokens) {
        const bytes = await read(`${SURAT_ORIGIN}${SURAT_HISTORY}`, { method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': userAgent, Referer: pageUrl },
          body: JSON.stringify({ kargotakipno: token }) });
        let payload: unknown;
        try { payload = parseJsonBytes(bytes, PROVIDER); }
        catch { throw new SchemaError(PROVIDER, 'Sürat Kargo returned an invalid history response'); }
        histories.push(parseSuratHistory(payload));
      }
      return suratKargoResult(histories);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SuratKargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'surat-kargo', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => suratKargoNumber(number))) };
};
