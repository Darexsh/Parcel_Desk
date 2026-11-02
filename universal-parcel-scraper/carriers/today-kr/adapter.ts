import { createDecipheriv, createHash } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTodayNumber, parseToday, PROVIDER, TODAY_MAX_BYTES, todayPage } from './parser.js';

/** The tracking page, whose server looks the number up and puts the answer in the page. */
export const TODAY_PAGE = 'https://my.amazing.today/track/';
/** The passphrase the page's own script opens that answer with; every visitor's browser gets it. */
export const TODAY_PASSPHRASE = 'c40d20b89913fd947dc12dd54f5e700fa1f1d2f807f55e231bf8af6272e28bb0'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Vercel's bot checkpoint, or a CDN's, in place of the page.
const CHALLENGE = /Vercel Security Checkpoint|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;
const SALTED = Buffer.from('Salted__');

/** The key and IV OpenSSL's `EVP_BytesToKey` derives from a passphrase with MD5, as CryptoJS does. */
function derive(passphrase: string, salt: Uint8Array): { key: Buffer; iv: Buffer } {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (blocks.length < 3) {
    previous = createHash('md5').update(Buffer.concat([previous, Buffer.from(passphrase, 'utf8'), salt])).digest();
    blocks.push(previous);
  }
  const material = Buffer.concat(blocks);
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

/** The JSON a `CryptoJS.AES.encrypt` text holds; one that does not open is a changed page. */
export function todayOpen(sealed: string, passphrase = TODAY_PASSPHRASE): unknown {
  const bytes = Buffer.from(sealed, 'base64');
  try {
    if (bytes.length < 32 || !bytes.subarray(0, 8).equals(SALTED)) throw new Error('No CryptoJS salt');
    const { key, iv } = derive(passphrase, bytes.subarray(8, 16));
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'));
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'To-Day returned a lookup that does not open', { cause });
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

export class TodayTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTodayNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${TODAY_PAGE}${number}`, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TODAY_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 429] });
      if (response.headers.get('x-vercel-mitigated') === 'challenge') throw new ChallengeError(PROVIDER, 'To-Day answered with a browser check');
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'To-Day redirected its tracking page');
      // The page answers an unknown number itself: a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'To-Day tracking page is unavailable');
      const html = decodeText(bytes);
      const page = response.status === 200 ? todayPage(html) : null;
      if (!page) {
        if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'To-Day answered with a browser check');
        if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response));
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'To-Day refused the lookup', { status: 403 });
        throw new SchemaError(PROVIDER, 'To-Day returned a page without its lookup');
      }
      return parseToday(page.type, todayOpen(page.sealed), number);
    };
    return runSteps({ carrier: 'today-kr', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TodayTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'today-kr', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTodayNumber(number))),
  };
};
