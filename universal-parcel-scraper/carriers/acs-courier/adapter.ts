import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { ACS_MAX_BYTES, normalizeAcsNumber, parseAcs, PROVIDER } from './parser.js';

/** The Cypriot site's English tracker. Its page carries the key the API wants. */
export const ACS_PAGE = 'https://cyp.acscourier.net/en/quick-access/non-registered-users/track-and-trace/';
export const ACS_SEARCH = 'https://api.acscourier.net/api/parcels/search/';
const ORIGIN = 'https://cyp.acscourier.net';
const PAGE_MAX_BYTES = 1_000_000;
/** The page's key has lived about six minutes; reuse it for less. */
const KEY_REUSE_MS = 4 * 60_000;
const DEFAULT_BUDGET_MS = 15_000;

/** The API refused a key this tracker had kept: a fresh page brings a new one. */
class AcsKeyExpiredError extends IndeterminateError {
  constructor() {
    super(PROVIDER, 'ACS Courier refused an expired tracking key');
    this.name = 'AcsKeyExpiredError';
  }
}

/** The key in the tracker's mount point, the `publicToken` the page's script sends as `X-Encrypted-Key`. */
export function acsPageKey(html: string): string {
  const mount = /<div\b[^>]*\bid="app-root"[^>]*>/i.exec(html)?.[0];
  const key = mount && /\bpublicToken="([A-Za-z0-9_-]{40,1000})"/.exec(mount)?.[1];
  if (key) return key;
  if (/<title>\s*Access Denied|errors\.edgesuite\.net/i.test(html)) {
    throw new ChallengeError(PROVIDER, 'ACS Courier refused the tracking page');
  }
  throw new SchemaError(PROVIDER, 'ACS Courier changed its tracking page');
}

export class AcsCourierTracker {
  private key?: { value: string; until: number };

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeAcsNumber(raw);
    return runSteps({ carrier: 'acs-courier', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: step => this.lookup(number, step, false) },
      { id: 'refresh', recovers: error => error instanceof AcsKeyExpiredError, run: step => this.lookup(number, step, true) },
    ]);
  }

  private async lookup(number: string, step: StepContext, refresh: boolean) {
    const started = performance.now();
    const timeoutMs = () => Math.max(1, Math.floor(step.remainingMs - (performance.now() - started)));
    const kept = !refresh && this.key && this.key.until > Date.now() ? this.key : undefined;
    let key = kept?.value;
    if (!key) {
      this.key = undefined;
      const { response, bytes } = await fetchBounded(ACS_PAGE, { signal: step.signal,
        headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: PAGE_MAX_BYTES, fetcher: this.options.fetcher,
        allowHttpStatuses: [404, 410], retryTransient: true });
      // A missing page is a moved tracker, not a missing parcel.
      if (!response.ok) throw new TransportError(PROVIDER, 'ACS Courier tracking page is unavailable');
      key = acsPageKey(decodeText(bytes));
      this.key = { value: key, until: Date.now() + KEY_REUSE_MS };
    }
    const { response, bytes } = await fetchBounded(`${ACS_SEARCH}${number}`, { signal: step.signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent), Origin: ORIGIN,
      'X-Encrypted-Key': key,
      // The Cypriot site's country header brings every scan; the Greek one, five milestones.
      'X-Country': 'CY', 'Accept-Language': 'en-US',
    } }, { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: ACS_MAX_BYTES, fetcher: this.options.fetcher,
      allowHttpStatuses: [404, 406], retryTransient: true });
    if (response.status === 406) {
      if (this.key?.value === key) this.key = undefined;
      if (kept) throw new AcsKeyExpiredError();
      throw new TransportError(PROVIDER, 'ACS Courier refused the key on its own tracking page');
    }
    // The API answers a request without the site's origin with 404; an unknown parcel is a 200.
    if (response.status === 404) throw new TransportError(PROVIDER, 'ACS Courier refused the tracking request');
    let payload: unknown;
    try { payload = parseJsonBytes(bytes, PROVIDER); }
    catch (cause) {
      if (/<title>\s*Access Denied|errors\.edgesuite\.net/i.test(decodeText(bytes.subarray(0, 64_000)))) {
        throw new ChallengeError(PROVIDER, 'ACS Courier refused the tracking request', { cause });
      }
      throw new SchemaError(PROVIDER, 'ACS Courier returned invalid tracking JSON', { cause });
    }
    return parseAcs(payload, number);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AcsCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'acs-courier', recordsSteps: true, steps: ['direct', 'refresh'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAcsNumber(number))) };
};
