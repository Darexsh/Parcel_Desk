import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { asyadNumber, parseAsyadExpress, parseOmanPost, PROVIDER } from './parser.js';

export const ASYAD_EXPRESS_ENDPOINT = 'https://apix.asyadexpress.com/v1/customer/order/';
export const OMAN_POST_ENDPOINT = 'https://poboxes.omanpost.om/TrackOrders/api/MyUSWebApi/TrackingDetails';

// Shared guest-tracking authorization shipped to every official app install.
const GUEST_AUTHORIZATION = 'oauth 3292343tgrfdvsd4b08bf17ec9e603rr456htrs3'; // gitleaks:allow

export class AsyadExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = asyadNumber(raw);
    return runSteps({ carrier: 'asyad-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const read = async (url: string, authorization?: string) => {
        const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent), ...(authorization ? { Authorization: authorization } : {}),
        } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
          maxBytes: 1_000_000, redirect: 'manual', allowHttpStatuses: [400, 401, 403, 404] });
        if ([400, 401, 403].includes(response.status) || /<title>\s*(?:Request Rejected|Access Denied|Attention Required)|requested URL was rejected/i.test(decodeText(bytes).slice(0, 16_000))) {
          throw new ChallengeError(PROVIDER, 'Asyad Express refused guest tracking access');
        }
        if (response.status === 404 && !/json/i.test(response.headers.get('content-type') ?? '')) {
          throw new TransportError(PROVIDER, 'Asyad Express tracking endpoint is unavailable');
        }
        return { payload: parseJsonBytes(bytes, PROVIDER), status: response.status };
      };
      const express = await read(`${ASYAD_EXPRESS_ENDPOINT}${number}/ultimate-history`, GUEST_AUTHORIZATION);
      const found = parseAsyadExpress(express.payload, number, express.status);
      if (found) return found;
      // The app checks the postal system after an explicit express miss. An
      // express outage, malformed reply or challenge never becomes absence.
      const postal = await read(`${OMAN_POST_ENDPOINT}?${new URLSearchParams({ TrackingID: number })}`);
      return parseOmanPost(postal.payload, number, postal.status);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AsyadExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'asyad-express', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => asyadNumber(number))) };
};
