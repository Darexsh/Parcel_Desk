import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { J_AND_T_APP_ID, J_AND_T_SIGNING_KEY } from '../j-and-t-au/official.js';
import { adapter, J_AND_T_UK_API, JAndTUkTracker } from './adapter.js';
import { normalizeJAndTUkNumber, parseJAndTUk } from './parser.js';
import { jAndTUkStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic waybills in J&T Express UK's layout; none is a real parcel.
const IN_TRANSIT = 'JTUK031415926535';
const FAILED = 'JTUK023450789013';
const UNKNOWN = 'JTUK000000000000';

type Row = Record<string, unknown>;
type Answer = Row & { details: Row[] };
type Reply = Row & { data: Answer[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (answer: Answer, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('J&T Express UK HTTP adapter', () => {
  it('posts the whole waybill as the UK page does, signed over its sorted fields, once through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('failed-delivery')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JAndTUkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jtuk 0234-5078-9013 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'failed_attempt' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(J_AND_T_UK_API);
    expect(J_AND_T_UK_API).toBe('https://official.jtexpress.uk/official/logisticsTracking/getDetailByWaybillNo');
    const headers = init!.headers as Record<string, string>;
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(headers).toMatchObject({ 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0', langType: 'EN',
      timezone: 'GMT+0000', country: 'EN', appId: J_AND_T_APP_ID, key: J_AND_T_SIGNING_KEY,
      timestamp: expect.stringMatching(/^\d{13}$/), nonce: expect.stringMatching(/^0\.\d+$/) });
    expect(headers).not.toHaveProperty('countryCode');
    expect(init!.body).toBe(`{"waybillNos":["${FAILED}"],"langType":"EN"}`);
    const signed = `${J_AND_T_APP_ID}${headers.timestamp}${headers.nonce}{"langType":"EN","waybillNos":["${FAILED}"]}${J_AND_T_SIGNING_KEY}`;
    expect(headers.sign).toBe(createHash('md5').update(signed).digest('hex').toUpperCase());
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'j-and-t-uk', step: 'direct', outcome: 'ok' }));
  });

  it('reads each scan time as an instant in UTC and stages the sorting scans', () => {
    const result = parseJAndTUk(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The parcel is dispatched from the transit center to the next destination',
      last_update: '2026-03-03T01:14:52Z', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-03-03T01:14:52Z', 'in_transit'],
      ['2026-03-02T22:40:07Z', 'in_transit'],
      ['2026-03-02T17:05:31Z', 'in_transit'],
      ['2026-03-02T11:21:44Z', 'in_transit'],
      ['2026-03-02T10:58:19Z', 'accepted'],
    ]);
    expect(result.events!.every((event) => !event.local_time && !event.location)).toBe(true);
  });

  it('reads the collection for delivery as out for delivery and an incomplete address as a failed attempt', () => {
    const result = parseJAndTUk(fixture('failed-delivery'), FAILED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'The delivery address is incomplete or incorrect.', last_update: '2026-07-09T14:22:05Z' });
    expect(result.events!.map((event) => event.stage)).toEqual(['failed_attempt', 'out_for_delivery', 'in_transit', 'in_transit',
      'in_transit', 'in_transit', 'accepted']);
    // The Chinese scan type and status the page does not show stay out.
    expect(JSON.stringify(result)).not.toMatch(/派件|运送中|问题件/);
  });

  it('keeps an unknown waybill, a moved route, a refusal and a page apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ code: 999001031, msg: '验签失败', data: null, fail: true, succ: false })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<!doctype html><html><title>Verifying your connection...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    expect(() => parseJAndTUk(changed('in-transit', (answer) => { answer.details = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseJAndTUk(fixture('in-transit'), FAILED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'J&T Express UK answered for another waybill' }));
    expect(() => parseJAndTUk(changed('in-transit', (answer) => { answer.details[0]!.scanTime = '03/03/2026 01:14:52'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects waybills J&T Express UK does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JTUK02345078901', 'JTUK0234507890134', 'JTDE023450789013', 'JTAU023450789013']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).recognize!('JTDE023450789013')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJAndTUkNumber('jtuk 0234 5078 9013')).toBe(FAILED);
  });

  it('recognizes a waybill with scans, and an unknown one as unknown, through the same lookup', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')))).recognize!(IN_TRANSIT))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-03T01:14:52.000Z' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).recognize!(UNKNOWN))
      .resolves.toEqual({ known: false });
  });

  it('routes a waybill filed under J&T Express UK, or detected as one of its waybills, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'j-and-t-uk' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'j-and-t-uk', source: 'j-and-t-uk', result: { current_stage: 'in_transit' } });
    await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'j-and-t-uk', source: 'j-and-t-uk' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === J_AND_T_UK_API)).toBe(true);
  });
});

describe('J&T Express UK waybills', () => {
  it('claims JTUK and twelve digits only', () => {
    for (const number of [IN_TRANSIT, FAILED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'j-and-t-uk', confidence: 'high' });
    }
    for (const number of ['JTUK02345078901', 'JTUK0234507890134', 'JTUL023450789013']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('j-and-t-uk');
    }
  });
});

describe('J&T Express UK status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(jAndTUkStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'j-and-t-uk', description: 'The parcel has been collected and is on its way.' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'j-and-t-uk', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(jAndTUkStage('Synthetic note')).toBeNull();
  });
});

describe('J&T Express links in Europe and Australia', () => {
  it('name each network for its own numbers only, and leave another network\'s number to detection', () => {
    for (const [host, carrier, own] of [['www.jtexpress.uk', 'j-and-t-uk', 'JTUK000000000001'], ['www.jtexpress.de', 'j-and-t-de', 'JTDE000000000001'],
      ['www.jtexpress.au', 'j-and-t-au', 'JTAU000000000001']] as const) {
      expect(parseTrackingInput(`https://${host}/tracking?q=${own}`), host).toMatchObject({ trackingNumber: own, carrier, source: 'link' });
      for (const other of ['JTDE000000000002', 'JTUK000000000002', 'JT0000000000001', 'JTUK0001'].filter((number) => !number.startsWith(own.slice(0, 4)))) {
        expect(parseTrackingInput(`https://${host}/tracking?q=${other}`).carrier, `${host} ${other}`).not.toBe(carrier);
      }
    }
  });
});
