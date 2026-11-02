import { describe, expect, it, vi } from 'vitest';
import { EcmsExpressTracker, normalizeEcmsExpressNumber, parseEcmsExpress } from './adapter.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { carrierAdapter } from '../../core/catalog/definitions.js';
import { isPartialAnswer } from '../../core/result/partial.js';

const NUMBER = 'ECTST00000000001';
const PARTNER = 'SPXTEST000000000001';
const opened = (suffix = '1') => ({ status: 200, message: 'SUCCESS', data: {
  signKey: `00000000-0000-4000-8000-00000000000${suffix}`, base64Data: 'data:image/png;BASE64,QUJD' } });
const verified = (suffix = '1') => ({ status: 200, message: 'SUCCESS', data: `synthetic-verification-sign-${suffix}` });
const refusal = { status: 200, message: 'check fail', error: '500', data: null };
const expired = { status: 500, message: 'verify failure' };
const row = () => ({ trackingId: NUMBER, eventCode: 'EVENT_301', eventDescription: 'Shipment delivered to customer',
  customDescription: 'PRIVATE', purchaseOrderNumber: 'PRIVATE', fileUrlList: ['PRIVATE'],
  operatorTime: Date.UTC(2026, 6, 4, 14, 10), timeZone: 0, createDateTime: Date.UTC(2026, 6, 5),
  cityEnName: 'Example City', provinceEnName: '', countryEnName: 'US', source: 'dc_PN_SpeedX', orderCode: PARTNER });
const fixture = () => ({ status: 200, orderNumber: [NUMBER], eseFreightUrl: 'PRIVATE', eseTaxesUrl: 'PRIVATE', orderInfo: [{
  baseInfo: row(), consigneeCountry: 'US', vendorConfig: { name: 'SpeedX', url: 'PRIVATE' },
  infoList: [row(), { ...row(), eventCode: 'EVENT_314', eventDescription: 'Flight arrival', operatorTime: Date.UTC(2026, 6, 3, 10), timeZone: -8, source: 'APS' },
    { ...row(), eventCode: 'EVENT_201', eventDescription: 'Shipment arrived at origin facility.', operatorTime: Date.UTC(2026, 6, 2, 9), timeZone: 9, source: 'OMSBUSINESS' }],
}] });

describe('ECMS history', () => {
  it('keeps complete history, carrier offsets and local partner clocks, discarding private extras', () => {
    const result = parseEcmsExpress(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-07-04T14:10:00', destination_country: 'US', delivery_carrier: 'speedx', delivery_tracking_number: PARTNER });
    expect(result.events).toHaveLength(3);
    expect(result.events![0]).toMatchObject({ local_time: '2026-07-04T14:10:00', provider_code: 'EVENT_301', stage_source: 'carrier_map' });
    expect(result.events![0]!.time).toBeUndefined();
    expect(result.events![1]).toMatchObject({ local_time: '2026-07-03T10:00:00', time: '2026-07-03T10:00:00-08:00' });
    expect(result.events![2]).toMatchObject({ local_time: '2026-07-02T09:00:00', time: '2026-07-02T09:00:00+09:00' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(isPartialAnswer(result)).toBe(false);
  });

  it('binds the whole envelope, summary and every scan before accepting history', () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => { data.orderNumber[0] += '0'; },
      (data: ReturnType<typeof fixture>) => { data.orderInfo[0]!.baseInfo.trackingId += '0'; },
      (data: ReturnType<typeof fixture>) => { data.orderInfo[0]!.infoList[1]!.trackingId += '0'; },
    ]) {
      const data = fixture(); change(data);
      expect(() => parseEcmsExpress(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('distinguishes absence, no history, challenges, limits and malformed replies', () => {
    const noHistory = fixture(); noHistory.orderInfo[0]!.infoList = [];
    for (const [data, kind] of [
      [{ status: 200, orderNumber: [], orderInfo: [] }, 'not_found'], [noHistory, 'indeterminate'],
      [expired, 'challenge'], [{ status: 429 }, 'rate_limited'], [{ status: 200 }, 'schema'],
      [{ status: 500, orderInfo: [] }, 'indeterminate'],
    ]) expect(() => parseEcmsExpress(data, NUMBER)).toThrow(expect.objectContaining({ kind }));
    const data = fixture(); data.orderInfo[0]!.infoList[0]!.operatorTime = NaN;
    expect(() => parseEcmsExpress(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('registers the parcel on the manifest in the newer page\'s wording', () => {
    const data = fixture();
    const manifest = { ...row(), eventCode: 'EVENT_104', eventDescription: 'Virtual Manifest has been received', operatorTime: Date.UTC(2026, 6, 1, 9), timeZone: 8 };
    data.orderInfo[0]!.baseInfo = manifest;
    data.orderInfo[0]!.infoList = [manifest];
    expect(parseEcmsExpress(data, NUMBER)).toMatchObject({ current_stage: 'registered',
      events: [{ provider_code: 'EVENT_104', stage: 'registered', stage_source: 'carrier_map' }] });
  });

  it('does not mislabel new wording or invent an unambiguous partner reference', () => {
    const data = fixture();
    data.orderInfo[0]!.baseInfo = { ...row(), eventCode: 'NEW', eventDescription: 'Unmapped milestone' };
    data.orderInfo[0]!.infoList.push({ ...row(), orderCode: PARTNER + '0' });
    const result = parseEcmsExpress(data, NUMBER);
    expect(result.current_stage).toBeUndefined(); expect(result.status).toBe('unknown');
    expect(result.delivery_carrier).toBe('speedx'); expect(result.delivery_tracking_number).toBeUndefined();
  });

  it('marks capped histories partial and validates scans beyond the cap', () => {
    const data = fixture(); data.orderInfo[0]!.infoList = Array.from({ length: 101 }, row);
    expect(parseEcmsExpress(data, NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseEcmsExpress(data, NUMBER).events).toHaveLength(100);
    data.orderInfo[0]!.infoList[100]!.trackingId += '0';
    expect(() => parseEcmsExpress(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('routes the existing whole-number shapes to the dedicated adapter', () => {
    for (const number of [NUMBER, 'APTEST0000000001', 'AXTESTS000000001', 'ESTST00000000001']) {
      expect(normalizeEcmsExpressNumber(number.toLowerCase())).toBe(number);
      expect(detectCarrierMatch(number).carrier).toBe('ecms-express');
    }
    expect(carrierAdapter('ecms-express')).toBe('ecms-express');
    expect(() => normalizeEcmsExpressNumber(NUMBER + '0')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('ECMS challenge exchange', () => {
  const responses = (...payloads: unknown[]) => {
    const fetcher = vi.fn<typeof fetch>();
    for (const payload of payloads) fetcher.mockResolvedValueOnce(Response.json(payload));
    return fetcher;
  };

  it('exchanges each fresh image for one sign, then consumes it once with the full number', async () => {
    const fetcher = responses(opened(), verified(), fixture(), opened('2'), verified('2'), fixture());
    const solveCaptcha = vi.fn().mockResolvedValue('8');
    const tracker = new EcmsExpressTracker({ fetcher, solveCaptcha, userAgent: 'TestHost/1' });
    await tracker.fetch(NUMBER); await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://www.ecmsglobal.com');
      expect(init?.method).toBe('POST'); expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('User-Agent')).toBe('TestHost/1');
    }
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('signKey')).toBe(opened().data.signKey);
    const lookup = new URL(String(fetcher.mock.calls[2]![0]));
    expect(lookup.searchParams.get('verifySign')).toBe(verified().data);
    expect(lookup.searchParams.get('orderNumber')).toBe(NUMBER);
    expect(new URL(String(fetcher.mock.calls[5]![0])).searchParams.get('verifySign')).toBe(verified('2').data);
    expect(solveCaptcha.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it('opens a fresh challenge after a rejected answer or expired sign', async () => {
    for (const first of [[opened(), refusal], [opened(), verified(), expired]]) {
      const fetcher = responses(...first, opened('2'), verified('2'), fixture());
      const step = vi.fn(), lookup = vi.fn();
      await expect(new EcmsExpressTracker({ fetcher, solveCaptcha: async () => '7', recorder: { step, lookup } }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(step.mock.calls[0]![0]).toMatchObject({ step: 'direct', outcome: 'challenge' });
      expect(step.mock.calls[1]![0]).toMatchObject({ step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'challenge' });
      expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', attempts: 2 }));
      const requests = fetcher.mock.calls.map(([url]) => new URL(String(url)));
      expect(requests.filter(url => url.pathname.endsWith('/get/base64'))).toHaveLength(2);
      expect(requests.filter(url => url.pathname.endsWith('/check')).at(-1)!.searchParams.get('signKey')).toBe(opened('2').data.signKey);
    }
  });

  it('bounds unreadable and rejected challenges and does not retry unrelated failures', async () => {
    const unreadable = responses(opened(), opened('2'));
    await expect(new EcmsExpressTracker({ fetcher: unreadable, solveCaptcha: async () => '' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(unreadable).toHaveBeenCalledTimes(2);
    const rejected = responses(opened(), refusal, opened('2'), refusal);
    await expect(new EcmsExpressTracker({ fetcher: rejected, solveCaptcha: async () => '7' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(rejected).toHaveBeenCalledTimes(4);
    for (const [payload, kind] of [[{ status: 429 }, 'rate_limited'], [{ status: 200 }, 'schema'], [{ status: 500, message: 'backend unavailable' }, 'indeterminate']]) {
      const fetcher = responses(opened(), payload);
      await expect(new EcmsExpressTracker({ fetcher, solveCaptcha: async () => '7' }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('keeps HTML challenges and malformed JSON distinct and strips verification diagnostics', async () => {
    for (const [body, status, kind] of [['<html>PRIVATE</html>', 200, 'challenge'], ['{"PRIVATE":', 200, 'schema'], ['PRIVATE', 503, 'maintenance']] as const) {
      const fetcher = responses(opened(), verified());
      fetcher.mockResolvedValueOnce(new Response(body, { status }));
      const error = await new EcmsExpressTracker({ fetcher, solveCaptcha: async () => '7' }).fetch(NUMBER).catch(error => error);
      expect(error.kind).toBe(kind);
      expect(error.request_url).toBeUndefined(); expect(error.response_body).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('PRIVATE'); expect(JSON.stringify(error)).not.toContain(verified().data);
    }
  });

  it('shares the deadline with OCR and stops before consuming a sign when cancelled', async () => {
    const controller = new AbortController();
    const fetcher = responses(opened());
    const solveCaptcha = vi.fn(async (_bytes: Uint8Array, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false); controller.abort(new Error('cancelled')); return '7';
    });
    await expect(new EcmsExpressTracker({ fetcher, solveCaptcha }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const stalled = new EcmsExpressTracker({ fetcher: responses(opened()), solveCaptcha: (_bytes, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    await expect(stalled.fetch(NUMBER, { budgetMs: 40 })).rejects.toMatchObject({ kind: 'budget' });
  });
});
