import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { ECONT_MAX_BYTES, normalizeEcontNumber, parseEcont, PROVIDER } from './parser.js';

// The tracker on www.econt.com/services/track-shipment/ is a frame that opens a
// guest session with this implicit grant, then posts the number to the trace service.
const REDIRECT_URI = 'https://www.econt.com/trace/oauth/process-token.html';
export const ECONT_AUTHORIZE_URL = `https://www.econt.com/ms-oauth/oauth/authorize?${new URLSearchParams({
  response_type: 'token', client_id: 'prod_trace_page', redirect_uri: REDIRECT_URI })}`;
export const ECONT_TRACE_URL = 'https://www.econt.com/ms-trace/api/trace/waybill';

// Guest tokens last an hour; one is renewed this long before it ends.
const RENEW_MS = 60_000;
const MAX_LIFETIME_S = 86_400;

class EcontSessionExpiredError extends CarrierError {
  constructor() {
    super('indeterminate', PROVIDER, 'Econt guest session was rejected');
    this.name = 'EcontSessionExpiredError';
  }
}

/** The firewall in front of www.econt.com rejects a request with an HTML page. */
function rejected(bytes: Uint8Array): boolean {
  return /Request Rejected|The requested URL was rejected/i.test(decodeText(bytes.subarray(0, 4_000)));
}

interface Session { token: string; expiresAt: number }

export class EcontTracker {
  private session?: Session;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEcontNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Econt budget must be a positive number of milliseconds');
    return runSteps({ carrier: 'econt', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: step => this.lookup(number, step, false) },
      { id: 'refresh', recovers: error => error instanceof EcontSessionExpiredError, run: step => this.lookup(number, step, true) },
    ]);
  }

  private async lookup(number: string, { signal, remainingMs }: StepContext, renew: boolean): Promise<CarrierResult> {
    const deadline = performance.now() + remainingMs;
    const timeoutMs = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    if (renew || !this.session || this.session.expiresAt - RENEW_MS <= Date.now()) {
      this.session = undefined;
      this.session = await this.openSession(userAgent, signal, timeoutMs());
    }
    const session = this.session;
    signal.throwIfAborted();
    let bytes: Uint8Array;
    try {
      ({ bytes } = await fetchBounded(ECONT_TRACE_URL, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}`, 'User-Agent': userAgent },
        // The page sends `external` for a tracking link and `internal` for its own form.
        body: JSON.stringify({ waybillNumber: [number], source: 'external' }) },
      { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: ECONT_MAX_BYTES, fetcher: this.options.fetcher }));
    } catch (error) {
      if (error instanceof UpstreamHttpError && error.status === 401) {
        if (this.session === session) this.session = undefined;
        throw new EcontSessionExpiredError();
      }
      // A missing route is not a missing shipment.
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
        throw new TransportError(PROVIDER, 'Econt tracking service is unavailable', { cause: error });
      }
      throw error;
    }
    let payload: unknown;
    try { payload = parseJsonBytes(bytes, PROVIDER); }
    catch (cause) {
      if (rejected(bytes)) throw new ChallengeError(PROVIDER, 'Econt rejected the tracking request', { cause });
      throw new SchemaError(PROVIDER, 'Econt returned invalid tracking JSON', { cause });
    }
    return parseEcont(payload, number);
  }

  /** The guest token the authorization server puts in the redirect's fragment, without a login. */
  private async openSession(userAgent: string, signal: AbortSignal, timeoutMs: number): Promise<Session> {
    signal.throwIfAborted();
    const { response, bytes } = await fetchBounded(ECONT_AUTHORIZE_URL, { signal, headers: { 'User-Agent': userAgent } },
      { provider: PROVIDER, timeoutMs, maxBytes: 64_000, redirect: 'manual', allowHttpStatuses: [302, 303], fetcher: this.options.fetcher });
    const location = response.headers.get('location') ?? '';
    const [target, fragment = ''] = location.split('#', 2);
    const grant = new URLSearchParams(fragment);
    const token = grant.get('access_token') ?? '';
    const lifetime = Number(grant.get('expires_in'));
    if (![302, 303].includes(response.status) || target !== REDIRECT_URI || !/^[\w.~+/=-]{8,4096}$/.test(token)
      || grant.get('token_type')?.toLowerCase() !== 'bearer') {
      if (rejected(bytes)) throw new ChallengeError(PROVIDER, 'Econt rejected the guest session request');
      throw new SchemaError(PROVIDER, 'Econt did not open a guest tracking session');
    }
    const seconds = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, MAX_LIFETIME_S) : 0;
    return { token, expiresAt: Date.now() + seconds * 1000 };
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new EcontTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'econt', recordsSteps: true, steps: ['direct', 'refresh'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEcontNumber(number))) };
};
