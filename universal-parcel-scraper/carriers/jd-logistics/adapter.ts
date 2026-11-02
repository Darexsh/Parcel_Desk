import { recognizeFromBrowserLookup, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf, type TrawlClient } from '../../core/transport/index.js';
import { jdDomesticBrowser, jdDomesticCandidate } from './domestic.js';
import { normalizeJdNumber, parseJdLogistics } from './parser.js';

// Request builder in the official international Tracking page's proxy client.
const ENDPOINT = 'https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1';
const HEADERS = {
  'Content-Type': 'application/json', 'LOP-DN': 'pro-intl-cms-interface.jdl.com',
  ClientInfo: '{"appName":"intl_cms","client":"m"}',
  AppParams: '{"appid":"intl-cms-interface-web","ticket_type":"pc"}',
};

/**
 * How long the domestic page is not opened for a waybill after its verification declined: 6 hours
 * after the first decline in a row, twice as long after each next one, up to a day. The matcher
 * declines most puzzles, so a waybill it keeps declining is left to the providers most of the
 * time. A bound answer clears it. Every tracker in the process shares this; a restart forgets it.
 */
export const DECLINE_HOLD_MS = 6 * 60 * 60_000;
export const MAX_DECLINE_HOLD_MS = 24 * 60 * 60_000;
const MAX_DECLINED = 1_000;
const declined = new Map<string, { at: number; count: number }>();

function declineHeldMs(number: string, now: number): number {
  const decline = declined.get(number);
  return decline ? Math.max(0, decline.at + Math.min(MAX_DECLINE_HOLD_MS, DECLINE_HOLD_MS * 2 ** (decline.count - 1)) - now) : 0;
}

function noteDecline(number: string, now: number): void {
  const count = (declined.get(number)?.count ?? 0) + 1;
  declined.delete(number);
  declined.set(number, { at: now, count });
  for (const oldest of declined.keys()) {
    if (declined.size <= MAX_DECLINED) break;
    declined.delete(oldest);
  }
}

async function domesticHistory(trawl: TrawlClient, number: string, signal: AbortSignal, remainingMs: number) {
  if (declineHeldMs(number, Date.now()) > 0) {
    throw new ChallengeError('JD Logistics', 'JD domestic verification declined this waybill recently', { reason: 'verification_unreadable' });
  }
  try {
    const result = await jdDomesticBrowser(trawl, number, signal, remainingMs);
    declined.delete(number);
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) declined.delete(number);
    else if (error instanceof ChallengeError && error.reason === 'verification_unreadable') noteDecline(number, Date.now());
    throw error;
  }
}

export class JdLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}, browser = true) {
    const number = normalizeJdNumber(raw);
    const domestic = browser && jdDomesticCandidate(number) && !!this.options.trawl;
    return runSteps({ carrier: 'jd-logistics', signal: context.signal, budgetMs: context.budgetMs ?? (domestic ? 45_000 : 15_000),
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal, headers: { ...HEADERS, 'User-Agent': userAgentOf(this.options.userAgent) },
          body: JSON.stringify([{ magicNoList: [number], clientIp: '$cooMrdGatewayIp$', lang: 'en', timeZone: 'UTC' }]),
        }, { provider: 'JD Logistics', timeoutMs: Math.max(1, Math.floor(domestic ? Math.min(15_000, remainingMs / 3) : remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        return parseJdLogistics(parseJsonBytes(bytes, 'JD Logistics'), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError('JD Logistics', 'JD Logistics tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
    } }, { id: 'trawl', enabled: domestic,
      recovers: error => error instanceof IndeterminateError && error.reason === 'portal_not_found',
      run: ({ signal, remainingMs }) => domesticHistory(this.options.trawl!, number, signal, remainingMs),
    }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new JdLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return { id: 'jd-logistics', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, false)),
    recognizeWithBrowser: (number, context) => jdDomesticCandidate(normalizeJdNumber(number))
      ? recognizeFromBrowserLookup(() => tracker.fetch(number, context)) : Promise.resolve({ known: false, lastActivityAt: null }),
  };
};
