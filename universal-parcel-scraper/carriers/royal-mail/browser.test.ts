import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureRoyalMailReply, royalMailBrowserUserAgent, royalMailTrackingForm } from './browser.js';
import { royalMailEventsApiUrl, royalMailSummaryApiUrl } from './parser.js';
import { ChallengeError } from '../../core/errors/index.js';

// Synthetic references and data; issued API sessions never enter fixtures.
const NUMBER = 'SG999999999GB';
const URL = royalMailSummaryApiUrl(NUMBER);
const payload = { mailPieces: { mailPieceId: NUMBER, summary: { statusCategory: 'Delivered' },
  recipient: 'PRIVATE RECIPIENT', apiSession: 'PRIVATE SESSION' } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('uses the remote browser platform and always releases its metadata session', async () => {
  const cdp = { send: vi.fn(async () => ({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 HeadlessChrome/155.0.1.2 Safari/537.36' })), detach: vi.fn(async () => {}) };
  const remote = { version: () => '155.0.1.2', newBrowserCDPSession: async () => cdp };
  await expect(royalMailBrowserUserAgent(remote as never, true)).resolves.toBe(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36');
  expect(cdp.detach).toHaveBeenCalledOnce();
  cdp.send.mockResolvedValueOnce({ userAgent: 'PRIVATE' });
  await expect(royalMailBrowserUserAgent(remote as never, true)).rejects.toMatchObject({ kind: 'schema' });
  expect(cdp.detach).toHaveBeenCalledTimes(2);
});

function harness(phase: 'summary' | 'events' = 'summary') {
  const emitter = new EventEmitter();
  const frame = {};
  const captcha = { visible: false, withheld: false };
  const page = Object.assign(emitter, { mainFrame: () => frame, locator: (selector: string) => ({ count: async () =>
    (captcha.visible && selector.includes('frame=challenge')) || (captcha.withheld && selector.includes('data-ta-src')) ? 1 : 0 }) }) as unknown as Page;
  const target = phase === 'summary' ? URL : royalMailEventsApiUrl(NUMBER);
  const request = (url = target, method = 'GET', ownFrame = true, errorText = 'PRIVATE TOKEN in request URL') => ({ url: () => url,
    method: () => method, resourceType: () => 'xhr', frame: () => ownFrame ? frame : {}, failure: () => ({ errorText }) }) as Request;
  const respond = async (data: unknown, options: { status?: number; headers?: Record<string, string>; url?: string;
    method?: string; ownFrame?: boolean; body?: () => Promise<Buffer> } = {}) => {
    emitter.emit('response', { request: () => request(options.url, options.method, options.ownFrame),
      status: () => options.status ?? 200, headers: () => ({ 'content-type': 'application/json', ...options.headers }),
      body: options.body ?? (async () => Buffer.from(JSON.stringify(data))),
    });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000, recover?: Parameters<typeof captureRoyalMailReply>[7]) =>
    captureRoyalMailReply(page, target, NUMBER, phase, controller.signal, timeout, trigger, recover);
  return { emitter, respond, request, controller, capture, captcha };
}

describe('Royal Mail browser response capture', () => {
  it('binds method, URL, frame and identity, and omits top-level private fields', async () => {
    const h = harness();
    const result = await h.capture(async () => {
      await h.respond(payload, { method: 'OPTIONS', status: 401 });
      await h.respond(payload, { url: URL.replace(NUMBER, 'SG999999998GB') });
      await h.respond(payload, { ownFrame: false });
      await h.respond(payload);
    });
    expect(result).toEqual({ mailPieceId: NUMBER, summary: { statusCategory: 'Delivered' }, estimatedDelivery: undefined });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it.each([
    { mailPieces: { mailPieceId: 'SG999999998GB', summary: {} } },
    { mailPieces: [{ mailPieceId: NUMBER, summary: {} }] },
    { mailPieces: { mailPieceId: NUMBER, summary: null } },
  ])('rejects invalid summary identity or schema before details: %j', async data => {
    const h = harness();
    await expect(h.capture(() => h.respond(data))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('retains a legitimate empty events feed for the summary-only parser policy', async () => {
    const h = harness('events');
    await expect(h.capture(() => h.respond({ mailPieces: { mailPieceId: NUMBER, events: [], recipient: 'PRIVATE' } })))
      .resolves.toEqual({ mailPieceId: NUMBER, events: [] });
  });

  it('retains only the details estimate date for normalization', async () => {
    const h = harness('events');
    await expect(h.capture(() => h.respond({ mailPieces: { mailPieceId: NUMBER, events: [],
      estimatedDelivery: { date: '2026-01-03', private: 'PRIVATE' } } })))
      .resolves.toEqual({ mailPieceId: NUMBER, events: [], estimatedDelivery: { date: '2026-01-03' } });
  });

  it('retains only the destination country from the details summary', async () => {
    const h = harness('events');
    await expect(h.capture(() => h.respond({ mailPieces: { mailPieceId: NUMBER, events: [], summary: {
      destinationCountryCode: 'US', destinationCountryName: 'PRIVATE', deliveredInfo: 'PRIVATE', productName: 'PRIVATE' } } })))
      .resolves.toEqual({ mailPieceId: NUMBER, events: [], summary: { destinationCountryCode: 'US' } });
    const other = harness('events');
    await expect(other.capture(() => other.respond({ mailPieces: { mailPieceId: NUMBER, events: [], summary: { destinationCountryCode: 'PRIVATE' } } })))
      .resolves.toEqual({ mailPieceId: NUMBER, events: [] });
  });

  it.each([[401, 'challenge'], [404, 'transport'], [410, 'transport']])('classifies a non-JSON HTTP %s without reading private HTML', async (status, kind) => {
    const h = harness();
    const body = vi.fn(async () => Buffer.from('PRIVATE HTML'));
    await expect(h.capture(() => h.respond({}, { status, headers: { 'content-type': 'text/html' }, body })))
      .rejects.toMatchObject({ kind });
    expect(body).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, Array.from({ length: 501 }, () => ({}))])('rejects malformed or excessive history: %j', async events => {
    const h = harness('events');
    await expect(h.capture(() => h.respond({ mailPieces: { mailPieceId: NUMBER, events } })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('lets the page refresh one rejected session and accepts its next matching response', async () => {
    const h = harness();
    await expect(h.capture(async () => {
      await h.respond({ errors: [{ errorCode: 'E0015' }] }, { status: 401 });
      await h.respond(payload);
    })).resolves.toHaveProperty('mailPieceId', NUMBER);
  });

  it('ends a repeated session rejection without launching another lookup', async () => {
    const h = harness();
    await expect(h.capture(async () => {
      await h.respond({ errors: [{ code: 'E0015' }] }, { status: 401 });
      await h.respond({ errors: [{ code: 'E0015' }] }, { status: 401 });
    })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([
    [403, {}, 'challenge'], [429, {}, 'rate_limited'], [500, {}, 'indeterminate'],
    [404, {}, 'transport'], [404, { errors: [{ errorCode: 'E1142' }] }, 'indeterminate', 'portal_not_found'],
    [404, { errors: [{ errorCode: 'E1283' }] }, 'indeterminate'], [404, { errors: [{ errorCode: 'E9999' }] }, 'transport'],
    [200, { error: 'unknown provider error' }, 'indeterminate'],
  ])('keeps HTTP %s failures distinct', async (status, body, kind, reason?: string) => {
    const h = harness();
    const result = h.capture(() => h.respond(body, { status, headers: { 'retry-after': '45' } }));
    await expect(result).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 45_000 } : {}) });
    // Only Royal Mail's answer for a reference it does not know is an answer about the parcel.
    expect((await result.catch((error: unknown) => error) as { reason?: string }).reason).toBe(reason);
  });

  it('rejects declared oversized data before reading and decoded oversized data before parsing', async () => {
    for (const declared of [true, false]) {
      const h = harness();
      const body = vi.fn(async () => Buffer.alloc(2_000_001));
      await expect(h.capture(() => h.respond({}, { body, headers: declared ? { 'content-length': '2000001' } : {} })))
        .rejects.toMatchObject({ kind: 'schema' });
      expect(body).toHaveBeenCalledTimes(declared ? 0 : 1);
    }
  });

  it('sanitizes browser request failures and detaches every listener', async () => {
    const h = harness();
    const result = h.capture(async () => { h.emitter.emit('requestfailed', h.request()); });
    await expect(result).rejects.toMatchObject({ kind: 'transport', message: 'Royal Mail tracking request failed' });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('reports the edge resetting the tracking request as a challenge', async () => {
    const h = harness();
    const result = h.capture(async () => { h.emitter.emit('requestfailed', h.request(URL, 'GET', true, 'net::ERR_HTTP2_PROTOCOL_ERROR')); });
    await expect(result).rejects.toMatchObject({ kind: 'challenge', message: "Royal Mail's edge refused the tracking request" });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('reports a visible CAPTCHA challenge instead of waiting for the reply', async () => {
    const h = harness();
    const result = h.capture(async () => { h.captcha.visible = true; }, 5000);
    await expect(result).rejects.toMatchObject({ kind: 'challenge', message: 'Royal Mail asked for an interactive CAPTCHA' });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('recovers in the same capture and still binds the whole parcel history', async () => {
    const h = harness();
    h.captcha.visible = true;
    const recover = vi.fn(async () => { h.captcha.visible = false; await h.respond(payload); return true; });
    await expect(h.capture(async () => {}, 1000, recover)).resolves.toHaveProperty('mailPieceId', NUMBER);
    expect(recover).toHaveBeenCalledOnce();
    const [signal, remaining] = recover.mock.calls[0] as unknown as [AbortSignal, number];
    expect(signal.aborted).toBe(true);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(1000);
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('never accepts another parcel after successful verification', async () => {
    const h = harness();
    h.captcha.visible = true;
    await expect(h.capture(async () => {}, 1000, async () => {
      h.captcha.visible = false;
      await h.respond({ mailPieces: { mailPieceId: 'SG999999998GB', summary: {} } });
      return true;
    })).rejects.toMatchObject({ kind: 'schema' });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('does not confuse a disappearing challenge with matching tracking history', async () => {
    const h = harness();
    h.captcha.visible = true;
    const recover = vi.fn(async () => { h.captcha.visible = false; return true; });
    await expect(h.capture(async () => {}, 20, recover)).rejects.toMatchObject({ kind: 'challenge' });
    expect(recover).toHaveBeenCalledOnce();
  });

  it('retains a real verification refusal and ends the capture', async () => {
    const h = harness();
    h.captcha.visible = true;
    const refusal = new ChallengeError('Royal Mail', 'Verification refused', { reason: 'captcha_refused' });
    await expect(h.capture(async () => {}, 1000, async () => { throw refusal; })).rejects.toBe(refusal);
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('does not invoke visual recovery after an HTTP refusal', async () => {
    const h = harness();
    const recover = vi.fn(async () => true);
    await expect(h.capture(() => h.respond({}, { status: 403 }), 1000, recover)).rejects.toMatchObject({ kind: 'challenge' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('ends at once when the consent manager withholds the CAPTCHA the page waits for', async () => {
    const h = harness();
    const result = h.capture(async () => { h.captcha.withheld = true; }, 5000);
    await expect(result).rejects.toMatchObject({ kind: 'schema', message: "Royal Mail's cookie consent withheld its CAPTCHA" });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('honors cancellation before submission', async () => {
    const h = harness();
    const reason = new Error('cancelled');
    h.controller.abort(reason);
    const submit = vi.fn(async () => {});
    await expect(h.capture(submit)).rejects.toBe(reason);
    expect(submit).not.toHaveBeenCalled();
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('bounds a missing reply and quarantines a decoded body that arrives after cancellation', async () => {
    const missing = harness();
    await expect(missing.capture(async () => {}, 10)).rejects.toMatchObject({ kind: 'transport' });
    expect(missing.emitter.eventNames()).toEqual([]);
    const h = harness();
    let release!: (value: Buffer) => void;
    const body = new Promise<Buffer>(resolve => { release = resolve; });
    const result = h.capture(() => h.respond(payload, { body: () => body }));
    await tick();
    const reason = new Error('cancelled');
    h.controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    release(Buffer.from(JSON.stringify(payload)));
    await tick();
    expect(h.emitter.eventNames()).toEqual([]);
  });
});

describe('Royal Mail tracking form', () => {
  // A page showing either the form or the application's outage heading.
  const page = (outage: boolean) => {
    const node = (kind: 'input' | 'outage' | 'either'): unknown => ({ filter: () => node('outage'), or: () => node('either'),
      first: () => node(kind), waitFor: async () => {}, isVisible: async () => kind === 'outage' ? outage : !outage });
    return { locator: (selector: string) => node(selector === '#barcode-input' ? 'input' : 'outage') } as unknown as Page;
  };

  it('ends at once as maintenance when the tracking application shows its outage page', async () => {
    await expect(royalMailTrackingForm(page(true), 1000)).rejects.toMatchObject({ kind: 'maintenance',
      message: 'Royal Mail tracking is temporarily unavailable' });
    await expect(royalMailTrackingForm(page(false), 1000)).resolves.toBeDefined();
  });
});
