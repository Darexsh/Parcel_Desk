import { createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { adapter, DEPPON_TRACKING_API, DepponTracker, normalizeDepponNumber, parseDeppon } from './adapter.js';
import { depponPuzzleOffset } from './challenge.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const NUMBER = '0000000001';
const KEY = 'synthetic-key-01';
const TOKEN = '00000000-0000-4000-8000-000000000001';
const shipment = () => ({ status: 'success', result: { billNo: NUMBER, receiverName: 'PRIVATE', receiverAddress: 'PRIVATE', tracks: [
  { operateTime: '2026-03-12 15:30:00', opreateType: 'SIGNED', contentNoLinkLabel: '已签收，签收人：PRIVATE' },
  { operateTime: '2026-03-12 09:20:00', opreateType: 'SENT_SCAN', contentNoLinkLabel: '正在派送 联系电话：13900000000' },
  { operateTime: '2026-03-11 18:00:00', opreateType: 'ARRIVAL', contentNoLinkLabel: '到达转运中心' },
] } });
const opened = () => ({ code: '0000', result: { secretKey: KEY, token: TOKEN, originalImageBase64: 'QUJD', jigsawImageBase64: 'QUJD' } });
const decode = (encoded: string) => {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(KEY), null);
  return Buffer.concat([decipher.update(encoded, 'base64'), decipher.final()]).toString();
};

describe('Deppon history', () => {
  it('binds the whole waybill, keeps local clocks and codes, and discards recipient data', () => {
    const result = parseDeppon(shipment(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-03-12T15:30:00' });
    expect(result.events?.map(event => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-03-12T15:30:00', 'SIGNED', 'delivered'], ['2026-03-12T09:20:00', 'SENT_SCAN', 'out_for_delivery'],
      ['2026-03-11T18:00:00', 'ARRIVAL', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|13900000000/);
    const wrong = shipment(); wrong.result.billNo += '0';
    expect(() => parseDeppon(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not inherit a transit stage from the website default icon', () => {
    const value = shipment(); value.result.tracks = [{ operateTime: '2026-03-12 15:30:00', opreateType: 'NEW_TYPE', contentNoLinkLabel: '新状态' }];
    const result = parseDeppon(value, NUMBER);
    expect(result.status).toBe('unknown'); expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('keeps missing parcels, verification refusals, limits and malformed data distinct', () => {
    expect(() => parseDeppon({ status: 'fail', result: null, message: '运单轨迹不存在，请检查运单号是否正确' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDeppon({ status: 'fail', result: null, message: '验证码错误' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDeppon({ status: 'fail', result: null, message: '您的操作过于频繁，请稍后重试' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseDeppon({}, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const invalid = shipment(); invalid.result.tracks[0]!.operateTime = '2026-02-31 15:30:00';
    expect(() => parseDeppon(invalid, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Deppon verification exchange', () => {
  it('requires accepted verification, then binds the tracking request to its single-use token and one waybill', async () => {
    const initial = Response.json(opened(), { headers: { 'Set-Cookie': 'SESSION=synthetic; Path=/' } });
    Object.defineProperty(initial, 'url', { value: 'https://www.deppon.com/gwapi/messageService/eco/message/captcha/getCaptchaAction' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(Response.json({ code: '0000' })).mockResolvedValueOnce(Response.json(shipment()));
    const solveCaptcha = vi.fn().mockResolvedValue(171);
    await expect(new DepponTracker({ fetcher, solveCaptcha, userAgent: 'TestHost/1' }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    const verify = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(decode(verify.pointJson)).toBe('{"x":171,"y":5}'); expect(verify.token).toBe(TOKEN);
    const [url, init] = fetcher.mock.calls[2]!;
    const request = JSON.parse(String(init?.body));
    expect(String(url)).toBe(DEPPON_TRACKING_API); expect(request.waybillNumber).toBe(NUMBER);
    expect(decode(request.code)).toBe(`${TOKEN}---{"x":171,"y":5}`); expect(request.value).toBe(request.code);
    expect(new Headers(init?.headers).get('Cookie')).toContain('SESSION=synthetic');
    for (const [, request] of fetcher.mock.calls) { expect(request?.signal).toBeInstanceOf(AbortSignal); expect(new Headers(request?.headers).get('User-Agent')).toBe('TestHost/1'); }
  });

  it('stops after a weak solution or refused verification, without asking for history', async () => {
    for (const offset of [null, 171]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(opened())).mockResolvedValueOnce(Response.json({ code: '0011', message: '验证失败' }));
      await expect(new DepponTracker({ fetcher, solveCaptcha: async () => offset }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
      expect(fetcher).toHaveBeenCalledTimes(offset === null ? 1 : 2);
    }
  });

  it('strips single-use material from rejected transport diagnostics and rejects blocked HTML', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(opened()))
      .mockResolvedValueOnce(new Response('PRIVATE verification state', { status: 429, headers: { 'Retry-After': '60' } }));
    try { await new DepponTracker({ fetcher, solveCaptcha: async () => 171 }).fetch(NUMBER); throw new Error('Expected refusal'); }
    catch (error) { expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000, diagnostics: undefined }); expect(JSON.stringify(error)).not.toContain('PRIVATE'); }
    fetcher.mockReset().mockResolvedValueOnce(new Response('<html>Blocked</html>'));
    await expect(new DepponTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps solving out of cheap recognition and validates before making a request', () => {
    const made = adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    expect(made.recognize).toBeUndefined(); expect(made.recognizeWithBrowser).toBeUndefined();
    expect(normalizeDepponNumber(' dpk 000000000001 ')).toBe('DPK000000000001');
    expect(() => normalizeDepponNumber('1234567')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('Deppon puzzle matching', () => {
  function puzzle(duplicate = false) {
    const width = 310, height = 155, pieceWidth = 47;
    const background = { width, height, data: new Uint8Array(width * height * 4) };
    const piece = { width: pieceWidth, height, data: new Uint8Array(pieceWidth * height * 4) };
    let seed = 123;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
    for (let i = 0; i < background.data.length; i += 4) { for (let c = 0; c < 3; c++) background.data[i + c] = random(); background.data[i + 3] = 255; }
    for (let y = 60; y < 100; y++) for (let x = 4; x < 43; x++) {
      const target = (y * width + 171 + x) * 4, source = (y * pieceWidth + x) * 4;
      for (let c = 0; c < 3; c++) { const color = random(); piece.data[source + c] = color; background.data[target + c] = Math.round(color * .65 + 5);
        if (duplicate) background.data[(y * width + 65 + x) * 4 + c] = background.data[target + c]!; }
      piece.data[source + 3] = 255;
    }
    return { background, piece };
  }
  it('finds a darkened texture match in native pixels and rejects competing slots', () => {
    const good = puzzle(); expect(depponPuzzleOffset(good.background, good.piece)).toBe(171);
    const ambiguous = puzzle(true); expect(depponPuzzleOffset(ambiguous.background, ambiguous.piece)).toBeNull();
    expect(depponPuzzleOffset({ ...good.background, width: 311 }, good.piece)).toBeNull();
    expect(depponPuzzleOffset(good.background, { ...good.piece, data: new Uint8Array(good.piece.data.length) })).toBeNull();
  });
});
