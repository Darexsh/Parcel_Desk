import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FLASH_EXPRESS_PH_MAX_BYTES, normalizeFlashExpressPhNumber, parseFlashExpressPh, PROVIDER } from './parser.js';

/** The parcel lookup the Flash Express PH app makes before anyone signs in. */
export const FLASH_EXPRESS_PH_API = 'https://user-api.flashexpress.ph/api/pub/v1/parcels/track_parcel_batch';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks that could come in place of the reply: the five-second browser
// check in front of the website, and those of Alibaba Cloud, where it sits.
const CHALLENGE = /ge_ua_p|X-GE-UA-Step|<title>\s*5 Second Shield|Browser security check|acw_sc__v2|aliyun_waf|_____tmd_____|_cf_chl_opt|cf-turnstile|<title>\s*Just a moment/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Flash Express Philippines answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Flash Express Philippines returned a reply that is not JSON', { cause });
  }
}

export class FlashExpressPhTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFlashExpressPhNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The app asks with its public flag and the signature photos; the adapter keeps no photo.
      const { response, bytes } = await fetchBounded(FLASH_EXPRESS_PH_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'en', 'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ pno_list: [number], pub_query: true, show_sign_pic: false }) }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FLASH_EXPRESS_PH_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Flash Express Philippines redirected its parcel lookup');
      // The service answers every number with HTTP 200; a 404 is a moved route, not an unknown parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Flash Express Philippines parcel lookup is unavailable');
      return parseFlashExpressPh(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'flash-express-ph', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FlashExpressPhTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'flash-express-ph', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFlashExpressPhNumber(number))),
  };
};
