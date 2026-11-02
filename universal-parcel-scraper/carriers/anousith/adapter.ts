import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ANOUSITH_MAX_BYTES, anousithItem, anousithScans, normalizeAnousithNumber, parseAnousith, PROVIDER } from './parser.js';

/** The GraphQL API behind app.anousith.express's tracking pages. */
export const ANOUSITH_API = 'https://pro.api.anousith.express/graphql';
// The API answers only requests that come from its own app.
const REFERER = 'https://app.anousith.express/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply, and the page
// the API redirects a request from elsewhere to.
const CHALLENGE = /captcha|_cf_chl_opt|cf-turnstile|hack\s*prank|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;

// The API reads the query text line by line and needs its operation name, so
// each query goes as the app sends it: one field per line, with its name. It
// answers one root field per request.
const ITEM_QUERY = `query ItemsV2($where: ItemV2WhereInput, $limit: Int) {
  itemsV2(where: $where, limit: $limit) {
    total
    data {
      trackingId
      itemStatus
      isBackward
      weight
      createdDate
      originReceiveDate
      originSendDate
      destReceiveDate
      destSendDate
      sendCompleteDate
      receiveBackwardDate
      originBranchId {
        branch_name
      }
      destBranchId {
        branch_name
      }
      originProvinceId {
        provinceName
      }
      destProvinceId {
        provinceName
      }
    }
  }
}`;

const SCAN_QUERY = `query ScanItems($orderBy: OrderByInput, $where: ScanItemWhereInput, $limit: Int) {
  scanItems(orderBy: $orderBy, where: $where, limit: $limit) {
    data {
      trackingId
      branch {
        branch_name
      }
      center {
        centerName
      }
      createdAt
      transportStatus
      scanStatus
    }
  }
}`;

/** The bill share page's query for one bill, and the search page's for its scans. */
export function anousithRequests(number: string): { items: string; scans: string } {
  return {
    items: JSON.stringify({ operationName: 'ItemsV2', variables: { where: { trackingId: number, isDeleted: 0 }, limit: 2 }, query: ITEM_QUERY }),
    scans: JSON.stringify({ operationName: 'ScanItems', variables: { where: { trackingId: number } }, query: SCAN_QUERY }),
  };
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Anousith answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Anousith returned a reply that is not JSON', { cause });
  }
}

export class AnousithTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async post(body: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(ANOUSITH_API, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Referer: REFERER, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ANOUSITH_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    // The API redirects a request it does not take, one without its app's Referer for instance, to another site.
    if (REDIRECTS.includes(response.status)) throw new ChallengeError(PROVIDER, 'Anousith turned the lookup away');
    // An unknown bill is an empty list; a missing route is a moved API.
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Anousith tracking API is unavailable');
    return json(decodeText(bytes));
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAnousithNumber(raw);
    const requests = anousithRequests(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      // An unknown bill is answered by the first request alone.
      const item = anousithItem(await this.post(requests.items, signal, timeoutMs), number);
      const scans = anousithScans(await this.post(requests.scans, signal, Math.max(1, deadline - Date.now())), number);
      return parseAnousith(item, scans, number);
    };
    // A request that fails to reach Anousith, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'anousith', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AnousithTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'anousith', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAnousithNumber(number))),
  };
};
