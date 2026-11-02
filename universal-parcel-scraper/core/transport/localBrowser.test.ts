import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { carrierErrorKind, TransportError } from '../errors/index.js';
import { withLocalBrowser, withRemoteBrowser } from './localBrowser.js';
import { loadChromium } from './optional.js';

vi.mock('playwright-core', () => ({ chromium: { launch: vi.fn(), connect: vi.fn() } }));
vi.mock(import('./optional.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadChromium: vi.fn(actual.loadChromium) };
});

const options = { provider: 'Synthetic', executablePath: '/test/chromium', timeoutMs: 5_000 };
function browser() {
  const instance = { close: vi.fn(async () => {}) };
  vi.mocked(chromium.launch).mockResolvedValue(instance as never);
  return instance;
}
/** Long enough for a lookup that is free to launch to have done so. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 10));
afterEach(() => { vi.mocked(chromium.launch).mockReset(); vi.mocked(chromium.connect).mockReset(); vi.restoreAllMocks(); });

describe('private remote browser', () => {
  const remote = { provider: 'Synthetic', endpoint: 'ws://browser.invalid/PRIVATE_CAPABILITY', timeoutMs: 5_000 };

  it('connects without launching locally, then disconnects after the work', async () => {
    const instance = { close: vi.fn(async () => {}) };
    vi.mocked(chromium.connect).mockResolvedValue(instance as never);
    await expect(withRemoteBrowser(remote, async ({ browser }) => { expect(browser).toBe(instance); return 'served'; })).resolves.toBe('served');
    expect(chromium.connect).toHaveBeenCalledWith(remote.endpoint, { timeout: expect.any(Number), headers: { Host: 'localhost' } });
    expect(chromium.launch).not.toHaveBeenCalled();
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it('keeps capability URLs out of failed connection diagnostics', async () => {
    vi.mocked(chromium.connect).mockRejectedValue(new Error(remote.endpoint));
    const error = await withRemoteBrowser(remote, vi.fn()).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: 'transport', message: 'Synthetic browser service is unavailable' });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('PRIVATE_CAPABILITY');
    for (const endpoint of ['PRIVATE', 'https://browser.invalid/PRIVATE', 'ws://user:PRIVATE@browser.invalid/', 'ws://browser.invalid/#PRIVATE']) {
      await expect(withRemoteBrowser({ ...remote, endpoint }, vi.fn())).rejects.toThrow('Browser endpoint must be a WebSocket URL');
    }
    expect(chromium.connect).toHaveBeenCalledOnce();
  });

  it('returns cancellation promptly and closes a connection that arrives late', async () => {
    let connected!: (value: never) => void;
    vi.mocked(chromium.connect).mockImplementationOnce(() => new Promise(resolve => { connected = resolve; }));
    const controller = new AbortController();
    const work = vi.fn();
    const pending = withRemoteBrowser({ ...remote, signal: controller.signal }, work);
    await vi.waitFor(() => expect(connected).toBeTypeOf('function'));
    const reason = new Error('cancelled'); controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const late = { close: vi.fn(async () => {}) }; connected(late as never);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(work).not.toHaveBeenCalled();
    const next = { close: vi.fn(async () => {}) }; vi.mocked(chromium.connect).mockResolvedValueOnce(next as never);
    await expect(withRemoteBrowser(remote, async () => 'served')).resolves.toBe('served');
  });
});

describe('shared local browser', () => {
  it('runs waiting lookups in arrival order, one browser at a time', async () => {
    const instance = browser();
    const order: string[] = [];
    let open = 0;
    const lookup = (name: string) => withLocalBrowser(options, async () => {
      expect(++open).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      order.push(name);
      return name;
    });
    await expect(Promise.all([lookup('first'), lookup('second'), lookup('third')])).resolves.toEqual(['first', 'second', 'third']);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(instance.close).toHaveBeenCalledTimes(3);
  });

  it('keeps its turn until its browser has closed', async () => {
    let closed!: () => void;
    const slow = { close: vi.fn(() => new Promise<void>((resolve) => { closed = resolve; })) };
    vi.mocked(chromium.launch).mockResolvedValueOnce(slow as never);
    const first = withLocalBrowser(options, async () => 'first');
    await vi.waitFor(() => expect(slow.close).toHaveBeenCalledOnce());
    browser();
    const next = withLocalBrowser(options, async () => 'next');
    await turn();
    expect(chromium.launch).toHaveBeenCalledOnce();
    closed();
    await expect(first).resolves.toBe('first');
    await expect(next).resolves.toBe('next');
    expect(chromium.launch).toHaveBeenCalledTimes(2);
  });

  it('fails a waiting lookup with a budget error at its own deadline, without a launch', async () => {
    browser();
    let finish: (() => void) | undefined;
    const holder = withLocalBrowser(options, () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const run = vi.fn();
    const error = await withLocalBrowser({ ...options, timeoutMs: 20 }, run).catch((reason: unknown) => reason);
    expect(carrierErrorKind(error)).toBe('budget');
    expect(run).not.toHaveBeenCalled();
    // The lookup behind the one that left still waits for the holder.
    const behind = withLocalBrowser(options, async () => 'served');
    await turn();
    expect(chromium.launch).toHaveBeenCalledOnce();
    finish!();
    await holder;
    await expect(behind).resolves.toBe('served');
  });

  it('leaves the queue with the caller\'s reason and ends the work at the deadline', async () => {
    const instance = browser();
    let finish: (() => void) | undefined;
    const holder = withLocalBrowser(options, () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const controller = new AbortController();
    const waiting = withLocalBrowser({ ...options, signal: controller.signal }, async () => 'never');
    controller.abort(new Error('caller cancelled'));
    await expect(waiting).rejects.toThrow('caller cancelled');
    finish!();
    await holder;
    const stalled = await withLocalBrowser({ ...options, timeoutMs: 20 }, () => new Promise(() => {})).catch((reason: unknown) => reason);
    expect(carrierErrorKind(stalled)).toBe('budget');
    expect(instance.close).toHaveBeenCalledTimes(2);
    await expect(withLocalBrowser({ ...options, signal: AbortSignal.abort(new Error('already cancelled')) }, vi.fn())).rejects.toThrow('already cancelled');
    await expect(withLocalBrowser({ ...options, timeoutMs: 0 }, vi.fn())).rejects.toThrow(TypeError);
  });

  it('sends the browser through a configured proxy and refuses a malformed one before launching', async () => {
    browser();
    await withLocalBrowser({ ...options, proxy: ' socks5://10.0.0.1:1080 ' }, async () => {});
    expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ proxy: { server: 'socks5://10.0.0.1:1080' } }));
    await withLocalBrowser({ ...options, proxy: null }, async () => {});
    expect(vi.mocked(chromium.launch).mock.calls[1]![0]).not.toHaveProperty('proxy');
    for (const proxy of ['ftp://10.0.0.1:21', 'socks5://user:PRIVATE@10.0.0.1:1080', 'PRIVATE', 'http://10.0.0.1:8080/PRIVATE']) {
      const error = await withLocalBrowser({ ...options, proxy }, vi.fn()).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain('PRIVATE');
    }
    expect(chromium.launch).toHaveBeenCalledTimes(2);
  });

  it('reports a browser timeout that lands on the deadline as the budget running out', async () => {
    browser();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const outcome = (run: () => Promise<never>) => withLocalBrowser(options, run).catch((reason: unknown) => reason);
    // Playwright rounds the remaining budget down, so its own timer fires just before the deadline.
    const timeout = new Error('page.goto: Timeout 4998ms exceeded.');
    const atDeadline = (error: Error) => async () => { clock.mockReturnValue(4_998); throw error; };
    expect(carrierErrorKind(await outcome(atDeadline(timeout)))).toBe('budget');
    clock.mockReturnValue(0);
    vi.mocked(chromium.launch).mockImplementationOnce(atDeadline(new Error('browserType.launch: Timeout 4998ms exceeded.')));
    expect(carrierErrorKind(await outcome(vi.fn()))).toBe('budget');
    // A classified failure keeps its kind, and a failure with budget left is not a timeout of this lookup.
    clock.mockReturnValue(0);
    expect(carrierErrorKind(await outcome(atDeadline(new TransportError('Synthetic'))))).toBe('transport');
    clock.mockReturnValue(0);
    expect(await outcome(async () => { throw timeout; })).toBe(timeout);
  });

  it('answers a lookup cancelled while Chromium loads at once, and launches nothing for it', async () => {
    browser();
    let loaded: ((value: typeof chromium) => void) | undefined;
    vi.mocked(loadChromium).mockImplementationOnce(() => new Promise((resolve) => { loaded = resolve; }));
    const controller = new AbortController();
    const cancelled = withLocalBrowser({ ...options, signal: controller.signal }, vi.fn());
    await vi.waitFor(() => expect(loaded).toBeTypeOf('function'));
    controller.abort(new Error('cancelled during load'));
    await expect(cancelled).rejects.toThrow('cancelled during load');
    // Its turn is free: the next lookup does not wait for that load.
    await expect(withLocalBrowser(options, async () => 'served')).resolves.toBe('served');
    loaded!(chromium);
    await turn();
    expect(chromium.launch).toHaveBeenCalledOnce();
  });

  it('launches nothing for a lookup cancelled in the instant Chromium finishes loading', async () => {
    browser();
    const controller = new AbortController();
    vi.mocked(loadChromium).mockImplementationOnce(() => {
      const ready = Promise.resolve(chromium);
      void ready.then(() => controller.abort(new Error('cancelled after load')));
      return ready;
    });
    await expect(withLocalBrowser({ ...options, signal: controller.signal }, vi.fn())).rejects.toThrow('cancelled after load');
    await turn();
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('keeps its turn until a launch that outlived its lookup is closed', async () => {
    let resolveLaunch!: (value: never) => void;
    const late = { close: vi.fn(async () => {}) };
    vi.mocked(chromium.launch).mockImplementationOnce(() => new Promise((resolve) => { resolveLaunch = resolve; }));
    const controller = new AbortController();
    const cancelled = withLocalBrowser({ ...options, signal: controller.signal }, vi.fn());
    await vi.waitFor(() => expect(chromium.launch).toHaveBeenCalledOnce());
    controller.abort(new Error('cancelled during launch'));
    await expect(cancelled).rejects.toThrow('cancelled during launch');
    browser();
    const next = withLocalBrowser(options, async () => 'served');
    await turn();
    expect(chromium.launch).toHaveBeenCalledOnce();
    resolveLaunch(late as never);
    await expect(next).resolves.toBe('served');
    expect(late.close).toHaveBeenCalledOnce();
  });
});
