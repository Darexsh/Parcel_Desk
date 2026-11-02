import { request } from 'node:https';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import catalog from '../data/catalog.json' with { type: 'json' };
const contract = { 'x-carriers': catalog };
import { writeCanaryReport } from './canary-report.mjs';
import { DEFAULT_USER_AGENT } from '../core/transport/userAgent.js';
import type { CarrierId } from '../generated/catalog.js';

/**
 * Automatic carriers whose front door does not answer the runner's network,
 * and why. Each was seen answering other networks. The probe lists them in its
 * summary instead of probing them.
 */
export const unreachableFrontDoors: Partial<Record<CarrierId, string>> = {
  'aaa-cooper': 'www.aaacooper.com drops connections from outside the Americas and from the runner\'s network; other networks in the United States get its home page',
  'asyad-express': 'www.asyadexpress.om answers only Omani networks',
  azerpost: 'www.azerpost.az does not answer connections from the United States; European networks get its tracking page',
  'cargo-expreso': 'cargoexpreso.com does not answer connections from European and American networks; the Internet Archive reaches it',
  cupost: 'www.cupost.co.kr does not answer connections from European and American networks; the Internet Archive reaches it',
  flyking: 'www.flyking.in resets every HTTPS connection and serves its tracker over plain HTTP to Indian networks only',
  'iran-post': 'tracking.post.ir answers only Iranian networks',
  'kerry-tj': 'www.kerrytj.com answers only Taiwanese networks',
  'la-poste-tunisienne': 'www.poste.tn answers only Tunisian networks',
  slgtrax: 'sonic.pk drops connections from the runner\'s network and some others; European and other American networks get its tracking page',
};

function unreachableReason(carrierId: string): string | undefined {
  return (unreachableFrontDoors as Record<string, string | undefined>)[carrierId];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 2;
const MAX_CONCURRENCY = 6;
const DEFAULT_RECHECKS = 2;
// Longer than the one-minute DNS answers of the CDNs seen rotating their edges.
const DEFAULT_RECHECK_PAUSE_MS = 70_000;
const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'AggregateError', 'AbortError', 'TimeoutError',
  'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError', 'SocketError',
]);
const PROBE_HEADERS = {
  Accept: 'text/html,application/json;q=0.8,*/*;q=0.5',
  // A browser names a language. WanbExpress answers Node's default `*` with a 500.
  'Accept-Language': 'en',
  'User-Agent': DEFAULT_USER_AGENT,
};
// The server sends its own certificate and leaves the rest of the chain to the
// client. A browser fetches the missing certificate; Node does not.
const INCOMPLETE_CHAIN = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CanaryTarget {
  carrierId: string;
  displayName: string;
  url: string;
}

export interface CanaryResult {
  target: CanaryTarget;
  status: number | null;
  error?: string;
}

interface CanaryError {
  name: string;
  code?: string;
  syscall?: string;
  address?: string;
  port?: number;
  cause?: CanaryError;
  errors?: CanaryError[];
  truncated?: boolean;
}

interface CanaryAttempt {
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  durationMs: number;
  status: number | null;
  error?: CanaryError;
}

function canaryErrorDetails(error: unknown, seen = new Set<object>()): CanaryError {
  if (!isRecord(error)) return { name: typeof error };
  if (seen.has(error) || seen.size >= 8) return { name: 'Error', truncated: true };
  seen.add(error);
  const details: CanaryError = {
    name: typeof error.name === 'string' && ERROR_NAMES.has(error.name) ? error.name : 'Error',
  };
  // Copy only bounded diagnostic fields. Messages, stacks and arbitrary properties
  // can contain full URLs, credentials or response content.
  if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) {
    details.code = error.code;
  }
  if (typeof error.syscall === 'string' && /^[a-z][a-z0-9]{0,31}$/.test(error.syscall)) {
    details.syscall = error.syscall;
  }
  if (typeof error.address === 'string' && isIP(error.address)) details.address = error.address;
  if (typeof error.port === 'number' && Number.isInteger(error.port) && error.port > 0 && error.port <= 65535) {
    details.port = error.port;
  }
  if (error.cause !== undefined) details.cause = canaryErrorDetails(error.cause, seen);
  // Node may wrap the connection failures for several resolved IPs in AggregateError.
  if (Array.isArray(error.errors)) {
    details.errors = error.errors.slice(0, 8).map((item) => canaryErrorDetails(item, seen));
    if (error.errors.length > 8) details.truncated = true;
  }
  return details;
}

export function canaryHealthy(result: CanaryResult): boolean {
  // A challenge or redirect still proves the front door answers. A missing
  // page means the canary URL, and usually the lookup behind it, has moved.
  return result.status !== null && result.status < 500 && result.status !== 404 && result.status !== 410;
}

export function automaticCanaryTargets(
  definitions: unknown = contract['x-carriers'],
): CanaryTarget[] {
  if (!isRecord(definitions)) throw new TypeError('Carrier definitions must be an object');
  const targets: CanaryTarget[] = [];
  for (const [carrierId, value] of Object.entries(definitions)) {
    if (!isRecord(value) || !isRecord(value.tracking) || value.tracking.mode !== 'automatic') {
      continue;
    }
    if (typeof value.displayName !== 'string' || typeof value.canaryUrl !== 'string') {
      throw new TypeError(`Automatic carrier ${carrierId} has no canary metadata`);
    }
    let url: URL;
    try {
      url = new URL(value.canaryUrl);
    } catch (error) {
      throw new TypeError(`Automatic carrier ${carrierId} has an unsafe canary URL`, { cause: error });
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new TypeError(`Automatic carrier ${carrierId} has an unsafe canary URL`);
    }
    targets.push({ carrierId, displayName: value.displayName, url: url.toString() });
  }
  return targets;
}

/** A reply a browser reads and Node refuses: an incomplete certificate chain or a malformed header. */
function refusedByNodeOnly(error: unknown): boolean {
  const cause = isRecord(error) ? error.cause : undefined;
  return isRecord(cause) && (cause.code === INCOMPLETE_CHAIN || cause.name === 'HTTPParserError');
}

/**
 * Reads the status of a front door whose reply only Node refuses. The probe
 * sends no secret and reads no body, so it can skip the chain check and parse
 * headers loosely; any other certificate fault still fails.
 */
function requestLenientCanaryStatus(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const lookup = request(url, {
      headers: PROBE_HEADERS,
      rejectUnauthorized: false,
      insecureHTTPParser: true,
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      // Node sets the verification error's code here, not an Error.
      const fault: unknown = (response.socket as { authorizationError?: unknown }).authorizationError;
      const status = response.statusCode;
      response.destroy();
      if (status === undefined || (fault && fault !== INCOMPLETE_CHAIN)) {
        reject(Object.assign(new Error('Unreadable front door'), { code: fault }));
      } else {
        resolve(status);
      }
    });
    lookup.on('error', reject);
    lookup.end();
  });
}

export async function requestCanaryStatus(url: string, timeoutMs: number): Promise<number> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: PROBE_HEADERS,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (!refusedByNodeOnly(error)) throw error;
    return requestLenientCanaryStatus(url, timeoutMs);
  }
  try {
    await response.body?.cancel();
  } catch {
    // The HTTP status is sufficient even if the probe body cannot be cancelled.
  }
  return response.status;
}

export async function probeCanaryTarget(
  target: CanaryTarget,
  options: {
    timeoutMs?: number;
    attempts?: number;
    fetchStatus?: (url: string, timeoutMs: number) => Promise<number>;
    onAttempt?: (target: CanaryTarget, result: CanaryAttempt) => void;
  } = {},
): Promise<CanaryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const fetchStatus = options.fetchStatus ?? requestCanaryStatus;
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('Canary attempts must be positive');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Canary timeout must be positive');
  let status: number | null = null;
  let error: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const started = performance.now();
    let errorDetails: CanaryError | undefined;
    try {
      status = await fetchStatus(target.url, timeoutMs);
      error = undefined;
    } catch (caught) {
      status = null;
      errorDetails = canaryErrorDetails(caught);
      error = errorDetails.name;
    }
    options.onAttempt?.(target, {
      attempt: attempt + 1,
      maxAttempts: attempts,
      timeoutMs,
      durationMs: Math.round(performance.now() - started),
      status,
      ...(errorDetails ? { error: errorDetails } : {}),
    });
    if (status !== null && status < 500) break;
  }
  return { target, status, ...(error ? { error } : {}) };
}

export async function runCanaries(
  targets: CanaryTarget[],
  options: Parameters<typeof probeCanaryTarget>[1] = {},
): Promise<CanaryResult[]> {
  const results = new Array<CanaryResult>(targets.length);
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await probeCanaryTarget(targets[index]!, options);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, targets.length) }, runWorker),
  );
  return results;
}

/**
 * Probes each target that got no HTTP answer again after a pause, for up to
 * `rechecks` rounds. A front door on rotating DNS can hand out an edge this
 * network cannot reach (YTO's CDN does), and an immediate retry meets the
 * same address.
 */
export async function recheckUnanswered(
  results: CanaryResult[],
  options: NonNullable<Parameters<typeof probeCanaryTarget>[1]> & { rechecks?: number; pauseMs?: number } = {},
): Promise<CanaryResult[]> {
  const { rechecks = DEFAULT_RECHECKS, pauseMs = DEFAULT_RECHECK_PAUSE_MS, ...probe } = options;
  let current = results;
  for (let round = 0; round < rechecks; round += 1) {
    const unanswered = current.filter((result) => result.status === null).map((result) => result.target);
    if (!unanswered.length) break;
    await new Promise((resolve) => { setTimeout(resolve, pauseMs); });
    const rechecked = await runCanaries(unanswered, { ...probe, attempts: 1 });
    current = current.map((result) => rechecked.find((again) => again.target === result.target) ?? result);
  }
  return current;
}

function optionValue(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

export async function carrierCanaryMain(argv = process.argv.slice(2)): Promise<number> {
  const timeoutMs = optionValue(argv, '--timeout', DEFAULT_TIMEOUT_MS / 1_000) * 1_000;
  const attempts = optionValue(argv, '--attempts', DEFAULT_ATTEMPTS);
  const pauseMs = optionValue(argv, '--recheck-pause', DEFAULT_RECHECK_PAUSE_MS / 1_000) * 1_000;
  console.log(`CANARY ${JSON.stringify({
    node: process.version,
    undici: process.versions.undici,
    platform: process.platform,
    arch: process.arch,
    timeoutMs,
    attempts,
    concurrency: MAX_CONCURRENCY,
  })}`);
  // Many carriers share a front door (every universal one uses the same
  // provider page), so each URL is probed once and reported for all of them.
  // A front door this network cannot reach is listed, not probed.
  const targets = automaticCanaryTargets();
  const unreachable = targets.filter((target) => unreachableReason(target.carrierId));
  const probed = targets.filter((target) => !unreachableReason(target.carrierId));
  const carriersByUrl = new Map<string, string[]>();
  for (const target of probed) carriersByUrl.set(target.url, [...carriersByUrl.get(target.url) ?? [], target.carrierId]);
  const options = {
    timeoutMs,
    attempts,
    onAttempt: (target: CanaryTarget, result: CanaryAttempt) => {
      console.log(`ATTEMPT ${target.carrierId} ${new URL(target.url).hostname} ${JSON.stringify(result)}`);
    },
  };
  const results = await recheckUnanswered(
    await runCanaries(probed.filter((target) => carriersByUrl.get(target.url)![0] === target.carrierId), options),
    { ...options, pauseMs },
  );
  const rows: { result: 'failed' | 'unverified'; check: string; reason: string }[] = [];
  for (const result of results) {
    const carriers = carriersByUrl.get(result.target.url)!.join(',');
    const hostname = new URL(result.target.url).hostname;
    const outcome = result.status !== null ? `HTTP ${result.status}` : result.error ?? 'unreachable';
    console.log(`${canaryHealthy(result) ? 'PASS' : 'FAIL'} ${carriers} ${hostname} ${outcome}`);
    if (!canaryHealthy(result)) rows.push({ result: 'failed', check: `${carriers} (${hostname})`, reason: outcome });
  }
  const healthy = results.length - rows.length;
  for (const target of unreachable) {
    const hostname = new URL(target.url).hostname;
    const reason = `Not probed: ${unreachableReason(target.carrierId)!}`;
    console.log(`SKIP ${target.carrierId} ${hostname} ${reason}`);
    rows.push({ result: 'unverified', check: `${target.carrierId} (${hostname})`, reason });
  }
  const totals = `${healthy}/${results.length} canary URLs reachable for ${probed.length} automatic carriers; `
    + `${unreachable.length} not probed from this network`;
  console.log(totals);
  writeCanaryReport({ title: 'Public carrier reachability', totals, rows });
  return healthy === results.length ? 0 : 1;
}

const executable = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === executable) {
  process.exitCode = await carrierCanaryMain();
}
