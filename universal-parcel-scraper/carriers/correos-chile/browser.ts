import type { Page, Response as BrowserResponse } from 'playwright-core';
import { BudgetExceededError, carrierErrorKind, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { parseCorreosChileBootstrap, parseCorreosChileTracking } from './parser.js';
import { solveCorreosChileText } from './text-challenge.js';

const PROVIDER = 'Correos de Chile';
const PAGE = 'https://www.correos.cl/seguimiento-en-linea';
const MAX_BYTES = 6_000_000;
const WIDGET = 'iframe[title="Widget containing checkbox for hCaptcha security challenge"]';
const CHALLENGE = 'iframe[title="hCaptcha challenge"]';
const MAX_TEXT_SETS = 3;
// Another set is answered only while the rest of the lookup still fits after it.
const MIN_SET_MS = 20_000;
export type ChileTextAnswer = (heading: string, question: string, signal: AbortSignal, timeoutMs: number) => Promise<string | null>;

/** The page's resource, bound to exactly one complete identifier. */
export function isCorreosChileTrackingRequest(address: string, method: string, body: string | null, number: string): boolean {
  if (method !== 'POST' || !body || body.length > 20_000) return false;
  let url: URL;
  try { url = new URL(address); } catch { return false; }
  const id = url.searchParams.get('p_p_id') ?? '';
  if (url.origin !== 'https://www.correos.cl' || url.pathname !== '/seguimiento-en-linea' || url.username || url.password || url.hash
    || !/^cl_cch_seguimiento_portlet_seguimientoenlineaportlet_INSTANCE_[A-Za-z0-9]{8,24}$/.test(id)
    || url.searchParams.get('p_p_lifecycle') !== '2'
    || url.searchParams.get('p_p_resource_id') !== 'cl_cch_seguimiento_portlet_seguimientoresurcecommand'
    || url.searchParams.get(`_${id}_cmd`) !== 'cmd_resource_get_seguimientos') return false;
  const params = new URLSearchParams(body), key = `_${id}_param_nro_seguimiento`;
  return params.getAll(key).length === 1 && params.get(key) === number;
}

/** Uses the offered text challenge. Unsupported or refused answers stay challenges. */
export async function solveCorreosChileWidget(page: Page, signal: AbortSignal, remainingMs: () => number,
  answerText?: ChileTextAnswer): Promise<void> {
  const timeout = (max: number) => { signal.throwIfAborted(); return Math.max(1, Math.min(max, remainingMs())); };
  const widget = page.frameLocator(WIDGET), challenge = page.frameLocator(CHALLENGE);
  const checked = widget.locator('[role="checkbox"][aria-checked="true"]');
  let phase = 'The verification widget did not become ready';
  try {
    await widget.getByRole('checkbox').click({ timeout: timeout(12_000) });
    phase = 'The verification options did not become ready';
    const menu = challenge.getByRole('button', { name: 'About hCaptcha & Accessibility Options', exact: true });
    const interactive = await Promise.any([
      checked.waitFor({ state: 'visible', timeout: timeout(8_000) }).then(() => false),
      menu.waitFor({ state: 'visible', timeout: timeout(8_000) }).then(() => true),
    ]);
    if (!interactive) return;
    phase = 'Text verification is unavailable';
    await menu.click({ timeout: timeout(2_000) });
    await challenge.getByRole('menuitem', { name: /^Display hCaptcha Accessibility Challenge(?:,|$)/ }).click({ timeout: timeout(3_000) });
    const element = await page.locator(CHALLENGE).elementHandle({ timeout: timeout(2_000) });
    const frame = await element?.contentFrame();
    if (!frame) throw new ChallengeError(PROVIDER);
    const nextQuestion = (asked: string, max: number) => frame.waitForFunction(previous => {
      const input = document.querySelector<HTMLInputElement>('input[role="textbox"]');
      const prompt = document.getElementById('prompt-text')?.textContent?.trim();
      return input?.value === '' && !!prompt && prompt !== previous;
    }, asked.trim(), { timeout: timeout(max) });
    // A refused set is followed at once by a fresh one, which is answered too.
    for (let set = 1; set <= MAX_TEXT_SETS; set++) {
      let question = '';
      for (let index = 0, final = false; !final; index++) {
        if (index === 3) throw new ChallengeError(PROVIDER);
        phase = 'The text question did not become ready';
        const box = frame.getByRole('textbox');
        await box.waitFor({ state: 'visible', timeout: timeout(4_000) });
        const heading = await frame.locator('#prompt-question').innerText({ timeout: timeout(1_000) });
        question = await frame.locator('#prompt-text').innerText({ timeout: timeout(1_000) });
        if (heading.length > 150 || question.length > 400) throw new ChallengeError(PROVIDER);
        const answer = solveCorreosChileText(heading, question)
          ?? await answerText?.(heading, question, signal, timeout(10_000));
        signal.throwIfAborted();
        if (typeof answer !== 'string' || !/^[A-Za-z0-9-][A-Za-z0-9 ,'-]{0,59}$/.test(answer)) throw new ChallengeError(PROVIDER, 'Unsupported text challenge');
        await box.fill(answer, { timeout: timeout(1_500) });
        const submit = frame.locator('.button-submit');
        const label = await submit.getAttribute('aria-label', { timeout: timeout(1_000) });
        final = label === 'Verify Answers';
        if (!final && !/^Next Challenge, page [12] of [23]$/.test(label ?? '')) throw new ChallengeError(PROVIDER);
        await submit.click({ timeout: timeout(2_000) });
        if (!final) {
          phase = 'The next text question did not become ready';
          await nextQuestion(question, 4_000);
        }
      }
      phase = 'Text verification was not accepted';
      const accepted = await Promise.any([
        checked.waitFor({ state: 'visible', timeout: timeout(6_000) }).then(() => true),
        nextQuestion(question, 6_000).then(() => false),
      ]);
      if (accepted) return;
      if (remainingMs() < MIN_SET_MS) break;
    }
    throw new ChallengeError(PROVIDER, phase);
  } catch (error) {
    signal.throwIfAborted();
    if (carrierErrorKind(error)) throw error;
    throw new ChallengeError(PROVIDER, phase);
  }
}

export function fetchCorreosChileInBrowser(number: string, endpoint: string, signal: AbortSignal, timeoutMs: number,
  answerText?: ChileTextAnswer): Promise<CarrierResult> {
  return withRemoteBrowser({ provider: PROVIDER, endpoint, signal, timeoutMs }, async ({ browser, signal: stopped, remainingMs }) => {
    const left = (max = 60_000) => {
      stopped.throwIfAborted();
      if (remainingMs() <= 1_000) throw new BudgetExceededError(PROVIDER, timeoutMs);
      return Math.max(1, Math.min(max, remainingMs() - 1_000));
    };
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, locale: 'en-US' });
    const page = await context.newPage();
    let active = true, expected: string | null = null, count = 0, bytes = 0;
    let resolve!: (value: CarrierResult) => void, reject!: (error: unknown) => void;
    const reply = new Promise<CarrierResult>((yes, no) => { resolve = yes; reject = no; });
    void reply.catch(() => {});
    const received = (response: BrowserResponse) => {
      const request = response.request();
      if (!active || response.url() !== expected || request.frame() !== page.mainFrame()
        || !isCorreosChileTrackingRequest(request.url(), request.method(), request.postData(), number)) return;
      void (async () => {
        if (++count > 3) throw new SchemaError(PROVIDER, 'Too many tracking responses');
        const status = response.status();
        if (status === 429) {
          const retry = response.headers()['retry-after'];
          const delay = retry && (/^\d+$/.test(retry.trim()) ? Number(retry) * 1_000 : Date.parse(retry) - Date.now());
          throw new RateLimitedError(PROVIDER, typeof delay === 'number' && Number.isFinite(delay) ? Math.max(0, delay) : undefined);
        }
        if ([401, 403].includes(status)) throw new ChallengeError(PROVIDER);
        if ([404, 410].includes(status)) throw new IndeterminateError(PROVIDER, 'Tracking resource is unavailable');
        if (status !== 200) throw new UpstreamHttpError(PROVIDER, status);
        if (Number(response.headers()['content-length'] ?? 0) > MAX_BYTES) throw new SchemaError(PROVIDER, 'Tracking response is too large');
        const body = await response.body();
        if (!active || stopped.aborted) return;
        bytes += body.length;
        if (body.length > MAX_BYTES || bytes > 2 * MAX_BYTES) throw new SchemaError(PROVIDER, 'Tracking response is too large');
        const text = body.toString('utf8');
        if (/Radware (?:Captcha )?Page|Please solve this CAPTCHA/i.test(text)) throw new ChallengeError(PROVIDER);
        let payload: unknown;
        try { payload = JSON.parse(text) as unknown; } catch { throw new SchemaError(PROVIDER, 'Tracking response is not JSON'); }
        resolve(parseCorreosChileTracking(payload, number));
      })().catch(error => { if (active) reject(carrierErrorKind(error) ? error : new TransportError(PROVIDER)); });
    };
    page.on('response', received);
    const aborted = () => reject(stopped.reason);
    stopped.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => reject(new TransportError(PROVIDER, 'Tracking page did not answer')), left());
    try {
      const navigation = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: left(20_000) });
      if (!navigation) throw new TransportError(PROVIDER);
      if ([401, 403].includes(navigation.status())) throw new ChallengeError(PROVIDER);
      if (navigation.status() === 429) throw new RateLimitedError(PROVIDER);
      if ([404, 410].includes(navigation.status())) throw new IndeterminateError(PROVIDER, 'Tracking page is unavailable');
      if (navigation.status() !== 200) throw new UpstreamHttpError(PROVIDER, navigation.status());
      const landed = new URL(page.url());
      if (landed.origin === 'https://validate.perfdrive.com' && landed.searchParams.get('ssc') === PAGE) {
        await solveCorreosChileWidget(page, stopped, () => left(), answerText);
        await page.getByRole('button', { name: 'Submit', exact: true }).click({ timeout: left(4_000), noWaitAfter: true });
      } else if (landed.origin !== 'https://www.correos.cl') throw new SchemaError(PROVIDER, 'Unexpected tracking page');
      // The input precedes the handlers in this page; DOM visibility alone is too early.
      await page.waitForFunction(() => location.origin === 'https://www.correos.cl' && document.readyState === 'complete'
        && (window as Window & { jQuery?: { isReady?: boolean } }).jQuery?.isReady === true
        && document.documentElement.innerHTML.includes('ajaxSeguimientosURL'), undefined, { timeout: left(16_000) });
      expected = parseCorreosChileBootstrap(await page.content()).url;
      const input = page.locator('input[id$="nrsSeguimientos-flexdatalist"]');
      await input.fill(number, { timeout: left(3_000) });
      stopped.throwIfAborted();
      if (await input.inputValue() !== number) throw new TransportError(PROVIDER, 'Tracking input changed');
      // The normal click obtains and submits the page's separate reCAPTCHA token.
      await page.locator('[id$="buscarSeguimientos"]').click({ timeout: left(3_000) });
      return await reply;
    } catch (error) {
      stopped.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      throw new TransportError(PROVIDER, 'Browser tracking did not complete');
    } finally {
      active = false;
      clearTimeout(timer);
      page.off('response', received);
      stopped.removeEventListener('abort', aborted);
    }
  });
}
