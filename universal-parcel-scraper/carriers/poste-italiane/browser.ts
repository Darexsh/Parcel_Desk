import type { Request, Response as BrowserResponse } from 'playwright-core';
import { ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import type { BrowserContextProxy } from '../../core/transport/browserRouteTrial.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'Poste Italiane';
const API = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
const MAX_BYTES = 1_000_000;

/** The official guest page makes and consumes its own tracking request in a fresh private browser context. */
export async function fetchPosteItalianeInBrowser(number: string, endpoint: string, signal: AbortSignal,
  timeoutMs: number, proxy?: BrowserContextProxy | null): Promise<unknown> {
  return withRemoteBrowser({ provider: PROVIDER, endpoint, signal, timeoutMs }, async ({ browser, signal: session, remainingMs }) => {
    const context = await browser.newContext({ locale: 'it-IT', acceptDownloads: false, serviceWorkers: 'block',
      ...(proxy ? { proxy } : {}) });
    const page = await context.newPage();
    const requests = new Set<Request>();
    let active = true, count = 0, bytes = 0;
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const reply = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    void reply.catch(() => {});
    const request = (request: Request) => {
      if (!active || request.url() !== API || request.method() !== 'POST' || request.frame() !== page.mainFrame()) return;
      let body: unknown;
      try { body = request.postDataJSON() as unknown; } catch { return; }
      if (isRecord(body) && body.codiceSpedizione === number && body.tipoRichiedente === 'WEB') {
        if (requests.size >= 3) { reject(new SchemaError(PROVIDER, 'Too many browser tracking requests')); return; }
        requests.add(request);
      }
    };
    const failed = (request: Request) => {
      if (requests.has(request)) reject(new TransportError(PROVIDER, 'Browser tracking request failed'));
    };
    const response = (response: BrowserResponse) => {
      if (!active || !requests.has(response.request()) || response.url() !== API) return;
      void (async () => {
        if (++count > 3) throw new SchemaError(PROVIDER, 'Too many browser tracking replies');
        const status = response.status(), headers = response.headers();
        if (status === 429) {
          const retry = headers['retry-after'];
          throw new RateLimitedError(PROVIDER, retry && /^\d+$/.test(retry) ? Math.min(Number(retry) * 1000, 3_600_000) : undefined);
        }
        if ([401, 403].includes(status)) throw new ChallengeError(PROVIDER);
        if (![200, 400].includes(status)) throw new UpstreamHttpError(PROVIDER, status);
        const length = Number(headers['content-length'] ?? 0);
        if (!(headers['content-type'] ?? '').includes('application/json') || !Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES) {
          throw new SchemaError(PROVIDER, 'Invalid browser tracking reply');
        }
        const body = await response.body();
        if (!active) return;
        bytes += body.length;
        if (body.length > MAX_BYTES || bytes > 2 * MAX_BYTES) throw new SchemaError(PROVIDER, 'Excessive browser tracking reply');
        let payload: unknown;
        try { payload = JSON.parse(body.toString('utf8')) as unknown; } catch { throw new SchemaError(PROVIDER); }
        if (!isRecord(payload)) throw new SchemaError(PROVIDER);
        if (status === 400 && payload.tipo === 'error' && /captcha/i.test(String(payload.descrizione))) throw new ChallengeError(PROVIDER);
        if (status !== 200) throw new UpstreamHttpError(PROVIDER, status);
        // A positive history must echo the whole input. Negative outcomes still
        // pass through the shared parser after the request itself was bound.
        if (Array.isArray(payload.listaMovimenti) && payload.listaMovimenti.length && payload.idTracciatura !== number) {
          throw new SchemaError(PROVIDER, 'Browser history does not match the requested shipment');
        }
        resolve(payload);
      })().catch(error => { if (active) reject(error); });
    };
    const abort = () => reject(session.reason);
    page.on('request', request); page.on('requestfailed', failed); page.on('response', response);
    session.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      session.throwIfAborted();
      timer = setTimeout(() => reject(new ChallengeError(PROVIDER, 'The guest page did not return tracking history')),
        Math.max(1, remainingMs() - 1500));
      const navigate = async () => {
        const navigation = await page.goto(`https://www.poste.it/cerca-spedizioni#/risultati-spedizioni/${encodeURIComponent(number)}`,
          { waitUntil: 'domcontentloaded', timeout: Math.max(1, remainingMs() - 1500) });
        if ([401, 403].includes(navigation?.status() ?? 0)) throw new ChallengeError(PROVIDER);
        if ((navigation?.status() ?? 0) >= 400) throw new UpstreamHttpError(PROVIDER, navigation!.status());
        await page.getByRole('button', { name: 'Non accetto', exact: true })
          .click({ timeout: Math.min(1000, Math.max(1, remainingMs() - 1500)) }).catch(() => {});
      };
      await Promise.race([navigate(), reply.then(() => {})]);
      return await reply;
    } finally {
      active = false; clearTimeout(timer); session.removeEventListener('abort', abort);
      page.off('request', request); page.off('requestfailed', failed); page.off('response', response);
      await context.close().catch(() => {});
    }
  });
}
