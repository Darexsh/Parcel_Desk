import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpxBrNumber, parseSpxBr, PROVIDER, SPX_BR_MAX_BYTES } from './parser.js';

/** The lookup the tracker on spx.com.br makes for the number in its address. */
export const SPX_BR_API = 'https://spx.com.br/shipment/order/open/order/get_order_info';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The reply as JSON; a web page in its place is a gateway's check, anything else a changed reply. */
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (/^\s*</.test(body)) throw new ChallengeError(PROVIDER, 'SPX Express Brazil answered with a web page instead of its tracking reply', { cause });
    throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a reply that is not JSON', { cause });
  }
}

export class SpxBrTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpxBrNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // `pt` is the page's own language code: its wording names no recipient.
      const url = `${SPX_BR_API}?${new URLSearchParams({ spx_tn: number, language_code: 'pt' })}`;
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SPX_BR_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The tracker reads a missing parcel from a 200 reply; a 404 or a redirect is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'SPX Express Brazil tracking lookup is unavailable', { status: response.status });
      return parseSpxBr(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'spx-br', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpxBrTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'spx-br', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSpxBrNumber(number))),
  };
};
