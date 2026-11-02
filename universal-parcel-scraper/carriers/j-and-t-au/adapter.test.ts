import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, J_AND_T_AU_API, J_AND_T_AU_APP_ID, J_AND_T_AU_SIGNING_KEY, J_AND_T_AU_ZONE, JAndTAuTracker } from './adapter.js';
import { jAndTAuWording, normalizeJAndTAuNumber, parseJAndTAu } from './parser.js';
import { jAndTAuStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic waybills in J&T Express Australia's layout; none is a real parcel.
const DELIVERED = 'JTAU123406789013';
const IN_TRANSIT = 'JTAU012345678901';
const UNKNOWN = 'JTAU000000000000';

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

describe('J&T Express Australia HTTP adapter', () => {
  it('posts the whole waybill as the page does, signed over its sorted fields, once through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JAndTAuTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jtau 0123-4567-8901 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(J_AND_T_AU_API);
    const headers = init!.headers as Record<string, string>;
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(headers).toMatchObject({ 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0', langType: 'EN',
      timezone: 'GMT+0000', countryCode: 'AU', appId: J_AND_T_AU_APP_ID, key: J_AND_T_AU_SIGNING_KEY,
      timestamp: expect.stringMatching(/^\d{13}$/), nonce: expect.stringMatching(/^0\.\d+$/) });
    // The page's body, and the signature over its fields with their keys sorted.
    expect(init!.body).toBe(`{"waybillNos":["${IN_TRANSIT}"],"langType":"EN"}`);
    const signed = `${J_AND_T_AU_APP_ID}${headers.timestamp}${headers.nonce}{"langType":"EN","waybillNos":["${IN_TRANSIT}"]}${J_AND_T_AU_SIGNING_KEY}`;
    expect(headers.sign).toBe(createHash('md5').update(signed).digest('hex').toUpperCase());
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'j-and-t-au', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('names UTC as the request zone, which the reply writes every scan time in', () => {
    expect(J_AND_T_AU_ZONE).toBe('GMT+0000');
  });

  it('reads each scan time as an instant in UTC and stages its sentence', () => {
    const result = parseJAndTAu(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The parcel is dispatched from the transit center to the next destination',
      last_update: '2026-06-02T06:40:12Z', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.stage, event.description])).toEqual([
      ['2026-06-02T06:40:12Z', 'in_transit', 'The parcel is dispatched from the transit center to the next destination'],
      // The repeated arrival is kept once.
      ['2026-06-02T03:15:40Z', 'in_transit', 'The parcel arrives at the distribution center and is prepared for transport to the next destination.'],
      // The customer service number goes.
      ['2026-06-01T23:58:02Z', 'accepted', 'The parcel has been successfully picked up and is being prepared for transportation.'],
      ['2026-06-01T22:30:00Z', 'accepted', 'The parcel has been picked up from customs clearance.'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
    expect(result).not.toHaveProperty('last_update_local');
  });

  it('keeps the delivery without the recipient, the courier, the depot or a phone', () => {
    const result = parseJAndTAu(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'The parcel has been delivered and signed for.', last_update: '2026-05-14T04:22:31Z',
      delivered_at: '2026-05-14T04:22:31Z' });
    expect(result.events!.slice(0, 3).map((event) => [event.stage, event.description])).toEqual([
      ['delivered', 'The parcel has been delivered and signed for.'],
      ['out_for_delivery', 'The parcel is out for delivery.'],
      ['in_transit', 'The parcel arrives at the distribution center and is prepared for transport to the next destination.'],
    ]);
    expect(result.events).toHaveLength(6);
    expect(JSON.stringify(result)).not.toMatch(/Sample|0400|130000|Customer service/);
  });

  it('sorts scans newest first, as the page does, whatever order the reply lists them in', () => {
    const result = parseJAndTAu(changed('in-transit', (answer) => { answer.details.reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-06-02T06:40:12Z', current_stage: 'in_transit' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-06-01T22:30:00Z' });
  });

  it('takes people, brackets and phone numbers out of a sentence', () => {
    expect(jAndTAuWording('Your parcel was signed for by Sample Recipient. Courier [Sample Courier] [0400 000 000]'))
      .toBe('Your parcel was signed for.');
    expect(jAndTAuWording('【Sample Town】The recipient [Sample Recipient] could not be reached at [+61 400 000 000]'))
      .toBe('The recipient could not be reached at');
    expect(jAndTAuWording('Courier: Sample Person, will deliver today. Customer service hotline: 13 00 00')).toBe('Courier, will deliver today.');
    expect(jAndTAuWording('The driver (Sample Driver) will deliver today')).toBe('The driver will deliver today');
    expect(jAndTAuWording('快件已签收，签收人：【样例】。派件员【样例】0400000000。官网客服热线：130000')).toBe('快件已签收，签收人。派件员。');
    expect(jAndTAuWording('快件已由派件员派送中')).toBe('快件已由派件员派送中');
    expect(jAndTAuWording('Received by Sample Person; awaiting collection')).toBe('Received; awaiting collection');
    expect(jAndTAuWording('The courier is delivering the parcel. Please call 0400-000-000')).toBe('The courier is delivering the parcel. Please call');
    // The courtesy offering the customer service line goes with its number.
    expect(jAndTAuWording('Your parcel is out for delivery. If you have any questions, please call 1300 000 000, Thank you for your patience.'))
      .toBe('Your parcel is out for delivery.');
    expect(jAndTAuWording('Your parcel has been delivered.If you have any questions,please call 1300000000. We look forward to serving you again.'))
      .toBe('Your parcel has been delivered.');
    // A date stays, and a sentence that is only a phone number is empty.
    expect(jAndTAuWording('Delivery rescheduled to 2026-05-20')).toBe('Delivery rescheduled to 2026-05-20');
    expect(jAndTAuWording('0400 000 000')).toBe('');
  });

  it('drops a scan whose sentence named only a phone number', () => {
    const result = parseJAndTAu(changed('in-transit', (answer) => {
      answer.details.unshift({ scanTime: '2026-06-02 07:00:00', customerTracking: '0400 000 000' });
    }), IN_TRANSIT);
    expect(result.events).toHaveLength(4);
    expect(result.last_update).toBe('2026-06-02T06:40:12Z');
  });

  it('reads a waybill left out of the answers as not found, and a found one without scans as no history', () => {
    // The page says it has no tracking records for it.
    expect(() => parseJAndTAu(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const noHistory = expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' });
    expect(() => parseJAndTAu(changed('in-transit', (answer) => { answer.details = []; }), IN_TRANSIT)).toThrow(noHistory);
    expect(() => parseJAndTAu(changed('in-transit', (answer) => { delete (answer as Row).details; }), IN_TRANSIT)).toThrow(noHistory);
  });

  it('counts an answer only when it names the waybill asked, in every field that can name one', () => {
    const otherWaybill = expect.objectContaining({ kind: 'indeterminate', message: 'J&T Express Australia answered for another waybill' });
    expect(() => parseJAndTAu(fixture('in-transit'), DELIVERED)).toThrow(otherWaybill);
    // A longer waybill sharing the asked one's start is another waybill.
    expect(() => parseJAndTAu(changed('in-transit', (answer) => { answer.keyword = `${IN_TRANSIT}0`; }), IN_TRANSIT)).toThrow(otherWaybill);
    expect(() => parseJAndTAu(changed('in-transit', (answer) => { answer.details[0]!.billCode = DELIVERED; }), IN_TRANSIT)).toThrow(otherWaybill);
    expect(() => parseJAndTAu(changed('in-transit', (_answer, body) => { body.data.push(fixture('delivered').data[0]!); }), IN_TRANSIT))
      .toThrow(otherWaybill);
    expect(() => parseJAndTAu(changed('in-transit', (answer, body) => { body.data.push(answer); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The keyword as printed in lower case or with spaces is the same waybill.
    expect(parseJAndTAu(changed('in-transit', (answer) => { answer.keyword = 'jtau 0123 4567 8901'; }), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('keeps a refusal, a throttle and a failed lookup apart', () => {
    const failed = (code: number, msg: string) => () => parseJAndTAu({ code, msg, data: null, fail: true, succ: false }, IN_TRANSIT);
    expect(failed(999001031, '验签失败')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(failed(999001030, '参数无效:waybillNos 运单号不能超过10条;')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(failed(999005060, ' 系统内部错误')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(failed(999009999, '请求过于频繁')).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_answer: Answer, body: Reply) => { delete (body as Row).code; },
      (_answer: Answer, body: Reply) => { body.code = '1'; },
      (_answer: Answer, body: Reply) => { body.data = null as never; },
      (_answer: Answer, body: Reply) => { body.data = 'answers' as never; },
      (_answer: Answer, body: Reply) => { body.data[0] = 'answer' as never; },
      (answer: Answer) => { delete answer.keyword; },
      (answer: Answer) => { answer.keyword = ['JTAU012345678901'] as never; },
      (answer: Answer) => { answer.details = 'scans' as never; },
      (answer: Answer) => { answer.details = Array.from({ length: 501 }, () => answer.details[0]!); },
      (answer: Answer) => { answer.details[0] = 'scan' as never; },
      (answer: Answer) => { answer.details[0]!.waybillNo = 12345678901; },
      (answer: Answer) => { answer.details[0]!.scanTime = '02/06/2026 16:40:12'; },
      (answer: Answer) => { answer.details[0]!.scanTime = '2026-06-02 16:40'; },
      (answer: Answer) => { answer.details[0]!.scanTime = '2026-06-02 24:00:00'; },
      (answer: Answer) => { answer.details[0]!.scanTime = '2026-02-30 16:40:12'; },
      (answer: Answer) => { answer.details[0]!.scanTime = 1780418412000; },
      (answer: Answer) => { delete answer.details[0]!.customerTracking; },
      (answer: Answer) => { answer.details[0]!.customerTracking = ' '; },
      (answer: Answer) => { answer.details[0]!.customerTracking = ['Dispatched']; },
    ]) {
      expect(() => parseJAndTAu(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown waybill, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every waybill with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.jtexpress.au/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { status: 403 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    // A page in place of the JSON, even with HTTP 200, is a challenge, never a missing parcel.
    await expect(lookup('<html><script>var acw_sc__v2 = "0";</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><html><title>J&T Express Australia</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"code":1,')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ code: 999001031, msg: '验签失败', data: null, fail: true, succ: false })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a request that fails to reach the site once more, signed afresh', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const nonces = fetcher.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).nonce);
    expect(new Set(nonces).size).toBe(2);
  });

  it('rejects waybills J&T Express Australia does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JTAU01234567890', 'JTAU0123456789012', 'JTE300000000000', 'JTNZ012345678901', `JTAU${'0'.repeat(61)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJAndTAuNumber('jtau 0123 4567 8901')).toBe(IN_TRANSIT);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('recognizes a waybill with scans, and an unknown one as unknown, through the same lookup', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-05-14T04:22:31.000Z' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).recognize!(UNKNOWN))
      .resolves.toEqual({ known: false });
    // A found waybill without scans settles nothing.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(changed('in-transit', (answer) => { answer.details = []; }))))
      .recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('JTNZ012345678901')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a waybill filed under J&T Express Australia, or detected as one of its waybills, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'j-and-t-au' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'j-and-t-au', source: 'j-and-t-au', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'j-and-t-au', source: 'j-and-t-au' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === J_AND_T_AU_API)).toBe(true);
  });
});

describe('J&T Express Australia waybills', () => {
  it('claims JTAU and twelve digits only', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'j-and-t-au', confidence: 'high' });
    }
    for (const number of ['JTAU01234567890', 'JTAU0123456789012', 'JTE300000000000']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('j-and-t-au');
    }
  });
});

describe('J&T Express Australia status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(jAndTAuStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // Without its closing full stop too.
    expect(statusMapAnswer({ carrier: 'j-and-t-au', description: 'The parcel has been picked up from customs clearance' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'j-and-t-au', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Other wording falls to the shared rules.
    expect(jAndTAuStage('The parcel has been delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(jAndTAuStage('Synthetic note')).toBeNull();
  });
});
