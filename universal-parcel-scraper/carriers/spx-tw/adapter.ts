import { createHash } from 'node:crypto';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { normalizeSpxTwNumber, parseSpxTw, PROVIDER, SPX_TW_MAX_BYTES } from './parser.js';

/** The legacy feed the tracker on spx.tw reads for the number in its address. */
export const SPX_TW_API = 'https://spx.tw/api/v2/fleet_order/tracking/search';
// Public checksum configuration of SPX's tracking clients, the same as the
// Philippine tracker's; it is not a session credential.
const CHECKSUM_SALT = 'MGViZmZmZTYzZDJhNDgxY2Y1N2ZlN2Q1ZWJkYzlmZDY=';
// Shopee's gateway refuses this feed to a client without a browser's User-Agent.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The feed's query: the number, the time in seconds and its checksum. */
export function spxTwQuery(number: string, seconds: number): string {
  const checksum = createHash('sha256').update(`${number}${seconds}${CHECKSUM_SALT}`).digest('hex');
  return `${number}|${seconds}${checksum}`;
}

/** The reply as JSON; a web page in its place is a gateway's check, anything else a changed reply. */
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (/^\s*</.test(body)) throw new ChallengeError(PROVIDER, 'SPX Express Taiwan answered with a web page instead of its tracking reply', { cause });
    throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned a reply that is not JSON', { cause });
  }
}

export class SpxTwTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpxTwNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const query = spxTwQuery(number, Math.floor(Date.now() / 1000));
      const url = `${SPX_TW_API}?${new URLSearchParams({ sls_tracking_number: query })}`;
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': BROWSER_USER_AGENT,
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SPX_TW_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The feed answers every lookup with 200; a 404 or a redirect is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'SPX Express Taiwan tracking feed is unavailable', { status: response.status });
      return parseSpxTw(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'spx-tw', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpxTwTracker({ fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'spx-tw', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
