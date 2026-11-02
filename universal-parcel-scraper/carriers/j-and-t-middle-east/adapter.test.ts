import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, J_AND_T_MIDDLE_EAST_API, J_AND_T_MIDDLE_EAST_CAPTCHA_SWITCH, JAndTMiddleEastTracker } from './adapter.js';
import { normalizeJAndTMiddleEastNumber, parseJAndTMiddleEast } from './parser.js';
import { jAndTMiddleEastStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'JTE300000000001';
const IN_TRANSIT = 'JTE300000000002';
const UNKNOWN = 'JTE300000000000';

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
const OFF = { enabled: false };
/** A transport answering the captcha switch and the lookup, each from its own reply. */
const site = (lookup: () => Response | Promise<Response>, captchaSwitch: () => Response | Promise<Response> = () => reply(OFF)) =>
  vi.fn<typeof fetch>(async (input) => (String(input).startsWith(J_AND_T_MIDDLE_EAST_CAPTCHA_SWITCH) ? captchaSwitch() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookups = (fetcher: ReturnType<typeof site>) => fetcher.mock.calls.filter(([url]) => String(url) === J_AND_T_MIDDLE_EAST_API);

describe('J&T Express Middle East HTTP adapter', () => {
  it('reads the captcha switch, then posts the whole waybill with the page’s placeholder ticket, through the supplied transport', async () => {
    const fetcher = site(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JAndTMiddleEastTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jte 3000-0000-0002 ', { budgetMs: 3000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[switchUrl, switchInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(switchUrl).toMatch(new RegExp(`^${J_AND_T_MIDDLE_EAST_CAPTCHA_SWITCH.replaceAll('.', '\\.')}\\?t=\\d+$`));
    expect(switchInit).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(J_AND_T_MIDDLE_EAST_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0', langType: 'EN', timezone: 'GMT+0300', countryId: '1',
    } });
    expect(JSON.parse(String(init.body))).toEqual({ waybillNo: [IN_TRANSIT], langType: 'EN', ticket: 'captcha-close', randstr: 'captcha-close' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'j-and-t-middle-east', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan’s time as an instant in the zone asked, its label and its branch’s town, once, without the people, phones or pictures', () => {
    const result = parseJAndTMiddleEast(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'Delivered', last_update: '2026-05-14T16:42:10+03:00', delivered_at: '2026-05-14T16:42:10+03:00', expected_delivery: null });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.location, event.stage, event.stage_source])).toEqual([
      ['2026-05-14T16:42:10+03:00', '6', 'Delivered', 'Sample City, Sample Province', 'delivered', 'wording:language'],
      ['2026-05-14T09:05:33+03:00', '4', 'Out for delivery', 'Sample City, Sample Province', 'out_for_delivery', 'wording:language'],
      // The repeated arrival is kept once.
      ['2026-05-13T22:18:02+03:00', '3', 'Arrived', 'Sample City, Sample Province', 'in_transit', 'wording:language'],
      ['2026-05-12T19:47:51+03:00', '2', 'Departed', 'Origin Town, Sample Province', 'in_transit', 'wording:language'],
      ['2026-05-12T11:30:00+03:00', '2', 'Picked up', 'Origin Town, Sample Province', 'accepted', 'wording:language'],
      ['2026-05-11T08:00:15+03:00', '1', 'Order creation', undefined, 'registered', 'carrier_map'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Branch|0[15]\d{8}|synthetic|signed for|Courier/);
  });

  it('takes the current stage from the newest scan with one', () => {
    const result = parseJAndTMiddleEast(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Problem shipment',
      last_update: '2026-07-03T10:21:45+03:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![0]).toEqual({ time: '2026-07-03T10:21:45+03:00', description: 'Problem shipment', location: 'Sample Town, Sample Province',
      provider_code: '7' });
    expect(JSON.stringify(result)).not.toMatch(/Branch|Recipient unreachable|0522222222|synthetic/);
  });

  it('orders the scans by their instants, newest first, as the page shows them', () => {
    const result = parseJAndTMiddleEast(changed('in-transit', (answer) => answer.details.reverse()), IN_TRANSIT);
    expect(result.events!.map((event) => event.time)).toEqual(['2026-07-03T10:21:45+03:00', '2026-07-02T23:59:59+03:00',
      '2026-07-02T06:12:40+03:00', '2026-07-01T17:03:09+03:00', '2026-07-01T09:00:00+03:00']);
    // An order that has only just been created.
    const created = parseJAndTMiddleEast(changed('in-transit', (answer) => { answer.details = answer.details.slice(-1); }), IN_TRANSIT);
    expect(created).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Order creation', last_update: '2026-07-01T09:00:00+03:00' });
  });

  it('reads the unknown-waybill code as not found, a captcha request as a challenge and a waybill without scans as no history', () => {
    expect(() => parseJAndTMiddleEast(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const refusal = (code: number, msg: string) => ({ code, msg, data: null, succ: false, fail: true });
    expect(() => parseJAndTMiddleEast(refusal(1350200260, 'Verification failed'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJAndTMiddleEast(refusal(999009999, 'Requests too frequent'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseJAndTMiddleEast(refusal(999001010, 'Incomplete parameters'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJAndTMiddleEast(refusal(999006020, 'Something wrong. Please Contact Tech for support.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const details of [[], null]) {
      expect(() => parseJAndTMiddleEast(changed('delivered', (answer) => { answer.details = details as Row[]; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('counts an answer only when every waybill it names is the one asked', () => {
    for (const change of [
      (answer: Answer) => { answer.waybillNo = 'JTE300000000009'; },
      (answer: Answer) => { answer.keyword = 'JTE300000000009'; },
      (answer: Answer) => { answer.details[2]!.billCode = 'JTE300000000009'; },
    ]) {
      expect(() => parseJAndTMiddleEast(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseJAndTMiddleEast(changed('delivered', (answer) => { answer.keyword = 'jte300000000001'; }), DELIVERED).events).toHaveLength(6);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_answer: Answer, reply: Reply) => { delete reply.succ; },
      (_answer: Answer, reply: Reply) => { reply.data = []; },
      (_answer: Answer, reply: Reply) => { reply.data.push(reply.data[0]!); },
      (answer: Answer) => { answer.details = 'none' as unknown as Row[]; },
      (answer: Answer) => { answer.details[0] = 'scan' as unknown as Row; },
      (answer: Answer) => { answer.details[0]!.scanTime = '2026-05-14T16:42:10Z'; },
      (answer: Answer) => { answer.details[0]!.scanTime = '2026-02-30 10:00:00'; },
      (answer: Answer) => { answer.details[0]!.scanTime = '2026-05-14 24:00:00'; },
      (answer: Answer) => { answer.details[0]!.status = ''; },
      (answer: Answer) => { answer.details[0]!.status = { en: 'Delivered' }; },
      (answer: Answer) => { answer.waybillNo = 300000000001; },
      (answer: Answer) => { delete answer.keyword; },
      (answer: Answer) => { answer.keyword = ''; },
    ]) {
      expect(() => parseJAndTMiddleEast(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown waybill, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(site(() => reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every waybill with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.jtexpress.me/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>var arg1 = "0"; acw_sc__v2 = "";</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><title>Request blocked</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"code":1,')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = site(() => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(lookups(fetcher)).toHaveLength(1);
    });

  it('does not look a waybill up while J&T’s captcha switch is on, and reads the switch once for several lookups', async () => {
    for (const on of [{ enabled: true }, {}, null, { enabled: 'false' }]) {
      const fetcher = site(() => reply(fixture('in-transit')), () => reply(on));
      const tracker = carrier(fetcher);
      await expect(tracker.track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'challenge' });
      await expect(tracker.track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'challenge' });
      expect(lookups(fetcher)).toHaveLength(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = site(() => reply(fixture('in-transit')));
    const tracker = carrier(fetcher);
    await tracker.track({ number: IN_TRANSIT });
    await tracker.track({ number: IN_TRANSIT });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('looks a waybill up when the switch cannot be read, as the page’s captcha script does', async () => {
    for (const unreadable of [() => new Response('', { status: 500 }), () => reply('<html></html>'), () => Promise.reject(new TypeError('fetch failed'))]) {
      const fetcher = site(() => reply(fixture('in-transit')), unreadable);
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
      expect(lookups(fetcher)).toHaveLength(1);
    }
  });

  it('rejects waybills J&T Express Middle East does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = site(() => reply(fixture('in-transit')));
    for (const number of ['JTE30000000000', 'JTE3000000000011', 'JMX300000000001', 'TTE300000000001', '300000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJAndTMiddleEastNumber('jte 3000 0000 0001')).toBe(DELIVERED);
  });

  it('tries a lookup that does not reach the site once more inside the budget', async () => {
    let calls = 0;
    const fetcher = site(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new TypeError('fetch failed')) : reply(fixture('delivered'));
    });
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(lookups(fetcher)).toHaveLength(2);
  });

  it('ends a hanging lookup and its one retry inside the budget', async () => {
    fakeBudgetClock();
    // The switch answers first; both tries of the lookup hang.
    const { fetcher, ended } = delayedFetcher([{ afterMs: 0, reply: () => reply(OFF) }, { afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 300 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(300);
    await spent;
    expect(lookups(fetcher)).toHaveLength(2);
    // The switch was read once, for both tries.
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([0, 150, 300]);
  });

  it('routes a waybill filed under J&T Express Middle East, or detected as one, to the adapter', async () => {
    const fetcher = site(() => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'j-and-t-middle-east' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'j-and-t-middle-east', source: 'j-and-t-middle-east', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'j-and-t-middle-east', source: 'j-and-t-middle-east' });
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'j-and-t-middle-east', confidence: 'high' });
  });

  it('stages every label recorded live, and leaves the rest to the shared wording rules', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(jAndTMiddleEastStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'j-and-t-middle-east', providerCode: entry.code, description: entry.wording }))
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'j-and-t-middle-east', providerCode: '9', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(jAndTMiddleEastStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(jAndTMiddleEastStage('Problem shipment')).toBeNull();
  });
});
