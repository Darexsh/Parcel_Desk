import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HRVATSKA_POSTA_MAX_BYTES, normalizeHrvatskaPostaNumber, parseHrvatskaPosta, PROVIDER } from './parser.js';

// The English page of Hrvatska pošta's tracker, which its tracking forms open with the number as `barcode`.
export const HRVATSKA_POSTA_ENDPOINT = 'https://posiljka.posta.hr/en/tracking/trackingdata';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item: the tracker answers unknown numbers with a notice.
const GONE = [404, 410];

export class HrvatskaPostaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHrvatskaPostaNumber(raw);
    const url = `${HRVATSKA_POSTA_ENDPOINT}?${new URLSearchParams({ barcode: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HRVATSKA_POSTA_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Hrvatska pošta sent the lookup to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Hrvatska pošta tracking page is unavailable');
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Hrvatska pošta returned an empty page');
      return parseHrvatskaPosta(html, number);
    };
    // A request that fails to reach Hrvatska pošta, or hangs, gets one more
    // try: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'hrvatska-posta', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: HRVATSKA_POSTA_MAX_BYTES,
        parse: html => parseHrvatskaPosta(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HrvatskaPostaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new HrvatskaPostaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'hrvatska-posta', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeHrvatskaPostaNumber(number))),
  };
};
