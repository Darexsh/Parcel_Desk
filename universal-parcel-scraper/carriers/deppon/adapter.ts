import { createCipheriv } from 'node:crypto';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { depponPuzzleOffset } from './challenge.js';
import { depponFailure, DEPPON_MAX_BYTES, normalizeDepponNumber, parseDeppon, PROVIDER } from './parser.js';

export { normalizeDepponNumber, parseDeppon } from './parser.js';

const ORIGIN = 'https://www.deppon.com';
const CHALLENGE = '/gwapi/messageService/eco/message/captcha/';
export const DEPPON_TRACKING_API = `${ORIGIN}/gwapi/trackService/eco/track/queryNewTrack`;
type Puzzle = { originalImageBase64: string; jigsawImageBase64: string };
type Solver = (puzzle: Puzzle, signal: AbortSignal) => Promise<number | null>;

async function solvePuzzle(puzzle: Puzzle, signal: AbortSignal): Promise<number | null> {
  signal.throwIfAborted();
  const sharp = (await import('sharp')).default;
  const images = await Promise.all([puzzle.originalImageBase64, puzzle.jigsawImageBase64].map(async image => {
    const bytes = Buffer.from(image, 'base64');
    if (bytes.length > 250_000) throw new SchemaError(PROVIDER, 'Deppon returned an oversized puzzle image');
    const decoder = sharp(bytes, { limitInputPixels: 310 * 155, pages: 1, failOn: 'warning' });
    const metadata = await decoder.metadata();
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) throw new ChallengeError(PROVIDER, 'Deppon changed its slider images');
    const { data, info } = await decoder.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    signal.throwIfAborted();
    return { data, width: info.width, height: info.height };
  }));
  return depponPuzzleOffset(images[0]!, images[1]!);
}

/** The public client's AES-ECB/PKCS7 envelope, using this challenge's ephemeral key. */
function encrypt(value: string, key: string): string {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
}

export class DepponTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDepponNumber(raw);
    return runSteps({ carrier: 'deppon', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted();
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const post = async (url: string, body: unknown): Promise<unknown> => {
        const { bytes } = await fetchBounded(url, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
            Origin: ORIGIN, Referer: `${ORIGIN}/orderTrack`, 'User-Agent': userAgentOf(this.options.userAgent) }, body: JSON.stringify(body) },
        { provider: PROVIDER, timeoutMs: left(), maxBytes: DEPPON_MAX_BYTES, fetcher });
        left();
        if (/^\s*</.test(decodeText(bytes))) throw new ChallengeError(PROVIDER, 'Deppon returned a verification page');
        try { return parseJsonBytes(bytes, PROVIDER); }
        catch { throw new SchemaError(PROVIDER, 'Deppon returned unreadable tracking JSON'); }
      };
      try {
        const opened = await post(`${ORIGIN}${CHALLENGE}getCaptchaAction`, { captchaType: 'blockPuzzle' });
        if (!isRecord(opened)) throw new SchemaError(PROVIDER, 'Deppon returned an invalid puzzle');
        if (opened.code !== '0000') depponFailure(opened);
        const puzzle = opened.result;
        if (!isRecord(puzzle) || typeof puzzle.secretKey !== 'string' || !/^[\x20-\x7e]{16}$/.test(puzzle.secretKey)
          || typeof puzzle.token !== 'string' || !/^[\w-]{16,128}$/.test(puzzle.token)
          || typeof puzzle.originalImageBase64 !== 'string' || typeof puzzle.jigsawImageBase64 !== 'string'
          || ![puzzle.originalImageBase64, puzzle.jigsawImageBase64].every(image => image.length <= 350_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(image))) {
          throw new SchemaError(PROVIDER, 'Deppon changed its puzzle envelope');
        }
        const offset = await (this.options.solveCaptcha ?? solvePuzzle)({ originalImageBase64: puzzle.originalImageBase64,
          jigsawImageBase64: puzzle.jigsawImageBase64 }, signal);
        left();
        if (offset === null || !Number.isInteger(offset) || offset < 30 || offset > 290) throw new ChallengeError(PROVIDER, 'Deppon slider could not be located confidently');
        const point = JSON.stringify({ x: offset, y: 5 });
        const verified = await post(`${ORIGIN}${CHALLENGE}checkCaptchaAction`, { captchaType: 'blockPuzzle',
          pointJson: encrypt(point, puzzle.secretKey), token: puzzle.token });
        if (!isRecord(verified)) throw new SchemaError(PROVIDER, 'Deppon returned an invalid verification reply');
        if (verified.code !== '0000') {
          const message = typeof verified.message === 'string' ? verified.message : '';
          if (/频繁|限流/.test(message)) depponFailure(verified);
          throw new ChallengeError(PROVIDER, 'Deppon rejected the slider verification');
        }
        const code = encrypt(`${puzzle.token}---${point}`, puzzle.secretKey);
        return parseDeppon(await post(DEPPON_TRACKING_API, { sysCode: 'ONLINE', waybillNumber: number, slaveType: '', code, value: code, checkBatch: '' }), number);
      } catch (error) {
        // Request diagnostics would contain the single-use verification material and session cookies.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DepponTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'deppon', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
