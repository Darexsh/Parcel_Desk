import { describe, expect, it } from 'vitest';
import type { TrawlCapturedResponse, TrawlScrapeResponse } from '../../core/transport/index.js';
import { CHINA_POST_WEB_FLAG, CHINA_POST_WEB_TRACE, parseChinaPostWebPreview } from './web.js';

const number = 'ZS00000000001';
const scan = { number, time: '2030-01-02 12:30', code: 'O_051', state: '到达境外目的地' };
const entry = (payload: unknown = { success: true, match: true, scans: [scan] }, overrides = {}): TrawlCapturedResponse => ({
  url: CHINA_POST_WEB_TRACE, status: 200, body: JSON.stringify(payload), trackingNumberSubmitted: number,
  headers: {}, error: null, truncated: false, base64Encoded: false, ...overrides,
});
const page = (...capturedResponses: TrawlCapturedResponse[]): TrawlScrapeResponse => ({
  url: '', html: '', cookies: [], userAgent: null, tier: 3, statusCode: 200, raw: {}, capturedResponses,
});

describe('China Post public web preview', () => {
  it("keeps the carrier order and limited history, on China's clock", () => {
    const result = parseChinaPostWebPreview(page(entry({ success: true, match: true,
      scans: [{ ...scan, time: '2030-01-01 23:00:00' }, scan] })), number);
    expect(result).toMatchObject({ current_stage: 'in_transit', history_truncated: true, last_update: '2030-01-02T12:30:00+08:00',
      last_update_local: '2030-01-02T12:30:00', events: [{ local_time: '2030-01-02T12:30:00', time: '2030-01-02T12:30:00+08:00' },
        { local_time: '2030-01-01T23:00:00', time: '2030-01-01T23:00:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier' }] });
  });

  it('shows the state label in English, staged by the label', () => {
    const result = parseChinaPostWebPreview(page(entry({ success: true, match: true,
      scans: [{ ...scan, time: '2030-01-01 23:00', code: 'O_098', state: '未知状态' }, { ...scan, code: 'O_099', state: '待取件' }] })), number);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Awaiting collection' });
    expect(result.events!.map(row => [row.description, row.stage])).toEqual([['Awaiting collection', 'ready_for_pickup'], ['未知状态', undefined]]);
    // Its label for a failed delivery.
    expect(parseChinaPostWebPreview(page(entry({ success: true, match: true, scans: [{ ...scan, code: 'O_098', state: '派送异常' }] })), number))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Delivery failed' });
  });

  it('binds the request, every scan and the final response', () => {
    for (const row of [entry(undefined, { trackingNumberSubmitted: 'ZS00000000002' }), entry({ success: true, match: false }),
      entry({ success: true, match: true, scans: [{ ...scan, number: 'ZS00000000002' }] })]) {
      expect(() => parseChinaPostWebPreview(page(row), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseChinaPostWebPreview(page(entry(), entry(undefined, { status: 403 })), number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it.each([[429, 'rate_limited'], [503, 'maintenance'], [404, 'transport']] as const)('preserves HTTP %i as %s', (status, kind) => {
    expect(() => parseChinaPostWebPreview(page(entry(undefined, { status, headers: { 'retry-after': '30' } })), number))
      .toThrow(expect.objectContaining({ kind, ...(status === 429 ? { retryAfterMs: 30000 } : {}) }));
  });

  it.each([['phone', 'input_required'], ['verification', 'challenge'], ['empty', 'indeterminate'], ['rate_limit', 'rate_limited']] as const)('preserves a %s refusal', (reason, kind) => {
      expect(() => parseChinaPostWebPreview(page(entry({ success: false, reason }, { url: CHINA_POST_WEB_FLAG })), number))
        .toThrow(expect.objectContaining({ kind }));
    });

  it('refuses malformed, empty, private and impossible scans', () => {
    for (const value of [{ invalid: true }, { success: true, match: true, scans: [{ ...scan, time: '2030-02-30 12:00' }] },
      { success: true, match: true, scans: [{ ...scan, state: '联系快递员' }] }]) {
      expect(() => parseChinaPostWebPreview(page(entry(value)), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseChinaPostWebPreview(page(entry({ success: true, match: true, scans: [] })), number))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => parseChinaPostWebPreview(page(entry({ success: true, checked: true }, { url: CHINA_POST_WEB_FLAG })), number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
});
