import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { arasWaybillFrame, normalizeArasNumber, parseAras, parseArasLookup, PROVIDER } from './parser.js';

const ORIGIN = 'https://kargotakip.araskargo.com.tr';
// Each page is under 30 kB; a long history adds a few hundred bytes a row.
const MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
const COOKIE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]{1,64})=([\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{0,1024})$/;
const MAX_COOKIES = 16;

/** The legacy tracker's link for one parcel, the one merchants send. */
export function arasTrackingUrl(raw: string): string {
  return `${ORIGIN}/mainpage.aspx?${new URLSearchParams({ code: normalizeArasNumber(raw) })}`;
}

/** Keeps each cookie the tracker sets, by name, as a browser would send it back. */
function keepCookies(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const match = COOKIE.exec(header.split(';', 1)[0]!.trim());
    if (match) jar.set(match[1]!, match[2]!);
  }
  if (jar.size > MAX_COOKIES) throw new SchemaError(PROVIDER, 'Aras Kargo set too many cookies');
}

/** Whether a reply sends the browser on to this page of the tracker. */
function redirectsTo(response: Response, page: string): boolean {
  if (!REDIRECTS.includes(response.status)) return false;
  const location = response.headers.get('location');
  if (!location || location.length > 200) return false;
  try {
    const url = new URL(location, ORIGIN);
    return url.origin === ORIGIN && url.pathname.toLowerCase() === page && !url.search && !url.hash && !url.username;
  } catch {
    return false;
  }
}

export class ArasKargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeArasNumber(raw);
    // The tracker keeps the parcel in a session: the lookup page finds it and
    // redirects to the tracking page, whose frames read it from the session.
    // The load balancer's cookie keeps every request on the server that holds it.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const jar = new Map<string, string>();
      const get = async (path: string) => {
        const headers: Record<string, string> = {
          'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html', 'Accept-Language': 'tr-TR,tr;q=0.9',
        };
        if (jar.size) headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
        const { response, bytes } = await fetchBounded(`${ORIGIN}/${path}`, { signal, headers }, {
          provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: MAX_BYTES,
          redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher,
        });
        keepCookies(jar, response);
        return { response, html: () => decodeText(bytes) };
      };

      const lookup = await get(`mainpage.aspx?${new URLSearchParams({ code: number })}`);
      if (lookup.response.status === 200) parseArasLookup(lookup.html(), number);
      if (!redirectsTo(lookup.response, '/kargotakip.aspx')) throw new IndeterminateError(PROVIDER, 'Aras Kargo tracker moved');
      if (!jar.has('ASP.NET_SessionId')) throw new IndeterminateError(PROVIDER, 'Aras Kargo did not open a session');
      const tracker = await get('kargotakip.aspx');
      // Without the shipment in its session, the tracking page sends the browser back to the lookup.
      if (tracker.response.status !== 200) throw new IndeterminateError(PROVIDER, 'Aras Kargo tracking page is unavailable');
      const summary = await get(arasWaybillFrame(tracker.html()));
      if (summary.response.status !== 200) throw new IndeterminateError(PROVIDER, 'Aras Kargo shipment summary is unavailable');
      // The movements frame reads the shipment the summary frame put in the session.
      const movements = await get('CargoInfoTransactionAndRedirection.aspx');
      if (movements.response.status !== 200) throw new IndeterminateError(PROVIDER, 'Aras Kargo shipment movements are unavailable');
      return parseAras(summary.html(), movements.html(), number);
    };
    // A lookup that fails to reach Aras, or hangs, starts again in a new
    // session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'aras-kargo', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ArasKargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'aras-kargo', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeArasNumber(number))),
  };
};
