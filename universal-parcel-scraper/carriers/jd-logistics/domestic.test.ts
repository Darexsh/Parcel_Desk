import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { adapter, DECLINE_HOLD_MS, JdLogisticsTracker, MAX_DECLINE_HOLD_MS } from './adapter.js';
import { jdDomesticBrowser, JD_DOMESTIC_PROXY, JD_DOMESTIC_TRACK, parseJdDomestic } from './domestic.js';
import { TrawlClient } from '../../core/transport/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'JDJ146283975062', OTHER = 'JDJ257394086173';
const history = () => ({ code: 1, obj: [{ rawWaybillCode: NUMBER, exists: true, receiverName: 'PRIVATE',
  traceAllVoList: [{ categoryName: 'Delivered', traceVoList: [
    { operateMessage: '已签收，签收人：PRIVATE', createTime: '2026-04-03 12:30:00', trackDay: '1999-01-01', trackTime: '01:00', state: '9' },
    { operateMessage: 'In transit', trackDay: '2026-04-02', trackTime: '10:20', attachment: 'PRIVATE' },
  ] }] }] });
const empty = () => new Response(JSON.stringify({ code: 1, data: [] }));
function client(body: unknown = history(), extra = {}) {
  const trawl = new TrawlClient('https://browser.test');
  const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [{
    url: JD_DOMESTIC_TRACK, status: 200, body: JSON.stringify(body), headers: {}, truncated: false,
    base64Encoded: false, error: null, trackingNumberSubmitted: NUMBER, ...extra,
  }] } as never);
  return { trawl, scrape };
}

describe('JD domestic history', () => {
  it('binds the whole shipment, retains clocks and removes contact/recipient fields', () => {
    const result = parseJdDomestic(history(), NUMBER);
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).toMatchObject({ description: '已签收', local_time: '2026-04-03T12:30:00', provider_code: '9' });
    expect(result.events?.[1]).toMatchObject({ description: 'In transit', local_time: '2026-04-02T10:20:00' });
    expect(result.last_update).toBeNull(); expect(result.last_update_local).toBe('2026-04-03T12:30:00');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('preserves a stated offset and an epoch instead of guessing the locale as its zone', () => {
    const data = history(); data.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.createTime = '2026-04-03T12:30:00+03:00';
    expect(parseJdDomestic(data, NUMBER).events?.[0]?.time).toBe('2026-04-03T12:30:00+03:00');
    data.obj[0]!.traceAllVoList[0]!.traceVoList = [
      { operateMessage: 'Older', createTime: Date.parse('2026-04-02T10:00Z') },
      { operateMessage: 'Newest', createTime: Date.parse('2026-04-03T10:00Z') },
    ] as never;
    expect(parseJdDomestic(data, NUMBER).events?.map(e => e.description)).toEqual(['Newest', 'Older']);
  });

  it('does not turn an older courier-first row into the group\'s current delivered status', () => {
    const data = history();
    data.obj[0]!.traceAllVoList[0]!.traceVoList[1]!.operateMessage = '配送员PRIVATE正在为您派送，联系电话PRIVATE';
    const event = parseJdDomestic(data, NUMBER).events![1]!;
    expect(event.description).toBe('正在为您派送'); expect(event.stage).not.toBe('delivered');
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
  });

  it('stages Chinese scans by their state, the newest one setting the status, and drops a station phone', () => {
    const data = history();
    data.obj[0]!.traceAllVoList[0]!.traceVoList = [
      { operateMessage: '您的快件已送达，请开箱验视', trackDay: '2026-04-03', trackTime: '14:25', state: '10034' },
      { operateMessage: '您的快件正在派送中，请当面签收', trackDay: '2026-04-03', trackTime: '08:15', state: '11000' },
      { operateMessage: '您的快件已到达【示例站】，电话：PRIVATE', trackDay: '2026-04-03', trackTime: '06:47', state: '200000' },
      { operateMessage: '京东快件已取件', trackDay: '2026-04-01', trackTime: '10:05', state: 200001 },
      { operateMessage: '您的快件将由京东小哥PRIVATE揽收', trackDay: '2026-04-01', trackTime: '06:05', state: '200034' },
    ] as never;
    const result = parseJdDomestic(data, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['10034', 'delivered'], ['11000', 'out_for_delivery'], ['200000', 'in_transit'], ['200001', 'accepted'], ['200034', 'registered']]);
    expect(result.events?.[2]?.description).toBe('您的快件已到达【示例站】');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    for (const entry of statuses.entries) {
      if (/^\d+$/.test(entry.code ?? '') && entry.code!.length > 4) {
        expect(statusMapAnswer({ carrier: 'jd-logistics', providerCode: entry.code, description: '已到达' })).toEqual({ kind: 'mapped', stage: entry.stage });
      }
    }
  });

  it('refuses wrong identities, multiple records and malformed clocks', () => {
    const wrong = history(); wrong.obj[0]!.rawWaybillCode = OTHER;
    expect(() => parseJdDomestic(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const multi = history(); multi.obj.push(multi.obj[0]!);
    expect(() => parseJdDomestic(multi, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const bad = history(); bad.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.createTime = '2026-02-30 12:00:00';
    expect(() => parseJdDomestic(bad, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps usable history partial when a row is wordless or contains only private contact clauses', () => {
    for (const message of ['', '收件人：PRIVATE', 'Recipient name: PRIVATE', undefined]) {
      const data = history(); data.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.operateMessage = message as never;
      const result = parseJdDomestic(data, NUMBER);
      expect(result).toMatchObject({ history_truncated: true, current_stage: 'in_transit', events: [{ description: 'In transit' }] });
      expect(result.events).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  });

  it('does not turn all-wordless history into not-found or silently discard malformed rows', () => {
    const data = history();
    for (const row of data.obj[0]!.traceAllVoList[0]!.traceVoList) row.operateMessage = '';
    expect(() => parseJdDomestic(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    data.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.createTime = '2026-02-30 12:00:00';
    expect(() => parseJdDomestic(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const typed = history(); typed.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.operateMessage = {} as never;
    expect(() => parseJdDomestic(typed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const wrong = history(); wrong.obj[0]!.rawWaybillCode = OTHER;
    wrong.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.operateMessage = '';
    expect(() => parseJdDomestic(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts omitted rows toward the history bound', () => {
    const data = history();
    data.obj[0]!.traceAllVoList = Array.from({ length: 11 }, () => ({ categoryName: '', traceVoList:
      Array.from({ length: 200 }, () => ({ operateMessage: '', createTime: '2026-04-03 12:00:00' })) })) as never;
    expect(() => parseJdDomestic(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a session error or empty result inconclusive and requires a bound explicit missing verdict', () => {
    for (const data of [{ code: -200010, obj: [] }, { code: 1, obj: [] }]) {
      expect(() => parseJdDomestic(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseJdDomestic({ code: 1, obj: [{ rawWaybillCode: NUMBER, exists: false }] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = history(); empty.obj[0]!.traceAllVoList = [];
    expect(() => parseJdDomestic(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('marks a bounded long history partial rather than hiding the omitted scans', () => {
    const data = history(); data.obj[0]!.traceAllVoList[0]!.traceVoList = Array.from({ length: 101 }, (_, i) =>
      ({ operateMessage: `Synthetic step ${i}`, createTime: '2026-04-03 12:00:00' })) as never;
    expect(parseJdDomestic(data, NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseJdDomestic(data, NUMBER).events).toHaveLength(100);
  });
});

describe('JD domestic recovery boundaries', () => {
  it('keeps the partial-history flag through tracking recovery for provider completion', async () => {
    const data = history(); data.obj[0]!.traceAllVoList[0]!.traceVoList[0]!.operateMessage = '收件人：PRIVATE';
    const { trawl } = client(data);
    const result = await new JdLogisticsTracker({ trawl, fetcher: async () => empty() }).fetch(NUMBER);
    expect(result).toMatchObject({ history_truncated: true, events: [{ description: 'In transit' }] });
    expect(result.events).toHaveLength(1);
  });

  it('uses the browser only after an inconclusive international answer for a supported domestic shape', async () => {
    const { trawl, scrape } = client();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    const result = await new JdLogisticsTracker({ trawl, fetcher }).fetch(NUMBER);
    expect(result.events).toHaveLength(2); expect(fetcher).toHaveBeenCalledTimes(1); expect(scrape).toHaveBeenCalledTimes(1);
    expect(scrape.mock.calls[0]?.[0]).toMatchObject({ captureResponses: [JD_DOMESTIC_TRACK, JD_DOMESTIC_PROXY], skipHttp: true });
  });

  it('an abstention preserves a challenge for the provider fallback without another JD call', async () => {
    const { trawl, scrape } = client();
    scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [{ url: 'https://www.jdl.com/orderSearch/', status: 200,
      body: null, headers: {}, truncated: false, base64Encoded: false, error: 'jd-domestic-unreadable' }] } as never);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    await expect(new JdLogisticsTracker({ trawl, fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_unreadable' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(scrape).toHaveBeenCalledTimes(1);
  });

  it('leaves a waybill whose verification keeps declining to the providers for longer each time', async () => {
    const held = 'JDJ368405197284';
    let now = Date.parse('2026-04-03T08:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { trawl, scrape } = client();
      const decline = { tier: 3, statusCode: 200, capturedResponses: [{ url: 'https://www.jdl.com/orderSearch/', status: 200,
        body: null, headers: {}, truncated: false, base64Encoded: false, error: 'jd-domestic-unreadable' }] } as never;
      scrape.mockResolvedValue(decline);
      const tracker = new JdLogisticsTracker({ trawl, fetcher: async () => empty() });
      const declines = async (opened: number) => {
        await expect(tracker.fetch(held)).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_unreadable' });
        expect(scrape).toHaveBeenCalledTimes(opened);
      };
      await declines(1);
      now += DECLINE_HOLD_MS - 1;
      await declines(1);
      now += 1;
      await declines(2);
      now += 2 * DECLINE_HOLD_MS - 1;
      await declines(2);
      now += 1;
      await declines(3);
      now += MAX_DECLINE_HOLD_MS;
      await declines(4);
      now += MAX_DECLINE_HOLD_MS;
      scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [{ url: JD_DOMESTIC_TRACK, status: 200,
        body: JSON.stringify({ code: 1, obj: [{ rawWaybillCode: held, exists: false }] }), headers: {}, truncated: false,
        base64Encoded: false, error: null, trackingNumberSubmitted: held }] } as never);
      await expect(tracker.fetch(held)).rejects.toMatchObject({ kind: 'not_found' });
      scrape.mockResolvedValue(decline);
      await declines(6);
      now += DECLINE_HOLD_MS;
      await declines(7);
    } finally { vi.restoreAllMocks(); }
  });

  it('an older browser service or failed page setup stays a transport failure, not a false site challenge', async () => {
    const { trawl, scrape } = client();
    for (const capturedResponses of [[], [{ url: 'https://www.jdl.com/orderSearch/', status: 200, error: 'jd-domestic-unprepared' }]]) {
      scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses } as never);
      await expect(jdDomesticBrowser(trawl, NUMBER, new AbortController().signal, 20000)).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('a matching international answer takes precedence without any browser request', async () => {
    const { trawl, scrape } = client();
    const data = { code: 1, data: [{ waybillNo: NUMBER, waybillNum: 1, wayBillTrackItemDtoList: [{ waybillNo: NUMBER,
      trackNodeList: [{ operatorTime: '2026-04-03T12:00:00+08:00', operatorDesc: 'In transit' }] }] }] };
    const result = await new JdLogisticsTracker({ trawl, fetcher: async () => new Response(JSON.stringify(data)) }).fetch(NUMBER);
    expect(result.events).toHaveLength(1); expect(scrape).not.toHaveBeenCalled();
  });

  it('never changes an international answer or runs a browser on an unrelated shape or HTTP recognition', async () => {
    const { trawl, scrape } = client();
    const factory = adapter({ trawl, fetcher: async () => empty(), recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
    await expect(factory.recognize!(NUMBER, {})).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(scrape).not.toHaveBeenCalled();
    await expect(new JdLogisticsTracker({ trawl, fetcher: async () => empty() }).fetch('JDW146283975062'))
      .rejects.toMatchObject({ reason: 'portal_not_found' });
    expect(scrape).not.toHaveBeenCalled();
  });

  it('refuses an unbound capture and keeps a later refusal instead of an earlier history', async () => {
    const { trawl, scrape } = client(history(), { trackingNumberSubmitted: OTHER });
    await expect(jdDomesticBrowser(trawl, NUMBER, new AbortController().signal, 20000)).rejects.toMatchObject({ kind: 'schema' });
    scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [
      { url: JD_DOMESTIC_TRACK, status: 200, body: JSON.stringify(history()), trackingNumberSubmitted: NUMBER },
      { url: JD_DOMESTIC_TRACK, status: 403, body: null, trackingNumberSubmitted: NUMBER },
    ] } as never);
    await expect(jdDomesticBrowser(trawl, NUMBER, new AbortController().signal, 20000)).rejects.toMatchObject({ kind: 'challenge' });
  });
});
