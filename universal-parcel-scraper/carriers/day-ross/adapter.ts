import { accepted, recognizeFromLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { API, dayRossOrder, MAX_BYTES, normalizeDayRossNumber, parseDayRoss, PROVIDER } from './parser.js';

// Public Sitecore origin: it renders the same anonymous tracker behind the CDN.
const PAGE = 'https://prod-dayross.azurewebsites.net/track-shipments';

function withoutToken(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(PROVIDER, error.cause);
  return error;
}

export class DayRossTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDayRossNumber(raw);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { Accept: 'application/json', 'User-Agent': userAgentOf(this.environment.userAgent) };
      const read = async (url: string, bearer?: string) => {
        try {
          return await fetchBounded(url, { signal, headers: bearer ? { ...headers, Authorization: `Bearer ${bearer}`, Language: 'EN' } : headers },
            { provider: PROVIDER, timeoutMs: remaining(), maxBytes: MAX_BYTES, fetcher: this.environment.fetcher, allowHttpStatuses: [401, 403] });
        } catch (error) { throw withoutToken(error); }
      };
      const page = await read(PAGE);
      if ([401, 403].includes(page.response.status)) throw new ChallengeError(PROVIDER, 'Day & Ross refused the guest tracking page');
      const state = /<script\b(?=[^>]*\bid="__JSS_STATE__")[^>]*>(.*?)<\/script>/s.exec(decodeText(page.bytes))?.[1];
      let parsed: unknown;
      try { parsed = JSON.parse(state ?? ''); } catch { throw new SchemaError(PROVIDER, 'Day & Ross returned no guest tracking configuration'); }
      const sitecore = isRecord(parsed) && isRecord(parsed.sitecore) ? parsed.sitecore : {};
      const profile = isRecord(sitecore.context) && isRecord(sitecore.context.profileData) ? sitecore.context.profileData : {};
      const token = isRecord(profile.app_settings) ? profile.app_settings.service_apiKey : undefined;
      if (!isRecord(profile.basic_info) || profile.basic_info.isAuthenticated !== false || typeof token !== 'string'
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 8192) {
        throw new IndeterminateError(PROVIDER, 'Day & Ross did not issue an anonymous tracking session');
      }
      const json = async (url: string): Promise<unknown> => {
        signal.throwIfAborted();
        const reply = await read(url, token);
        if ([401, 403].includes(reply.response.status)) throw new ChallengeError(PROVIDER, 'Day & Ross refused the guest tracking session');
        try { return JSON.parse(decodeText(reply.bytes)); } catch { throw new SchemaError(PROVIDER, 'Day & Ross returned invalid JSON'); }
      };
      const order = dayRossOrder(await json(`${API}/TruckMateAPI/api/ManageOrders/TrackOrders?ShipmentNumbers=${number}`), number);
      if (!order) {
        // An empty current-system search says nothing about older shipments.
        if (!/^A\d{8,12}$/.test(number)) throw new IndeterminateError(PROVIDER, 'Day & Ross requires its older tracking service for this shipment');
        throw new NotFoundError(PROVIDER);
      }
      // Despite the parameter name, the page passes orderId, not the printed PRO.
      return parseDayRoss(await json(`${API}/TruckMateAPI/api/ManageOrders/TrackOrderById?probillNumber=${encodeURIComponent(String(order.orderId))}`), number, order);
    };
    return runSteps({ carrier: 'day-ross', budgetMs: context.budgetMs ?? 20000, signal: context.signal, recorder: this.environment.recorder }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DayRossTracker(environment);
  return { id: 'day-ross', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeDayRossNumber(number))) };
};
