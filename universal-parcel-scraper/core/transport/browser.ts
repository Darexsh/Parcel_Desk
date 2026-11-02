import type { Page, Response } from 'playwright-core';
import type { CarrierResult } from '../result/index.js';
import { IndeterminateError, TransportError, UpstreamHttpError } from '../errors/index.js';
import { withLocalBrowser } from './localBrowser.js';

export interface UniversalBrowserOptions {
  executablePath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function scrapeUniversalPage(
  options: UniversalBrowserOptions,
  spec: {
    name: string;
    url: string;
    responseUrl: string;
    submit?: (page: Page) => Promise<void>;
    /** Explicit terminal replies from the lookup flow, including its submission endpoint. */
    responseErrors?: Readonly<Record<string, (payload: unknown) => Error | undefined>>;
    /** Statuses besides 200 and 201 whose JSON `responseErrors` reads, such as a not-found reply. */
    errorStatuses?: readonly number[];
  },
  parse: (payload: unknown) => CarrierResult,
): Promise<CarrierResult> {
  const executablePath = options.executablePath;
  if (!executablePath) throw new TransportError(spec.name, `${spec.name} requires TRACKING_CHROMIUM_PATH`);
  let expired = false;
  try {
    return await withLocalBrowser({ provider: spec.name, executablePath, timeoutMs: options.timeoutMs ?? 45_000, signal: options.signal,
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'] }, async ({ browser, remainingMs }) => {
      const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
      const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
      const remaining = remainingMs();
      let received = 0;
      let resolveHistory!: (result: CarrierResult) => void;
      let rejectHistory!: (error: Error) => void;
      // The lookup's deadline ends the wait for a matching reply.
      const history = new Promise<CarrierResult>((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject; });
      void history.catch(() => {});
      const navigation = (async () => {
        const context = await browser.newContext({ userAgent, locale: 'en-US', timezoneId: 'UTC',
          viewport: { width: 1440, height: 1000 }, acceptDownloads: false, serviceWorkers: 'block' });
        // Only the provider and its challenge resources are needed. This also keeps
        // advertisements and provider scripts from reaching private network hosts.
        const provider = new URL(spec.url).hostname.replace(/^www\./, '');
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          const allowed = url.protocol === 'https:' && (url.hostname === provider || url.hostname.endsWith(`.${provider}`)
            || url.hostname.endsWith('.challenges.cloudflare.com')
            || ['challenges.cloudflare.com', 'www.google.com', 'www.gstatic.com', 'www.recaptcha.net'].includes(url.hostname));
          await (allowed ? route.continue() : route.abort());
        });
        const page = await context.newPage();
        page.setDefaultTimeout(remaining);
        page.on('response', async (response: Response) => {
          const url = response.url();
          const inspect = Object.hasOwn(spec.responseErrors ?? {}, url) ? spec.responseErrors![url] : undefined;
          if (expired || (url !== spec.responseUrl && !inspect)) return;
          if (response.status() === 429) {
            const raw = response.headers()['retry-after'];
            const delay = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - Date.now() : undefined;
            rejectHistory(new UpstreamHttpError(spec.name, 429, delay));
            return;
          }
          const success = [200, 201].includes(response.status());
          if (!success && !(inspect && spec.errorStatuses?.includes(response.status()))) return;
          if (++received > 20) { rejectHistory(new IndeterminateError(spec.name, `${spec.name} returned too many polling responses`)); return; }
          try {
            if (Number(response.headers()['content-length'] ?? 0) > 2_000_000) return;
            const body = await response.body();
            if (expired || body.length > 2_000_000) return;
            const payload: unknown = JSON.parse(body.toString('utf8'));
            const error = inspect?.(payload);
            if (error) { rejectHistory(error); return; }
            if (url === spec.responseUrl && success) resolveHistory(parse(payload));
          } catch {
            // Initial polling, challenges and unrelated shipments are not history.
          }
        });

        const response = await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: remaining });
        // Cloudflare initially responds with 403, then navigates after its
        // automatic browser check. Let the bounded lookup wait for that reload.
        const challenge = response?.status() === 403 && response.headers()['cf-mitigated'] === 'challenge';
        if (!response) throw new TransportError(spec.name, `${spec.name} tracking page is unavailable`);
        if (response.status() !== 200 && !challenge) throw new UpstreamHttpError(spec.name, response.status());
        if (spec.submit) await spec.submit(page);
        return history;
      })();
      void navigation.catch(() => {});
      return await Promise.race([navigation, history]);
    });
  } finally {
    expired = true;
  }
}
