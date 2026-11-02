import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { fetchWanbInBrowser, wanbGuestFlow } from './browser.js';
import { API, MAX_BYTES, ORIGIN, parseWanb } from './parser.js';

vi.mock('../../core/transport/localBrowser.js', () => ({ withRemoteBrowser: vi.fn() }));
const number = 'WNBZZ9990000001YQ';
const challenge = { Succeeded: false, Error: { Code: '0x110012' } };
const found = { Succeeded: true, Data: { TrackingNumber: number, Match: 'ParcelId', Status: 'InTransit',
  Metadata: { ShippingAddress: 'PRIVATE RECIPIENT' }, TrackPoints: [
    { Time: '2031-04-16T10:00:00Z', Content: 'In transit', Status: 'InTransit', Location: 'Example City' },
  ] } };
const reply = (value: unknown, status = 200, url = `${API}?TrackingNumber=${number}`, headers: Record<string, string> = {}) =>
  Object.defineProperty(new Response(JSON.stringify(value), { status, headers }), 'url', { value: url });

function harness(options: { version?: string; verification?: unknown; status?: number; oversize?: boolean; mismatch?: boolean; missing?: boolean } = {}) {
  const execute = vi.fn(async () => 'PRIVATE_TOKEN');
  const win = {};
  const document = {
    querySelector: (selector: string) => ({ value: selector === '#showCaptchaVersion' ? options.version ?? 'V3' : 'SYNTHETIC_PUBLIC_KEY_0000000000000000' }),
    createElement: () => ({ src: '', onload: () => {} }),
    head: { appendChild: (script: { onload: () => void }) => { Object.assign(win, { grecaptcha: { ready: (cb: () => void) => cb(), execute } }); script.onload(); } },
  };
  let calls = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith('/Home/CaptchaVerify?')) return reply(options.verification ?? { Succeeded: true }, options.status ?? 200, ORIGIN + url, { 'retry-after': '45' });
    if (++calls === 1) return reply(challenge);
    const payload = options.missing ? { Succeeded: true, Data: { TrackingNumber: number, Match: 'Unknown', Status: null, Metadata: null, TrackPoints: [] } } : found;
    return reply(payload, 200, `${API}?TrackingNumber=${options.mismatch ? number + '0' : number}`, options.oversize ? { 'content-length': String(MAX_BYTES + 1) } : {});
  });
  vi.stubGlobal('window', win); vi.stubGlobal('document', document); vi.stubGlobal('fetch', fetcher);
  const page = { goto: vi.fn(async () => ({ status: () => 200, url: (): string => `${ORIGIN}/`, headers: () => ({}) })),
    evaluate: vi.fn(async (fn: typeof wanbGuestFlow, args: Parameters<typeof wanbGuestFlow>[0]) => fn(args)) };
  vi.mocked(withRemoteBrowser).mockImplementation(async (opts, run) => run({ browser: { newContext: async () => ({ newPage: async () => page }) } as never,
    signal: opts.signal!, remainingMs: () => 3000 }));
  return { fetcher, execute, page, run: async () => parseWanb(await fetchWanbInBrowser(number, 'ws://browser.test/synthetic', new AbortController().signal, 5000), number) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('WanbExpress private browser flow', () => {
  it('runs verification in the page, binds the final reply and preserves clocks while omitting recipient data', async () => {
    const h = harness();
    const answer = await h.run();
    expect(answer).toMatchObject({ current_stage: 'in_transit', events: [{ time: '2031-04-16T10:00:00Z' }] });
    expect(JSON.stringify(answer)).not.toMatch(/PRIVATE|TOKEN/);
    expect(h.page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.objectContaining({ timeout: 3000 }));
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual([
      `/TrackPoints/Track?TrackingNumber=${number}`, '/Home/CaptchaVerify?token=PRIVATE_TOKEN&version=V3', `/TrackPoints/Track?TrackingNumber=${number}`,
    ]);
    expect(h.fetcher.mock.calls.every(call => (call as unknown as [string, RequestInit])[1]?.signal instanceof AbortSignal)).toBe(true);
    expect(h.execute).toHaveBeenCalledWith('SYNTHETIC_PUBLIC_KEY_0000000000000000', { action: 'submit' });
  });

  it.each([{ version: 'V2' }, { verification: { Succeeded: false } }])('retains the challenge when verification is unavailable or refused: %j', async options => {
    const h = harness(options);
    await expect(h.run()).rejects.toMatchObject({ kind: 'challenge' });
    expect(h.fetcher).toHaveBeenCalledTimes(options.version ? 1 : 2);
  });

  it('returns no verification credential or verification body from the page', async () => {
    harness();
    const captured = await wanbGuestFlow({ number, timeoutMs: 3000, maxBytes: MAX_BYTES });
    expect(captured.replies).toHaveLength(2);
    expect(captured.verification).toEqual({ status: 200, retryAfter: '45' });
    expect(JSON.stringify(captured)).not.toContain('PRIVATE_TOKEN');
  });

  it.each([
    [{ status: 429 }, 'rate_limited'], [{ status: 403 }, 'challenge'], [{ status: 503 }, 'maintenance'],
    [{ oversize: true }, 'transport'], [{ mismatch: true }, 'schema'], [{ missing: true }, 'not_found'],
  ] as const)('keeps retrieval failure distinct from an absent parcel: %j', async (options, kind) => {
    const h = harness(options);
    await expect(h.run()).rejects.toMatchObject({ kind, ...(kind === 'rate_limited' ? { retryAfterMs: 45000 } : {}) });
  });

  it('requires a successful official page before requesting a parcel', async () => {
    const h = harness();
    h.page.goto.mockResolvedValueOnce({ status: () => 200, url: () => 'https://other.test/', headers: () => ({}) });
    await expect(h.run()).rejects.toMatchObject({ kind: 'schema' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('bounds decoded bodies even without a declared length', async () => {
    const h = harness();
    h.fetcher.mockImplementationOnce(async () => reply({ data: 'X'.repeat(MAX_BYTES) }));
    await expect(h.run()).rejects.toMatchObject({ kind: 'transport' });
    expect(h.execute).not.toHaveBeenCalled();
  });
});
