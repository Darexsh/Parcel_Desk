import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { convexValue, normalizeSendleNumber, parseSendle, parseSendleChallenge, PROVIDER, SENDLE_MAX_BYTES } from './parser.js';

/** The tracking page. */
export const SENDLE_PAGE = 'https://www.sendle.com/tracking';
/** The Convex deployment the tracking page's bundle calls. */
export const SENDLE_API = 'https://keen-orca-155.convex.cloud';
/** The mutation that hands out a proof-of-work challenge, and the action that looks a number up with its answer. */
export const SENDLE_CHALLENGE = 'tracking:createChallenge';
export const SENDLE_LOOKUP = 'tracking:lookupTracking';
const ORIGIN = 'https://www.sendle.com';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required/i;
// The page tries counters up to fifty million, in batches of 256.
const MAX_NONCES = 50_000_000;
// Sendle asks for fifteen bits, some 33,000 hashes: tens of milliseconds. Twenty bits
// is a million, about a second; a check that asks more costs more than a lookup spends.
const MAX_DIFFICULTY = 20;
// Hashes between turns of the event loop, a few milliseconds.
const BATCH = 4_096;

/** Whether a digest starts with `bits` zero bits, as the page checks it. */
export function sendleProofHolds(digest: Uint8Array, bits: number): boolean {
  let left = bits;
  for (const byte of digest) {
    if (left <= 0) return true;
    if (left < 8) return byte >> (8 - left) === 0;
    if (byte !== 0) return false;
    left -= 8;
  }
  return left <= 0;
}

/**
 * The page's answer to a challenge: the first counter, written in base 36,
 * whose SHA-256 of `salt:counter` starts with `difficulty` zero bits. The
 * search yields between batches and stops when the lookup's signal ends or the
 * attempt's deadline passes.
 */
export async function solveSendleChallenge(salt: string, difficulty: number, signal: AbortSignal, deadline: number): Promise<string> {
  if (difficulty > MAX_DIFFICULTY) throw new ChallengeError(PROVIDER, 'Sendle asked for a security check costlier than a lookup');
  for (let start = 0; start < MAX_NONCES; start += BATCH) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new IndeterminateError(PROVIDER, 'Sendle’s security check did not finish in time');
    for (let counter = start; counter < start + BATCH; counter += 1) {
      const nonce = counter.toString(36);
      if (sendleProofHolds(createHash('sha256').update(`${salt}:${nonce}`).digest(), difficulty)) return nonce;
    }
    await nextTurn();
  }
  throw new ChallengeError(PROVIDER, 'Sendle’s security check had no answer');
}

/** The reply's JSON. */
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Sendle answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Sendle returned a reply that is not JSON', { cause });
  }
}

export class SendleTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One call of a public Convex function over its HTTP API, as JSON. */
  private async call(kind: 'mutation' | 'action', path: string, args: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(`${SENDLE_API}/api/${kind}`, {
      method: 'POST', signal, body: JSON.stringify({ path, args, format: 'json' }), headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Origin: ORIGIN, Referer: `${ORIGIN}/`,
        'User-Agent': userAgentOf(this.options.userAgent),
      },
    }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SENDLE_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // The service answers every call with HTTP 200, its failures included; a redirect or a 404 is a moved route.
    if (!response.ok) throw new TransportError(PROVIDER, 'Sendle’s tracking service moved', { status: response.status });
    return convexValue(json(decodeText(bytes)));
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSendleNumber(raw);
    // A challenge serves one lookup, so a retry starts with a new one.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, deadline - performance.now());
      const challenge = parseSendleChallenge(await this.call('mutation', SENDLE_CHALLENGE, {}, signal, left()));
      const nonce = await solveSendleChallenge(challenge.salt, challenge.difficulty, signal, deadline);
      const reply = await this.call('action', SENDLE_LOOKUP, { reference: number, challengeId: challenge.challengeId, nonce }, signal, left());
      return parseSendle(reply, number);
    };
    // A read that fails to reach the service, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'sendle', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SendleTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sendle', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSendleNumber(number))),
  };
};
