import { createHash } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MEEST_MAX_BYTES, normalizeMeestNumber, parseMeest, PROVIDER } from './parser.js';

/** The tracker Meest's sites frame. Its page carries the salt every lookup is signed with. */
export const MEEST_PAGE = 'https://t.meest-group.com/n/';
/** The lookup the page's script sends. */
export const MEEST_LOOKUP = 'https://t.meest-group.com/get.php';
const PAGE_MAX_BYTES = 1_000_000;
/** The page's salt changes from day to day; reuse it for less. */
const SALT_REUSE_MS = 60 * 60_000;
const DEFAULT_BUDGET_MS = 15_000;
// An edge block page instead of the tracker's page or XML.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied)|_cf_chl_opt|cf-turnstile|captcha/i;

/** The lookup refused a salt this tracker had kept: a fresh page brings the current one. */
class MeestSaltExpiredError extends IndeterminateError {
  constructor() {
    super(PROVIDER, "Meest refused an expired lookup salt");
    this.name = 'MeestSaltExpiredError';
  }
}

/** The salt in the page's script, the same for every visitor until Meest changes it. */
export function meestPageSalt(html: string): string {
  const salt = /\bvar\s+salt\s*=\s*'([0-9a-f]{32})'/.exec(html)?.[1];
  if (salt) return salt;
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'Meest refused its tracking page');
  throw new SchemaError(PROVIDER, 'Meest changed its tracking page');
}

/**
 * The lookup for one number as the page's script sends it, signed with the MD5
 * of the salt, the number and the salt again. The server refuses any other
 * check. Without the page's `test` flag the rows come with older wording.
 */
export function meestLookupUrl(number: string, salt: string): string {
  const chk = createHash('md5').update(`${salt}${number}${salt}`).digest('hex');
  return `${MEEST_LOOKUP}?what=tracking&test&number=${encodeURIComponent(number)}&lang=uk&ext_track=&chk=${chk}`;
}

export class MeestTracker {
  private salt?: { value: string; until: number };

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMeestNumber(raw);
    return runSteps({ carrier: 'meest', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: step => this.lookup(number, step, false) },
      { id: 'refresh', recovers: error => error instanceof MeestSaltExpiredError, run: step => this.lookup(number, step, true) },
    ]);
  }

  private async lookup(number: string, step: StepContext, refresh: boolean): Promise<CarrierResult> {
    const started = performance.now();
    const timeoutMs = () => Math.max(1, Math.floor(step.remainingMs - (performance.now() - started)));
    const userAgent = userAgentOf(this.options.userAgent);
    const kept = !refresh && this.salt && this.salt.until > Date.now() ? this.salt : undefined;
    let salt = kept?.value;
    if (!salt) {
      this.salt = undefined;
      const { response, bytes } = await fetchBounded(MEEST_PAGE, { signal: step.signal,
        headers: { Accept: 'text/html', 'User-Agent': userAgent } },
      { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: PAGE_MAX_BYTES, fetcher: this.options.fetcher,
        allowHttpStatuses: [404, 410], retryTransient: true });
      // A missing page is a moved tracker, not a missing parcel.
      if (!response.ok) throw new TransportError(PROVIDER, 'Meest tracking page is unavailable');
      salt = meestPageSalt(decodeText(bytes));
      this.salt = { value: salt, until: Date.now() + SALT_REUSE_MS };
    }
    // The page's script posts an empty form to the lookup.
    const { response, bytes } = await fetchBounded(meestLookupUrl(number, salt), { method: 'POST', signal: step.signal,
      headers: { Accept: 'application/xml, text/xml', 'User-Agent': userAgent } },
    { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: MEEST_MAX_BYTES, fetcher: this.options.fetcher,
      allowHttpStatuses: [400, 404, 410], retryTransient: true });
    // The lookup answers a check made with any other salt with an empty 400.
    if (response.status === 400) {
      if (this.salt?.value === salt) this.salt = undefined;
      if (kept) throw new MeestSaltExpiredError();
      throw new TransportError(PROVIDER, "Meest refused the check made with its own page's salt");
    }
    if (!response.ok) throw new TransportError(PROVIDER, 'Meest tracking lookup is unavailable');
    const xml = decodeText(bytes);
    if (!/^\s*<(?:\?xml|return\b)/.test(xml) && BLOCKED.test(xml.slice(0, 64_000))) {
      throw new ChallengeError(PROVIDER, 'Meest answered with a block page');
    }
    return parseMeest(xml, number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MeestTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'meest', recordsSteps: true, steps: ['direct', 'refresh'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMeestNumber(number))),
  };
};
