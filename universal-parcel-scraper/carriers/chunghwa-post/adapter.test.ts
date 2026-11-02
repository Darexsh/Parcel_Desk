import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ChunghwaPostTracker, normalizeChunghwaPostNumber, parseChunghwaPost } from './adapter.js';
import { ChunghwaPostOcr } from './ocr.js';
import { statusMap } from './status.js';

const NUMBER = 'EE000000005TW';
const fixture = () => [{ header: { OutputType: 'Screen' }, body: { cptCheck: true, incorrectList: [], iType: 1,
  host_rs: { Status: 'S', MAILNO: NUMBER, ITEM: [
    { EVCODE: 'E', STATUS: '海關查驗', DATIME: '20260103102030', BRHNAT: '德國', 'REASON-E': 'PRIVATE', RCVMAN: 'PRIVATE' },
    { EVCODE: 'A', STATUS: '交寄郵件', DATIME: '20260101090000', BRHNAT: '郵件處理中心', SENDER: 'PRIVATE' },
  ] } } }];
const unknown = (number = NUMBER) => [{ header: { OutputType: 'Message' }, body: {
  msgCode: 'Z999', msgData: `${number}|CH|Z993|資料不存在！Tracking is not available for this item!`,
} }, { header: { OutputType: 'EndBracket' }, body: { result: 'success' } }];

describe('Chunghwa Post international tracking', () => {
  it('binds the item and preserves foreign local clocks, status and location without detail fields', () => {
    const result = parseChunghwaPost(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'customs', provider_code: 'E', last_update: null, last_update_local: '2026-01-03T10:20:30' });
    expect(result.events![0]).toMatchObject({ description: '海關查驗', location: '德國', local_time: '2026-01-03T10:20:30', stage: 'customs' });
    expect(result.events![1]).toMatchObject({ stage: 'accepted' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const row = fixture()[0]!;
    expect(parseChunghwaPost([{ ...row, body: { ...row.body, incorrectList: null } }], NUMBER).events).toHaveLength(2);
  });

  it('dates the scans of its own branches on Taiwan time and keeps scans abroad on their local clocks', () => {
    const items: Record<string, unknown>[] = [
      { EVCODE: 'E', STATUS: '海關查驗', DATIME: '20260103102000', BRHNAT: '德國', BRHNO: 'DEXXXA', POST_URL: 'https://post.example/' },
      { EVCODE: 'Y', STATUS: '郵袋接收', DATIME: '20260103064100', BRHNAT: '德國', BRHNO: '000001', POST_URL: 'https://post.example/' },
      { EVCODE: 'C', STATUS: '已出口－資料詳如右方', DATIME: '20260102184319', BRHNAT: '國際航空郵件科', BRHNO: 'TWXXXB', POST_URL: '' },
      { EVCODE: 'L', STATUS: '到達出口互換局', DATIME: '20260102085353', BRHNAT: '郵件處理中心', BRHNO: '000002' },
      { EVCODE: 'A', STATUS: '交寄郵件', DATIME: '20260101160803', BRHNAT: '郵局', BRHNO: '000003' },
      // A branch code the client does not read as a Taiwan branch, or none, settles no zone.
      { EVCODE: 'A', STATUS: '交寄郵件', DATIME: '20260101150000', BRHNAT: '郵局', BRHNO: 'XX0001' },
      { EVCODE: 'A', STATUS: '交寄郵件', DATIME: '20260101140000', BRHNAT: '郵局', BRHNO: 1 },
    ];
    const payload = fixture();
    (payload[0]!.body.host_rs as { ITEM: unknown[] }).ITEM = items;
    const result = parseChunghwaPost(payload, NUMBER);
    expect(result.events!.map((event) => event.time)).toEqual([undefined, undefined, '2026-01-02T10:43:19Z',
      '2026-01-02T00:53:53Z', '2026-01-01T08:08:03Z', undefined, undefined]);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-01-03T10:20:00', '2026-01-03T06:41:00',
      '2026-01-02T18:43:19', '2026-01-02T08:53:53', '2026-01-01T16:08:03', '2026-01-01T15:00:00', '2026-01-01T14:00:00']);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-01-03T10:20:00' });
    // An item still in Taiwan is dated by its newest scan.
    items.splice(0, 2);
    expect(parseChunghwaPost(payload, NUMBER)).toMatchObject({ last_update: '2026-01-02T10:43:19Z', last_update_local: '2026-01-02T18:43:19' });
  });

  it('stages the international scans by their wording', () => {
    const payload = fixture();
    (payload[0]!.body.host_rs as { ITEM: unknown[] }).ITEM = [
      { EVCODE: 'L', STATUS: '到達出口互換局', DATIME: '20260102085353', BRHNAT: '郵件處理中心', BRHNO: '000002' },
      { EVCODE: '6', STATUS: '離開進口局', DATIME: '20260101232400', BRHNAT: '郵件處理中心', BRHNO: '000002' },
      { EVCODE: 'A', STATUS: '交寄郵件', DATIME: '20260101160803', BRHNAT: '郵局', BRHNO: '000003' },
    ];
    expect(parseChunghwaPost(payload, NUMBER).events!.map((event) => [event.stage, event.stage_source]))
      .toEqual([['in_transit', 'carrier_map'], ['in_transit', 'carrier_map'], ['accepted', 'carrier_map']]);
    expect(statusMap.stage('6', '離開進口局')).toBe('in_transit');
  });

  it('stages delivery, an unsuccessful attempt and the steps before them in the destination country', () => {
    const payload = fixture();
    (payload[0]!.body.host_rs as { ITEM: unknown[] }).ITEM = [
      { EVCODE: 'I', STATUS: '投遞成功', DATIME: '20260108101500', BRHNAT: '德國' },
      { EVCODE: 'H', STATUS: '投遞不成功', DATIME: '20260107101500', BRHNAT: '德國' },
      { EVCODE: 'G', STATUS: '到達寄達國投遞局', DATIME: '20260106101500', BRHNAT: '德國' },
      { EVCODE: 'F', STATUS: '離開寄達國互換局', DATIME: '20260105101500', BRHNAT: '德國' },
    ];
    const result = parseChunghwaPost(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(result.events!.map((event) => event.stage)).toEqual(['delivered', 'failed_attempt', 'in_transit', 'in_transit']);
  });

  it('requires accepted verification and repeated identity, and recognizes only the matching absence message', () => {
    expect(() => parseChunghwaPost(unknown(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseChunghwaPost(unknown('EA000000005TW'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const refused = fixture(); refused[0]!.body.cptCheck = false;
    expect(() => parseChunghwaPost(refused, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const wrong = fixture(); wrong[0]!.body.host_rs.MAILNO = 'EA000000005TW';
    expect(() => parseChunghwaPost(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const invalid = fixture(); invalid[0]!.body.host_rs.ITEM[0]!.DATIME = '20260231090000';
    expect(() => parseChunghwaPost(invalid, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeChunghwaPostNumber('ee 000000005 tw')).toBe(NUMBER);
    expect(normalizeChunghwaPostNumber('EE000000006TW')).toBe('EE000000006TW');
    for (const value of ['00000000000001', 'PB00000000000']) expect(() => normalizeChunghwaPostNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('refuses domestic, proprietary and other S10 references before any request, even when already cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const carrier = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    for (const number of ['00000000000001', '00000000000000000001', 'PB00000000000', 'FT000000005CN', 'VA000000005TW', 'UA000000005TW', 'UH000000005CN']) {
      const refusal = { kind: 'invalid_input', message: expect.stringContaining('another tracking service') };
      await expect(new ChunghwaPostTracker({ fetcher }).fetch(number)).rejects.toMatchObject(refusal);
      await expect(carrier.track({ number }, { signal: AbortSignal.abort(), budgetMs: 1 })).rejects.toMatchObject(refusal);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['UH000000005TW', 'FT000000005TW', 'FZ000000005TW'])('queries %s, issued in Taiwan, through the same verified and identity-bound flow', async (number) => {
    const payload = fixture(); payload[0]!.body.host_rs.MAILNO = number;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response('image'))
      .mockResolvedValueOnce(Response.json(payload));
    await expect(new ChunghwaPostTracker({ fetcher, solveCaptcha: async () => '1234' }).fetch(number)).resolves.toMatchObject({ current_stage: 'customs' });
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).body.MAILNO).toBe(number);
    expect(() => parseChunghwaPost(fixture(), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('opens one cookie jar, solves a fresh image and submits the same challenge with the whole item', async () => {
    const opened = new Response('', { headers: { 'Set-Cookie': 'JSESSIONID=synthetic; Path=/pstmail' } });
    Object.defineProperty(opened, 'url', { value: 'https://postserv.post.gov.tw/pstmail/SessionServlet' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(opened).mockResolvedValueOnce(new Response('image')).mockResolvedValueOnce(Response.json(fixture()));
    await expect(new ChunghwaPostTracker({ fetcher, solveCaptcha: async () => '1234' }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'customs' });
    const imageUrl = new URL(String(fetcher.mock.calls[1]![0]));
    const init = fetcher.mock.calls[2]![1]!;
    expect(JSON.parse(String(init.body))).toMatchObject({ header: { TxnCode: 'EB500200', BizCode: 'query' },
      body: { MAILNO: NUMBER, captcha: '1234', uuid: imageUrl.searchParams.get('uuid') } });
    expect(new Headers(init.headers).get('Cookie')).toContain('JSESSIONID=synthetic'); expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries only an explicitly refused answer, and strips challenge diagnostics from HTTP failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response('image'))
      .mockResolvedValueOnce(Response.json([{ header: { OutputType: 'Screen' }, body: { cptCheck: false } }]))
      .mockResolvedValueOnce(new Response('image')).mockResolvedValueOnce(Response.json(fixture()));
    await expect(new ChunghwaPostTracker({ fetcher, solveCaptcha: async () => '1234' }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'customs' });
    const first = JSON.parse(String(fetcher.mock.calls[2]![1]?.body));
    const second = JSON.parse(String(fetcher.mock.calls[4]![1]?.body));
    expect(first.body.uuid).not.toBe(second.body.uuid);
    fetcher.mockReset().mockResolvedValue(new Response('PRIVATE', { status: 429 }));
    await expect(new ChunghwaPostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', diagnostics: undefined });
    fetcher.mockReset().mockResolvedValue(new Response('missing endpoint', { status: 404 }));
    await expect(new ChunghwaPostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('loads the shared model through the JPEG profile without accepting the Viettel image geometry', async () => {
    const worker = new ChunghwaPostOcr();
    try {
      const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="162" height="54"><rect width="162" height="54" fill="white"/><text x="32" y="40" font-family="serif" font-size="36" font-weight="bold">1234</text></svg>')).jpeg().toBuffer();
      expect(await worker.solve(image, AbortSignal.timeout(10_000))).toBe('1234');
      const other = await sharp({ create: { width: 200, height: 50, channels: 3, background: '#fff' } }).png().toBuffer();
      await expect(worker.solve(other, AbortSignal.timeout(2000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 15_000);
});
