import { BudgetExceededError, carrierErrorKind, SchemaError, TransportError } from '../errors/index.js';
import type { StepSpec } from '../runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from './trawl.js';

/** Browser recovery for a read-only page whose address contains the whole lookup. */
export function trawlPageStep<T>(options: {
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  provider: string;
  url: string;
  maxBytes: number;
  contentWaitForSelector?: string;
  /** Read a carrier's explicit negative redirect; another URL can never supply a history. */
  parseRedirect?: (url: string, html: string) => never;
  parse: (html: string) => T;
}): StepSpec<T> {
  return {
    id: 'trawl', enabled: Boolean(options.trawl),
    // Rate limits, definite answers and changed pages do not warrant a browser.
    recovers: error => carrierErrorKind(error) === 'challenge',
    run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const timeoutMs = Math.floor(Math.min(30_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      if (timeoutMs < 1) throw new BudgetExceededError(options.provider, remainingMs);
      const page = await options.trawl!.scrape({ url: options.url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        ...(options.contentWaitForSelector ? { contentWaitForSelector: options.contentWaitForSelector } : {}),
      }, {
        provider: options.provider, signal, timeoutMs, fetcher: options.fetcher,
        // JSON can escape each source character; the decoded page has its own cap.
        maxBytes: options.maxBytes * 6 + 65_536,
      });
      signal.throwIfAborted();
      if (new TextEncoder().encode(page.html).byteLength > options.maxBytes) {
        throw new SchemaError(options.provider, 'The browser returned an oversized tracking page');
      }
      if (page.url !== options.url) {
        options.parseRedirect?.(page.url, page.html);
        throw new TransportError(options.provider, 'The browser redirected the requested tracking page');
      }
      return options.parse(page.html);
    },
  };
}
