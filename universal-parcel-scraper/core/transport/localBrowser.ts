/**
 * The one browser session a process runs. A carrier outage can send a whole
 * batch to the browser tier, so lookups take turns instead of each spawning a
 * browser: a lookup waits for the browser inside its own deadline and fails
 * with a budget error when that deadline passes first.
 */
import type { Browser } from 'playwright-core';
import { BudgetExceededError, carrierErrorKind, TransportError } from '../errors/index.js';
import { loadChromium } from './optional.js';

export interface LocalBrowserOptions {
  /** Named in errors and telemetry. */
  provider: string;
  executablePath: string;
  /** Covers the wait for the browser, its launch and the work done with it. */
  timeoutMs: number;
  signal?: AbortSignal;
  args?: readonly string[];
  /** An `http://` or `socks5://` host and port that carries all of the browser's traffic. */
  proxy?: string | null;
}

export interface LocalBrowserSession {
  browser: Browser;
  /** Aborts on the caller's signal or at the deadline. */
  signal: AbortSignal;
  /** Whole milliseconds left before the deadline, never below 1. */
  remainingMs: () => number;
}

/** Covers the rounding of the timeouts handed to Playwright and the granularity of timers. */
const DEADLINE_SLACK_MS = 5;

let tail: Promise<void> = Promise.resolve();

/** The configured proxy as Chromium's server setting; the message never repeats the value, which may hold credentials. */
function proxyServer(value: string): string {
  let url: URL | undefined;
  try { url = new URL(value.trim()); } catch { /* Reported below. */ }
  if (!url || !['http:', 'socks5:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new TypeError('Browser proxy must be an http:// or socks5:// host and port');
  }
  return `${url.protocol}//${url.host}`;
}

export async function withLocalBrowser<T>(options: LocalBrowserOptions, run: (session: LocalBrowserSession) => Promise<T>): Promise<T> {
  return withBrowser(options, run);
}

/** Connects to a private Playwright browser; closing the client disposes its contexts, not the service. */
export async function withRemoteBrowser<T>(options: Pick<LocalBrowserOptions, 'provider' | 'signal' | 'timeoutMs'> & { endpoint: string },
  run: (session: LocalBrowserSession) => Promise<T>): Promise<T> {
  let url: URL;
  try { url = new URL(options.endpoint); } catch { throw new TypeError('Browser endpoint must be a WebSocket URL'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new TypeError('Browser endpoint must be a WebSocket URL');
  }
  try { return await withBrowser({ provider: options.provider, timeoutMs: options.timeoutMs, signal: options.signal, executablePath: '' }, run, url.href); }
  catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (carrierErrorKind(error)) throw error;
    // Connection diagnostics can contain the endpoint's capability path.
    throw new TransportError(options.provider, `${options.provider} browser service is unavailable`);
  }
}

async function withBrowser<T>(options: LocalBrowserOptions, run: (session: LocalBrowserSession) => Promise<T>, endpoint?: string): Promise<T> {
  const { provider, timeoutMs } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError('Browser tracking timeout must be between 1 and 60000 ms');
  }
  const proxy = options.proxy ? proxyServer(options.proxy) : null;
  options.signal?.throwIfAborted();
  const deadline = performance.now() + timeoutMs;
  const expiry = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
  const signal = options.signal ? AbortSignal.any([options.signal, expiry]) : expiry;
  const remainingMs = () => Math.max(1, Math.floor(deadline - performance.now()));
  // A cancellation keeps the caller's reason. A timeout, this one or the
  // caller's own deadline signal, is the budget running out.
  const stopped = (): unknown => {
    const reason: unknown = options.signal?.aborted ? options.signal.reason : undefined;
    const timedOut = reason === undefined || (reason instanceof DOMException && reason.name === 'TimeoutError');
    return timedOut ? new BudgetExceededError(provider, timeoutMs, { cause: reason }) : reason;
  };
  const unlessStopped = async <V>(operation: Promise<V>): Promise<V> => {
    void operation.catch(() => {});
    if (signal.aborted) throw stopped();
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(stopped());
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([operation, aborted]); }
    finally { signal.removeEventListener('abort', abort); }
  };

  const ahead = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await unlessStopped(ahead);
  } catch (error) {
    // Leaving the queue must not let the lookups behind overtake the one in front.
    void ahead.then(release);
    throw error;
  }

  let browser: Browser | undefined;
  let launching: Promise<Browser> | undefined;
  try {
    // Loading the optional dependency can take a moment; a lookup that ends meanwhile is answered at once and launches nothing.
    const chromium = await unlessStopped(loadChromium(provider));
    if (signal.aborted) throw stopped();
    // Do not pass the application environment (database or API secrets) to Chromium.
    // The private service binds to loopback; its Host check must survive a tunnel's different address.
    launching = endpoint ? chromium.connect(endpoint, { timeout: Math.min(remainingMs(), 10_000), headers: { Host: 'localhost' } })
      : chromium.launch({ executablePath: options.executablePath, headless: true, args: [...(options.args ?? [])],
      timeout: Math.min(remainingMs(), 10_000), ...(proxy ? { proxy: { server: proxy } } : {}),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', LANG: 'en_US.UTF-8' } });
    browser = await unlessStopped(launching);
    return await unlessStopped(run({ browser, signal, remainingMs }));
  } catch (error) {
    // Playwright is handed the remaining budget as its own timeout, and its timer can fire a moment before this one:
    // an unclassified failure at the deadline is the budget running out.
    if (carrierErrorKind(error) === null && (signal.aborted || deadline - performance.now() < DEADLINE_SLACK_MS)) throw stopped();
    throw error;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* A browser that cannot close must not hide the lookup's answer. */ }
      release();
    } else if (launching) {
      // Answer the caller now, but keep the turn until a launch that outlived
      // its lookup has resolved and that browser is closed.
      void launching.then((late) => late.close()).catch(() => {}).finally(release);
    } else release();
  }
}
