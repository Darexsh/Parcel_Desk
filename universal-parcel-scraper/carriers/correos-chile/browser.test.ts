import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { fetchCorreosChileInBrowser, isCorreosChileTrackingRequest, solveCorreosChileWidget } from './browser.js';
import { parseCorreosChileBootstrap } from './parser.js';
import fixture from './fixtures/customs.json' with { type: 'json' };

vi.mock('../../core/transport/localBrowser.js', () => ({ withRemoteBrowser: vi.fn() }));
const NUMBER = 'SX000000005CL';
const PAGE = 'https://www.correos.cl/seguimiento-en-linea';
const HTML = readFileSync(new URL('./fixtures/bootstrap.html', import.meta.url), 'utf8');
const session = parseCorreosChileBootstrap(HTML);
const BODY = new URLSearchParams({ [session.numberField]: NUMBER }).toString();
afterEach(() => vi.clearAllMocks());

it('binds the tracking resource to the entire identifier and rejects alternate methods and duplicate inputs', () => {
  expect(isCorreosChileTrackingRequest(session.url, 'POST', BODY, NUMBER)).toBe(true);
  for (const [url, method, body] of [[session.url, 'GET', BODY], [session.url, 'POST', BODY + '&' + BODY],
    [session.url, 'POST', BODY.replace(NUMBER, NUMBER + '0')], [session.url.replace('www.correos.cl', 'example.test'), 'POST', BODY],
    [session.url.replace('cmd_resource_get_seguimientos', 'cmd_other'), 'POST', BODY], [session.url + '#fragment', 'POST', BODY]]) {
    expect(isCorreosChileTrackingRequest(url!, method!, body!, NUMBER)).toBe(false);
  }
});

function harness() {
  const emitter = new EventEmitter(), frame = {}, controller = new AbortController();
  let trigger: () => Promise<void> = async () => {};
  const input = { fill: vi.fn(async () => {}), inputValue: async () => NUMBER };
  const page = Object.assign(emitter, { mainFrame: () => frame, url: () => PAGE,
    goto: async () => ({ status: () => 200 }), content: async () => HTML, waitForFunction: vi.fn(async () => {}),
    locator: (selector: string) => selector.includes('flexdatalist') ? input : { click: async () => trigger() },
  });
  const context = { newPage: async () => page };
  const browser = { newContext: vi.fn(async () => context) };
  vi.mocked(withRemoteBrowser).mockImplementation(async (_options, run) => run({ browser: browser as never, signal: controller.signal, remainingMs: () => 5000 }));
  const respond = async (data: unknown = fixture, options: { body?: () => Promise<Buffer>; headers?: Record<string, string>; status?: number; ownFrame?: boolean; number?: string } = {}) => {
    emitter.emit('response', { url: () => session.url, request: () => ({ frame: () => options.ownFrame === false ? {} : frame,
      url: () => session.url, method: () => 'POST', postData: () => BODY.replace(NUMBER, options.number ?? NUMBER) }),
    status: () => options.status ?? 200, headers: () => options.headers ?? {}, body: options.body ?? (async () => Buffer.from(JSON.stringify(data))) });
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const fetch = (action: () => Promise<void>) => { trigger = action; return fetchCorreosChileInBrowser(NUMBER, 'ws://browser.test/synthetic', controller.signal, 5000); };
  return { fetch, respond, emitter, input, browser, controller };
}

it('observes before submitting, ignores unrelated replies and retains complete parser history without private fields', async () => {
  const h = harness();
  const result = await h.fetch(async () => {
    expect(h.emitter.listenerCount('response')).toBe(1);
    await h.respond(null, { ownFrame: false });
    await h.respond(null, { number: NUMBER + '1' });
    await h.respond();
  });
  expect(result.events).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(h.browser.newContext).toHaveBeenCalledWith({ serviceWorkers: 'block', acceptDownloads: false, locale: 'en-US' });
  expect(h.input.fill).toHaveBeenCalledWith(NUMBER, expect.any(Object));
  expect(h.emitter.eventNames()).toEqual([]);
});

it.each([[403, 'challenge'], [404, 'indeterminate'], [410, 'indeterminate'], [429, 'rate_limited'], [500, 'indeterminate']])('preserves HTTP %s errors and cooldowns', async (status, kind) => {
  const h = harness();
  const body = vi.fn(async () => Buffer.from('PRIVATE'));
  await expect(h.fetch(() => h.respond(null, { status, body, headers: { 'retry-after': '30' } }))).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 30_000 } : {}) });
  expect(body).not.toHaveBeenCalled();
  expect(h.emitter.eventNames()).toEqual([]);
});

it('rejects oversized replies before reading and sanitizes browser failures', async () => {
  const h = harness(), body = vi.fn(async () => Buffer.from('PRIVATE'));
  await expect(h.fetch(() => h.respond(null, { body, headers: { 'content-length': '6000001' } }))).rejects.toMatchObject({ kind: 'schema' });
  expect(body).not.toHaveBeenCalled();
  const other = harness();
  const error = await other.fetch(() => other.respond(null, { body: async () => { throw new Error('PRIVATE'); } })).catch(e => e);
  expect(error).toMatchObject({ kind: 'transport' });
  expect(JSON.stringify(error)).not.toContain('PRIVATE');
  expect(other.emitter.eventNames()).toEqual([]);
});

it('retains a rejected or missing text challenge as a challenge without exposing page diagnostics', async () => {
  const page = { frameLocator: () => ({ locator: () => ({}), getByRole: () => ({ click: async () => { throw new Error('PRIVATE frame'); } }) }) } as unknown as Page;
  const error = await solveCorreosChileWidget(page, new AbortController().signal, () => 5000).catch(e => e);
  expect(error).toMatchObject({ kind: 'challenge' });
  expect(JSON.stringify(error)).not.toContain('PRIVATE');
});

/** An hCaptcha text challenge whose sets of three questions are refused until `accepting`. */
function textChallenge(accepting: number) {
  const state = { set: 1, index: 0, input: '', checked: false, answers: [] as string[] };
  const prompt = () => `Duplicate every ${'abc'[state.index]} in abc${'z'.repeat(state.set)}. Write only the result.`;
  const visible = (ready: () => boolean) => ({ waitFor: async () => { if (!ready()) throw new Error('PRIVATE timeout'); } });
  const frame = {
    getByRole: () => ({ waitFor: async () => {}, fill: async (value: string) => { state.input = value; state.answers.push(value); } }),
    locator: (selector: string) => selector === '.button-submit' ? {
      getAttribute: async () => state.index === 2 ? 'Verify Answers' : `Next Challenge, page ${state.index + 1} of 3`,
      click: async () => {
        state.input = '';
        if (state.index < 2) state.index++;
        else if (state.set === accepting) state.checked = true;
        else [state.set, state.index] = [state.set + 1, 0];
      },
    } : { innerText: async () => selector === '#prompt-text' ? prompt() : 'Write the result' },
    waitForFunction: async (_: unknown, previous: string) => { if (state.input !== '' || state.checked || prompt() === previous) throw new Error('PRIVATE timeout'); },
  };
  const widget = { getByRole: () => ({ click: async () => {} }), locator: () => visible(() => state.checked) };
  const challenge = { getByRole: (role: string) => role === 'button' ? { ...visible(() => true), click: async () => {} } : { click: async () => {} } };
  const page = { frameLocator: (selector: string) => selector.includes('checkbox') ? widget : challenge,
    locator: () => ({ elementHandle: async () => ({ contentFrame: async () => frame }) }) } as unknown as Page;
  return { page, state };
}

it('answers the fresh set hCaptcha offers after a refused one, up to three sets while the lookup still fits', async () => {
  const second = textChallenge(2);
  await solveCorreosChileWidget(second.page, new AbortController().signal, () => 30_000);
  expect(second.state).toMatchObject({ checked: true, set: 2 });
  expect(second.state.answers).toEqual(['aabcz', 'abbcz', 'abccz', 'aabczz', 'abbczz', 'abcczz']);
  const never = textChallenge(4);
  const error = await solveCorreosChileWidget(never.page, new AbortController().signal, () => 30_000).catch(e => e);
  expect(error).toMatchObject({ kind: 'challenge', message: expect.stringContaining('Text verification was not accepted') });
  expect(JSON.stringify(error)).not.toContain('PRIVATE');
  expect(never.state.answers).toHaveLength(9);
  const late = textChallenge(2);
  await expect(solveCorreosChileWidget(late.page, new AbortController().signal, () => 15_000)).rejects.toMatchObject({ kind: 'challenge' });
  expect(late.state.answers).toHaveLength(3);
});

it('honors cancellation while a response is still being read', async () => {
  const h = harness();
  let finish!: (value: Buffer) => void;
  const body = new Promise<Buffer>(resolve => { finish = resolve; });
  const reason = new Error('stopped');
  const pending = h.fetch(async () => { await h.respond(null, { body: () => body }); h.controller.abort(reason); });
  await expect(pending).rejects.toBe(reason);
  finish(Buffer.from(JSON.stringify(fixture)));
  expect(h.emitter.eventNames()).toEqual([]);
});
