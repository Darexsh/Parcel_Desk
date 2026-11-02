import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTufesaNumber, parseTufesa, PROVIDER, TUFESA_MAX_BYTES } from './parser.js';

/** The lookup the tracker on tufesapack.com makes for each code typed in. */
export const TUFESA_API = 'https://ventas.tufesa.com.mx/wsrestwebjson/commdatosenvio';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks, or the block page of the Fortinet firewall in front of the lookup, that could come in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|Web Page Blocked|FortiWeb|Attack ID|Incapsula|captcha/i;

/** The lookup's address for one number, with the `push` placeholder the page sends. */
export function tufesaLookupUrl(number: string): string {
  return `${TUFESA_API}?codigo=${encodeURIComponent(normalizeTufesaNumber(number))}&push=-`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TufesaPack answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'TufesaPack returned a reply that is not JSON', { cause });
  }
}

export class TufesaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTufesaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(tufesaLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TUFESA_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'TufesaPack redirected its tracking lookup');
      // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'TufesaPack tracking lookup is unavailable');
      return parseTufesa(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'tufesa', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TufesaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tufesa', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTufesaNumber(number))),
  };
};
