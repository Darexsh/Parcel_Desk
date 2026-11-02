import { describe, expect, it, vi } from 'vitest';
import { adapter, ViettelPostTracker, normalizeViettelPostNumber, parseViettelPost } from './adapter.js';
import { isPartialAnswer, fillPartialAnswer } from '../../core/result/partial.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const NUMBER = '000000000001';
const opened = (id = '00000000-0000-4000-8000-000000000001') => ({ status: 200, error: false,
  data: { id, captcha: 'data:image/png;base64,QUJD', expiredTime: 9_999_999_999_999, countTime: 600_000 } });
const fixture = () => ({ status: 200, error: false, message: 'OK', data: [{ MA_KIEN: NUMBER, MA_TRANGTHAI: 2,
  TIME_TRANGTHAI: '06/04/2026 08:31', NGAY_NHAP: '06/04/2026 08:31', GHI_CHU: 'Nhập phiếu gửi ',
  DICH_VU: 'Chuyển phát nhanh', BUUCUC_NHAN: 'PRIVATE', BUUCUC_DEN: 'PRIVATE' }] });
const refusal = { status: 201, error: true, message: 'Mã captcha không chính xác!' };

describe('Viettel Post legacy records', () => {
  it('keeps the bound record partial, with its local clock and service but no office or recipient details', () => {
    const result = parseViettelPost(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', provider_code: '2', summary_only: true,
      last_update: null, last_update_local: '2026-04-06T08:31:00', service_name: 'Chuyển phát nhanh' });
    expect(result.events).toEqual([{ local_time: '2026-04-06T08:31:00', description: 'Nhập phiếu gửi', provider_code: '2', stage: 'registered', stage_source: 'carrier_map' }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(isPartialAnswer(result)).toBe(true);
    const richer = { status: 'delivered' as const, current_stage: 'delivered', events: [
      { time: '2026-04-08T10:00:00+07:00', description: 'Delivered', stage: 'delivered' },
      { time: '2026-04-07T10:00:00+07:00', description: 'Out for delivery', stage: 'out_for_delivery' },
    ] };
    expect(fillPartialAnswer('viettel-post', NUMBER, result, richer)).toMatchObject({ status: 'delivered', service_name: 'Chuyển phát nhanh' });
  });

  it('requires a whole repeated identifier and valid status fields', () => {
    const wrong = fixture(); wrong.data[0]!.MA_KIEN += '0';
    expect(() => parseViettelPost(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const invalid = fixture(); invalid.data[0]!.TIME_TRANGTHAI = '31/02/2026 08:31';
    expect(() => parseViettelPost(invalid, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseViettelPost({ ...fixture(), data: [{ ...fixture().data[0], GHI_CHU: {} }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseViettelPost({ ...fixture(), data: [{ ...fixture().data[0], MA_KIEN: Number(NUMBER) }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('distinguishes a valid empty lookup, CAPTCHA refusal, limit and malformed reply', () => {
    expect(() => parseViettelPost({ ...fixture(), data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseViettelPost(refusal, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseViettelPost({ status: 429, error: true }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseViettelPost({ status: 200, error: false }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseViettelPost({ status: 500, error: true, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts the supported complete numeric and V identifiers without inventing carrier confidence', () => {
    expect(normalizeViettelPostNumber('v 00000000001')).toBe('V00000000001');
    expect(normalizeViettelPostNumber(NUMBER)).toBe(NUMBER);
    for (const value of ['00000000', '00000000000000', 'VN0000000001', 'A000000000001']) expect(() => normalizeViettelPostNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    const made = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    expect(made.recognize).toBeUndefined(); expect(made.recognizeWithBrowser).toBeUndefined();
  });
});

describe('Viettel Post challenge exchange', () => {
  it('uses a fresh cookie jar, then posts one number with the answer for that image', async () => {
    const initial = Response.json(opened(), { headers: { 'Set-Cookie': 'SERVERID=synthetic; Path=/' } });
    Object.defineProperty(initial, 'url', { value: 'https://api.viettelpost.vn/api/orders/getCaptcha' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(Response.json(fixture()));
    const solveCaptcha = vi.fn().mockResolvedValue('aB12');
    await expect(new ViettelPostTracker({ fetcher, solveCaptcha, userAgent: 'TestHost/1' }).fetch(NUMBER)).resolves.toMatchObject({ summary_only: true });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://api.viettelpost.vn/api/orders/viewTrackingOrders');
    expect(JSON.parse(String(init?.body))).toEqual({ id: opened().data.id, captcha: 'aB12', orders: NUMBER });
    expect(new Headers(init?.headers).get('Cookie')).toContain('SERVERID=synthetic');
    expect(new Headers(init?.headers).get('User-Agent')).toBe('TestHost/1');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(solveCaptcha.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('refreshes once after a rejected answer and never repeats changed schemas or upstream errors', async () => {
    const secondId = '00000000-0000-4000-8000-000000000002';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(opened())).mockResolvedValueOnce(Response.json(refusal))
      .mockResolvedValueOnce(Response.json(opened(secondId))).mockResolvedValueOnce(Response.json(fixture()));
    await expect(new ViettelPostTracker({ fetcher, solveCaptcha: async () => 'abcd' }).fetch(NUMBER)).resolves.toMatchObject({ summary_only: true });
    expect(JSON.parse(String(fetcher.mock.calls[3]![1]?.body)).id).toBe(secondId);
    fetcher.mockReset().mockResolvedValueOnce(Response.json(opened())).mockResolvedValueOnce(Response.json({ changed: true }));
    await expect(new ViettelPostTracker({ fetcher, solveCaptcha: async () => 'abcd' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds unreadable or refused answers, and retains no verification material in failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(opened()));
    await expect(new ViettelPostTracker({ fetcher, solveCaptcha: async () => '????' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset().mockResolvedValueOnce(Response.json(opened())).mockResolvedValueOnce(new Response('PRIVATE answer', { status: 429 }));
    try { await new ViettelPostTracker({ fetcher, solveCaptcha: async () => 'abcd' }).fetch(NUMBER); throw new Error('Expected refusal'); }
    catch (error) { expect(error).toMatchObject({ kind: 'rate_limited', diagnostics: undefined }); expect(JSON.stringify(error)).not.toContain('PRIVATE'); }
    fetcher.mockReset().mockResolvedValueOnce(new Response('<html>Blocked</html>'));
    await expect(new ViettelPostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
});
