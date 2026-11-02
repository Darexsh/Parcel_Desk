import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Frame, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { ChallengeError } from '../../core/errors/index.js';
import { loadSharp } from '../../core/transport/optional.js';
import { isRecord } from '../../core/types.js';
import { planRoyalMailVision, type RoyalMailVisionOptions } from './vision-model.js';

const CHALLENGE = 'iframe[src*="hcaptcha.com"][src*="frame=challenge"]:visible';
const PROVIDER = 'Royal Mail';
type Outcome = 'accepted' | 'deferred' | 'declined' | 'stale' | 'unsupported' | 'refused' | 'blocked' | 'timeout';

/** A derived guide for the model, never drawn on the live widget. */
export function royalMailVisionGrid(width: number, height: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || width > 1000 || height < 100 || height > 1200) {
    throw new RangeError('Unsupported verification image dimensions');
  }
  const lines: string[] = [], labels: string[] = [];
  for (let step = 1; step < 10; step++) {
    const x = Math.round(width * step / 10), y = Math.round(height * step / 10), value = step * 100;
    lines.push(`<path d="M${x} 0V${height}M0 ${y}H${width}"/>`);
    labels.push(`<text x="${x + 2}" y="14">${value}</text><text x="2" y="${y - 3}">${value}</text>`);
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<g fill="none" stroke="#777" stroke-width="1" opacity="0.6">${lines.join('')}</g>`
    + `<g font-family="sans-serif" font-size="11" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">${labels.join('')}</g></svg>`);
}

export interface RoyalMailVerificationRecord {
  outcome: Outcome;
  phase: 'widget' | 'analysis' | 'generation' | 'snapshot' | 'geometry' | 'input' | 'verification' | 'submit' | 'proof';
  modelCalls: number;
  rounds: number;
  actions: number;
  submissions: number;
  checks: number;
  accepted: boolean;
  history: boolean;
  modelMs: number;
}

export interface RoyalMailCaptchaOptions extends RoyalMailVisionOptions {
  /** Fixed labels and counts only. Sink failures never affect tracking. */
  onVerification?: (record: RoyalMailVerificationRecord) => void;
}

export interface RoyalMailVisionContext {
  options: RoyalMailCaptchaOptions;
  /** Shared by the browser step and its existing fresh-context retry. */
  attempt: { used: boolean };
  /** Preserve the existing fresh-context retry before spending time on inference. */
  retryReserveMs?: number;
}

/** Observe before navigation. The original guest widget issues and consumes its own proof. */
export function royalMailVisionRecovery(page: Page, config: RoyalMailVisionContext, session: AbortSignal,
  remainingMs: () => number) {
  let frame: Frame | null = null;
  let widget: string | null = null;
  let generation = 0;
  let armed = false;
  let checking = false;
  let acceptedReply = false;
  let refused = false;
  let blocked = false;
  let seen = false;
  let outcome: Outcome = 'declined';
  let phase: RoyalMailVerificationRecord['phase'] = 'widget';
  const record = { modelCalls: 0, rounds: 0, actions: 0, submissions: 0, accepted: false, modelMs: 0 };
  const pending = new Set<Promise<void>>();
  const verificationRequests = new Set<Request>();
  const captchaRequest = (request: Request, type: 'getcaptcha' | 'checkcaptcha') => {
    try {
      const url = new URL(request.url());
      const sender = request.frame();
      const senderUrl = new URL(sender.url());
      const senderId = new URLSearchParams(senderUrl.hash.slice(1)).get('id') ?? senderUrl.searchParams.get('id');
      const sameWidget = sender === frame || widget !== null && senderId === widget
        && senderUrl.protocol === 'https:' && /(^|\.)hcaptcha\.com$/.test(senderUrl.hostname);
      return url.protocol === 'https:' && /(^|\.)hcaptcha\.com$/.test(url.hostname) && request.method() === 'POST'
        && new RegExp(`^/${type}(?:/|$)`).test(url.pathname) && (frame === null || sameWidget);
    } catch { return false; }
  };
  const requested = (request: Request) => {
    if (captchaRequest(request, 'getcaptcha')) generation++;
    if (armed && verificationRequests.size < 2 && captchaRequest(request, 'checkcaptcha')) {
      verificationRequests.add(request); checking = true;
    }
  };
  const received = (response: BrowserResponse) => {
    if (!armed || pending.size >= 2 || !verificationRequests.has(response.request()) || !captchaRequest(response.request(), 'checkcaptcha')) return;
    if ([403, 429].includes(response.status())) { blocked = true; return; }
    const task = (async () => {
      if (Number(response.headers()['content-length'] ?? 0) > 200_000) return;
      const bytes = await response.body();
      if (!armed || bytes.length > 200_000) return;
      let data: unknown;
      try { data = JSON.parse(bytes.toString('utf8')) as unknown; } catch { return; }
      if (!isRecord(data)) return;
      if (data.pass === false) refused = true;
      acceptedReply = data.pass === true && typeof data.generated_pass_UUID === 'string' && data.generated_pass_UUID.length > 0;
    })().catch(() => {});
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  page.on('request', requested);
  page.on('response', received);

  const solve = async (signal: AbortSignal, phaseMs = Infinity): Promise<boolean> => {
    seen = true;
    if ((config.retryReserveMs ?? 0) > 0 && remainingMs() >= config.retryReserveMs!) {
      outcome = 'deferred'; return false;
    }
    if (config.attempt.used) return false;
    config.attempt.used = true;
    const expires = performance.now() + Math.min(13_000, remainingMs() - 2500, phaseMs - 1000);
    const left = (cap = 1000) => {
      signal.throwIfAborted(); session.throwIfAborted();
      const ms = Math.min(expires - performance.now(), remainingMs() - 2500);
      if (ms < 100) { outcome = 'timeout'; throw new Error('verification deadline'); }
      return Math.max(1, Math.floor(Math.min(cap, ms)));
    };
    try {
      const element = await page.locator(CHALLENGE).elementHandle({ timeout: left() });
      frame = await element?.contentFrame() ?? null;
      if (!frame) { outcome = 'unsupported'; return false; }
      const original = frame.url();
      const address = new URL(original);
      if (address.protocol !== 'https:' || !/(^|\.)hcaptcha\.com$/.test(address.hostname)) { outcome = 'unsupported'; return false; }
      const widgetId = new URLSearchParams(address.hash.slice(1)).get('id') ?? address.searchParams.get('id');
      if (!widgetId || !/^[A-Za-z0-9_-]{1,80}$/.test(widgetId)) { outcome = 'unsupported'; return false; }
      widget = widgetId;
      // Observe the SDK's own completion message before the application can
      // consume and reset its proof. Neither the message nor its token leaves Chrome.
      const observed = await element?.evaluate((node, id) => {
        if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) return false;
        const iframe = node;
        const root = window as unknown as { __royalMailVision?: { id: string; armed: boolean; passed: boolean } };
        const state = { id, armed: false, passed: false };
        root.__royalMailVision = state;
        window.addEventListener('message', event => {
          if (!state.armed || !event.isTrusted || event.source !== iframe.contentWindow
            || !/^https:\/\/(?:[a-z0-9-]+\.)*hcaptcha\.com$/i.test(event.origin)) return;
          let data: unknown = event.data;
          if (typeof data === 'string') {
            if (data.length > 16_000) return;
            try { data = JSON.parse(data) as unknown; } catch { return; }
          }
          if (!data || typeof data !== 'object') return;
          const message = data as { source?: unknown; id?: unknown; label?: unknown;
            contents?: { event?: unknown; response?: unknown } };
          if (message.source === 'hcaptcha' && message.id === id && message.label === 'challenge-closed'
            && message.contents?.event === 'challenge-passed' && typeof message.contents.response === 'string'
            && message.contents.response.length > 20) state.passed = true;
        });
        return true;
      }, widgetId);
      if (!observed) { outcome = 'unsupported'; return false; }
      // Read only whether this widget has a proof. The value never leaves Chrome.
      const hasProof = () => page.evaluate(id => {
        const root = window as unknown as { hcaptcha?: { getResponse?: (widget: string) => string };
          __royalMailVision?: { id: string; armed: boolean; passed: boolean } };
        if (root.__royalMailVision?.id === id && root.__royalMailVision.passed) return true;
        const api = root.hcaptcha;
        if (typeof api?.getResponse !== 'function') return null;
        const proof = api.getResponse(id);
        return typeof proof === 'string' && proof.length > 20;
      }, widgetId);
      if (await hasProof() !== false) { outcome = 'unsupported'; return false; }
      const verdict = async () => {
        if (blocked || refused) {
          outcome = blocked ? 'blocked' : 'refused';
          throw new ChallengeError(PROVIDER, 'Royal Mail verification was refused', { reason: `captcha_${outcome}` });
        }
        if (acceptedReply || await hasProof() === true) {
          outcome = 'accepted'; record.accepted = true; return true;
        }
        return false;
      };
      const automaticVerdict = async () => {
        if (!checking) return false;
        const until = performance.now() + Math.min(1000, left());
        while (performance.now() < until) {
          if (await verdict()) return true;
          await delay(50, undefined, { signal });
        }
        return await verdict();
      };
      const sharp = await loadSharp(PROVIDER);
      {
        record.rounds++;
        const crop = frame.locator('.challenge-view');
        if (await frame.locator('canvas').count() !== 1) { outcome = 'unsupported'; return false; }
        const ready = await crop.evaluate(node => {
          for (let el: Element | null = node; el; el = el.parentElement) {
            const style = getComputedStyle(el);
            if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) < 0.99) return false;
          }
          return true;
        });
        if (!ready) { outcome = 'stale'; return false; }
        const signature = await frame.locator('.prompt-text').innerText({ timeout: left() });
        if (!/\b(?:drag|move)\b/i.test(signature) || signature.length > 1000) { outcome = 'unsupported'; return false; }
        const submit = frame.locator('.button-submit');
        const canVerify = async (beforeAnswer = false) => {
          const labels = [await submit.getAttribute('aria-label', { timeout: left() }), await submit.innerText({ timeout: left() })];
          return labels.some(label => /^Verify(?: (?:Answers|Challenge))?$/i.test(label?.trim() ?? '')
            || beforeAnswer && /^Skip(?: Challenge)?$/i.test(label?.trim() ?? ''));
        };
        // Multi-page drag tasks require a separate transition contract. Decline
        // a visible Next control before inference and never advance it after input.
        // An unanswered single-page task can still label this control Skip.
        if (!await canVerify(true)) { outcome = 'unsupported'; return false; }
        let image = await crop.screenshot({ type: 'png', timeout: left() });
        let stable = false;
        // A visible canvas can still be fading or receiving its first assets.
        // Never ask the model about a transient frame.
        for (let check = 0; check < 4; check++) {
          await delay(100, undefined, { signal });
          const nextImage = await crop.screenshot({ type: 'png', timeout: left() });
          stable = createHash('sha256').update(image).digest('hex') === createHash('sha256').update(nextImage).digest('hex');
          image = nextImage;
          if (stable) break;
        }
        if (!stable) { outcome = 'stale'; return false; }
        const digest = createHash('sha256').update(image).digest('hex');
        const box = await crop.boundingBox(), canvas = await frame.locator('canvas').boundingBox();
        if (!box || !canvas || box.width < 100 || box.width > 1000 || box.height < 100 || box.height > 1200) {
          outcome = 'unsupported'; return false;
        }
        const currentGeneration = generation;
        const started = performance.now();
        phase = 'analysis';
        const guide = await sharp(image).composite([{ input: royalMailVisionGrid(Math.round(box.width), Math.round(box.height)) }]).png().toBuffer();
        const modelBudget = Math.min(10_000, left(13_000) - 2000);
        if (modelBudget < 500) { outcome = 'timeout'; return false; }
        record.modelCalls++;
        const plan = await planRoyalMailVision(config.options, image, signal, modelBudget, guide);
        record.modelMs += Math.round(performance.now() - started);
        if (!plan) { outcome = 'declined'; return false; }
        phase = 'generation';
        left();
        const unchanged = async () => {
          if (frame?.url() !== original || generation !== currentGeneration
            || await frame.locator('.prompt-text').innerText({ timeout: left() }) !== signature) return false;
          const currentBox = await crop.boundingBox(), currentCanvas = await frame.locator('canvas').boundingBox();
          return currentBox !== null && currentCanvas !== null
            && (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(currentBox[key] - box[key]) < 0.5
              && Math.abs(currentCanvas[key] - canvas[key]) < 0.5);
        };
        const now = await crop.screenshot({ type: 'png', timeout: left() });
        if (!await unchanged()) {
          outcome = 'stale'; return false;
        }
        phase = 'snapshot';
        if (createHash('sha256').update(now).digest('hex') !== digest) { outcome = 'stale'; return false; }
        const points = plan.points.map(point => ({ x: point.x / 1000 * box.width, y: point.y / 1000 * box.height }));
        phase = 'geometry';
        if (!points.every(point => point.x + box.x > canvas.x + 3 && point.x + box.x < canvas.x + canvas.width - 3
          && point.y + box.y > canvas.y + 3 && point.y + box.y < canvas.y + canvas.height - 3)
          || points.some((point, i) => points.slice(0, i).some(other => Math.hypot(point.x - other.x, point.y - other.y) < 58))) {
          outcome = 'declined'; return false;
        }
        phase = 'input';
        await page.evaluate(id => {
          const state = (window as unknown as { __royalMailVision?: { id: string; armed: boolean } }).__royalMailVision;
          if (state?.id === id) state.armed = true;
        }, widgetId);
        armed = true;
        left();
        await page.mouse.move(box.x + points[0]!.x, box.y + points[0]!.y);
        await page.mouse.down();
        try { await page.mouse.move(box.x + points[1]!.x, box.y + points[1]!.y, { steps: 10 }); }
        finally { await page.mouse.up(); }
        record.actions++;
        if (await automaticVerdict()) return true;
        // A widget that submitted on mouse-up already owns verification. Do
        // not submit the same answer again while its response is still pending.
        if (checking) { outcome = 'timeout'; return false; }
        if (await verdict()) return true;
        if (!await unchanged()) { outcome = 'stale'; return false; }
        // The drag has now been applied to the matching image.
        // The widget may repaint its selection/completion feedback afterwards;
        // its generation, prompt and frame still have to match before submission.
        phase = 'verification';
        if (!await canVerify()) {
          outcome = 'unsupported'; return false;
        }
        if (checking) {
          if (await automaticVerdict()) return true;
          outcome = 'timeout'; return false;
        }
        phase = 'submit';
        await submit.click({ timeout: left() });
        record.submissions++;
        phase = 'proof';
        while (true) {
          left();
          if (await verdict()) return true;
          if (frame.isDetached()) { outcome = 'stale'; return false; }
          if (generation !== currentGeneration) {
            outcome = 'refused';
            throw new ChallengeError(PROVIDER, 'Royal Mail verification was refused', { reason: 'captcha_refused' });
          }
          await delay(100, undefined, { signal });
        }
      }
    } catch (error) {
      signal.throwIfAborted(); session.throwIfAborted();
      if (error instanceof ChallengeError) throw error;
      outcome = outcome === 'timeout' || performance.now() >= expires ? 'timeout' : 'unsupported';
      return false;
    } finally { armed = false; }
  };

  return { solve, finish: (history: boolean) => {
    page.off('request', requested); page.off('response', received); armed = false;
    if (seen) {
      try { config.options.onVerification?.({ outcome, phase, ...record, checks: verificationRequests.size, history }); } catch { /* Sink failures do not change retrieval. */ }
    }
  } };
}
