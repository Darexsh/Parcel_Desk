import { accepted, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { NIPPON_EXPRESS_MAX_BYTES, normalizeNipponExpressNumber, parseNipponExpress, PROVIDER } from './parser.js';

/** The air tracker's list, which its search form opens with the numbers in `denpyoNo1` to `denpyoNo10`. */
export const NIPPON_EXPRESS_ENDPOINT = 'https://lp-trace.nittsu.co.jp/web/webarpaa702.srv';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing shipment: an unknown number gets a row saying so.
const GONE = [404, 410];
// The labels the WHATWG decoder reads as Shift_JIS. The tracker names Windows-31J.
const SHIFT_JIS = new Set(['shift_jis', 'shift-jis', 'sjis', 'windows-31j', 'ms932', 'ms_kanji', 'csshiftjis', 'x-sjis']);

function decode(response: Response, bytes: Uint8Array): string {
  const charset = /charset="?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]?.toLowerCase();
  if (charset === undefined || SHIFT_JIS.has(charset)) return decodeText(bytes, 'shift_jis');
  if (charset === 'utf-8' || charset === 'utf8') return decodeText(bytes);
  throw new SchemaError(PROVIDER, 'Nippon Express response encoding changed');
}

export class NipponExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeNipponExpressNumber(raw);
    const url = `${NIPPON_EXPRESS_ENDPOINT}?${new URLSearchParams({ LANG: 'JP', denpyoNo1: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en;q=0.5',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: NIPPON_EXPRESS_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Nippon Express sent the lookup to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Nippon Express tracking page is unavailable');
      const html = decode(response, bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Nippon Express returned an empty page');
      return parseNipponExpress(html, number, (this.options.now ?? Date.now)());
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest. An
    // HTTP status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'nippon-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  /**
   * The list names the whole number it holds a shipment for, so any row it
   * returns is known, also under a status the map does not stage.
   */
  async recognize(number: string, context: TrackingContext = {}): Promise<Recognition> {
    if (!accepted(() => normalizeNipponExpressNumber(number))) return { known: false };
    let result: CarrierResult;
    try {
      result = await this.fetch(number, context);
    } catch (error) {
      if (['not_found', 'invalid_input'].includes(carrierErrorKind(error) ?? '')) return { known: false };
      throw error;
    }
    return { known: true, lastActivityAt: result.last_update ?? null };
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NipponExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'nippon-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
