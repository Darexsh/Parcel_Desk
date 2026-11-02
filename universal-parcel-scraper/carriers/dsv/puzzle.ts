import { createHash } from 'node:crypto';
import { BudgetExceededError, ChallengeError, IndeterminateError } from '../../core/errors/index.js';
import { isRecord } from '../../core/types.js';

const MAX_PUZZLES = 8;
// The tracker's puzzles take about 6,600 hashes each. One that asks for a
// thousand times more is not one a lookup can afford.
const MAX_EXPECTED_HASHES = 2 ** 23;
// Past this many times its expected work, a search would be a broken puzzle.
const MAX_WORK_FACTOR = 64;
const YIELD_EVERY = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface DsvPuzzle {
  /** The signed token the server checks the solution against. */
  readonly jwt: string;
  readonly seed: Buffer;
  /** The bound a hash must stay under, as 32 little-endian bytes. */
  readonly target: Buffer;
  readonly expectedHashes: number;
}

function invalid(provider: string): ChallengeError {
  return new ChallengeError(provider, `${provider} sent a proof-of-work puzzle the adapter cannot read`);
}

/**
 * The `Captcha-Puzzle` header: base64 of comma-separated signed tokens. Each
 * token's `puzzle` is 64 bytes. The first 32 are the seed; bytes 13 and 14
 * are the difficulty's exponent and mantissa, so a hash must stay under
 * mantissa × 256^(exponent − 3), read little-endian.
 */
export function parseDsvPuzzles(header: string, provider: string): DsvPuzzle[] {
  const tokens = Buffer.from(header.trim(), 'base64').toString('latin1').split(',');
  if (!tokens.length || tokens.length > MAX_PUZZLES) throw invalid(provider);
  return tokens.map((jwt) => {
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts.every(part => BASE64URL.test(part)) || jwt.length > 2000) throw invalid(provider);
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')); }
    catch { throw invalid(provider); }
    if (!isRecord(payload) || typeof payload.puzzle !== 'string') throw invalid(provider);
    const puzzle = Buffer.from(payload.puzzle, 'base64');
    if (puzzle.length !== 64) throw invalid(provider);
    const exponent = puzzle.readInt8(13);
    const mantissa = puzzle.readInt8(14);
    // The bound fits in 256 bits and leaves at least one hash to try.
    if (mantissa < 1 || exponent < 3 || exponent > 34) throw invalid(provider);
    const target = Buffer.alloc(32);
    target[exponent - 3] = mantissa;
    const expectedHashes = 2 ** (256 - 8 * (exponent - 3)) / mantissa;
    if (expectedHashes > MAX_EXPECTED_HASHES) {
      throw new IndeterminateError(provider, `${provider} asked for more proof of work than a lookup can spend`, { reason: 'costly_puzzle' });
    }
    return { jwt, seed: puzzle.subarray(0, 32), target, expectedHashes };
  });
}

/** Whether a hash, read as a little-endian number, is under the target. */
function under(hash: Buffer, target: Buffer): boolean {
  for (let index = 31; index >= 0; index -= 1) {
    if (hash[index] !== target[index]) return hash[index]! < target[index]!;
  }
  return false;
}

/**
 * The nonce for each puzzle: eight little-endian bytes that, after the seed,
 * give a double SHA-256 under the target. The answer is the `Captcha-Solution`
 * header, base64 of the tokens with their nonces.
 */
export async function solveDsvPuzzles(puzzles: readonly DsvPuzzle[], signal: AbortSignal, deadline: number,
  budgetMs: number, provider: string): Promise<string> {
  const solutions: { jwt: string; solution: string }[] = [];
  const input = Buffer.alloc(40);
  for (const puzzle of puzzles) {
    puzzle.seed.copy(input, 0);
    const limit = Math.ceil(puzzle.expectedHashes * MAX_WORK_FACTOR);
    let found = false;
    for (let nonce = 0; nonce < limit; nonce += 1) {
      input.writeUInt32LE(nonce % 2 ** 32, 32);
      input.writeUInt32LE(Math.floor(nonce / 2 ** 32), 36);
      const hash = createHash('sha256').update(createHash('sha256').update(input).digest()).digest();
      if (under(hash, puzzle.target)) {
        solutions.push({ jwt: puzzle.jwt, solution: input.subarray(32).toString('base64') });
        found = true;
        break;
      }
      if (nonce % YIELD_EVERY === YIELD_EVERY - 1) {
        // Let cancellation and deadline timers run during the search. The
        // lookup's own timer ending it is the budget running out.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const reason: unknown = signal.reason;
        if (performance.now() >= deadline || (reason instanceof DOMException && reason.name === 'TimeoutError')) {
          throw new BudgetExceededError(provider, budgetMs);
        }
        signal.throwIfAborted();
      }
    }
    if (!found) throw invalid(provider);
  }
  return Buffer.from(JSON.stringify(solutions)).toString('base64');
}
