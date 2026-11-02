import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DynalogicTracker, dynalogicOrderUrl } from './adapter.js';
import { parseDynalogic } from './parser.js';
import { dynalogicStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '90001TEST00001';
const ON_THE_WAY = '90001TEST00002';
const REGISTERED = '90002TEST0003';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as { data: Record<string, unknown> };
const reply = (name: string, status = name === 'not-found' ? 404 : 200) =>
  new Response(text(name), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const steps = (done: number, failedStep?: number) => [1, 2, 3, 4].map(step =>
  ({ StepNumber: step, Status: step <= done ? 1 : 0, Overlay: step === failedStep ? 2 : 0 }));

describe('Dynalogic HTTP adapter', () => {
  it('asks the tracker’s number-only route once, as its page script does, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DynalogicTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 90001 test 00001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://track.mydynalogic.eu/api/transportorder/partial/ordernumber/${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest', Referer: 'https://track.mydynalogic.eu/track/login', Locale: 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dynalogic', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered order as a summary, without the contact details or the undated delivery day', () => {
    const result = parseDynalogic(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery successful', provider_code: 'DEL_DEF/4', last_update: null, expected_delivery: null,
      summary_only: true, events: [] });
    expect(JSON.stringify(result)).not.toMatch(/example\.invalid|31000000000|March|90001,|09:00/);
  });

  it('keeps the driver’s arrival window in Amsterdam time while the order is on its way, and never the coordinates', () => {
    const result = parseDynalogic(fixture('on-the-way'), ON_THE_WAY);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', provider_code: 'DEL_DEF/3',
      last_status_text: 'Onze medewerker is onderweg met uw zending',
      expected_delivery_from: '2026-03-10T14:05:00+01:00', expected_delivery: '2026-03-10T14:50:00+01:00', events: [] });
    expect(JSON.stringify(result)).not.toMatch(/52\.1111|5\.2222|13:12|08:31/);
    const summer = fixture('on-the-way');
    Object.assign(summer.data.TransportProgress as object, { EtaStartDateTime: '2026-07-10T09:00:00', EtaEndDateTime: '2026-07-10T10:15:00.5' });
    expect(parseDynalogic(summer, ON_THE_WAY)).toMatchObject({ expected_delivery_from: '2026-07-10T09:00:00+02:00', expected_delivery: '2026-07-10T10:15:00+02:00' });
    for (const TimeLineStatus of [0, 1]) {
      const hidden = fixture('on-the-way');
      Object.assign(hidden.data.TransportProgress as object, { TimeLineStatus });
      expect(parseDynalogic(hidden, ON_THE_WAY)).toMatchObject({ expected_delivery: null });
      expect(parseDynalogic(hidden, ON_THE_WAY).expected_delivery_from).toBeUndefined();
    }
    const backwards = fixture('on-the-way');
    Object.assign(backwards.data.TransportProgress as object, { EtaEndDateTime: '2026-03-10T13:00:00' });
    expect(parseDynalogic(backwards, ON_THE_WAY).expected_delivery).toBeNull();
    const delivered = fixture('on-the-way');
    delivered.data.ProgressData = steps(4);
    expect(parseDynalogic(delivered, ON_THE_WAY)).toMatchObject({ status: 'delivered', expected_delivery: null });
  });

  it('binds a registered order to its whole number, dashes aside', () => {
    expect(parseDynalogic(fixture('registered'), REGISTERED)).toMatchObject({ status: 'pending', current_stage: 'registered',
      provider_code: 'DEL_DEF/0', last_status_text: 'Uw zending is bij ons aangemeld', expected_delivery: null });
  });

  it('keeps an order found under another number inconclusive and malformed replies apart', () => {
    // The service also finds an order by the merchant's order number or its end.
    expect(() => parseDynalogic(fixture('delivered'), '90009TEST00001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const change of [{ TrackAndTraceNumber: null }, { Scenario: 'delivered' }, { ProgressData: [] },
      { ProgressData: [{ StepNumber: 1, Status: 'done', Overlay: 0 }] }, { ProgressData: [{ StepNumber: 9, Status: 1, Overlay: 0 }] }]) {
      const payload = fixture('delivered');
      Object.assign(payload.data, change);
      expect(() => parseDynalogic(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDynalogic({ success: false, data: null }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('stages failed scenarios once their last step is done and leaves unexpected ones unstaged with their caption', () => {
    const order = (Scenario: string, ProgressData: unknown, DetailCaption = '') => {
      const payload = fixture('delivered');
      Object.assign(payload.data, { Scenario, ProgressData, DetailCaption });
      return parseDynalogic(payload, DELIVERED);
    };
    expect(order('DEL_FAIL', steps(4, 4))).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      provider_code: 'DEL_FAIL/4', last_status_text: 'Not delivered to you' });
    expect(order('DEL_NB', steps(4))).toMatchObject({ status: 'delivered', last_status_text: 'Delivered to your neighbour' });
    expect(order('PU_DEF', steps(3))).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'On the way to you' });
    expect(order('RS_DEF', steps(4))).toMatchObject({ status: 'exception', current_stage: 'returned' });
    for (const [scenario, done, failed, code] of [['DEL_DEF', 3, 3, 'DEL_DEF/3/failed'], ['DEL_FAIL', 2, undefined, 'DEL_FAIL/2'],
      ['COR_DEF', 4, undefined, 'COR_DEF/4'], ['XYZ_DEF', 2, undefined, 'XYZ_DEF/2']] as const) {
      const result = order(scenario, steps(done, failed), 'Synthetic caption');
      expect(result, code).toMatchObject({ status: 'unknown', provider_code: code, last_status_text: 'Synthetic caption', summary_only: true });
      expect(result.current_stage).toBeUndefined();
    }
    expect(order('XYZ_DEF', steps(0)).last_status_text).toBeNull();
  });

  it('recognizes any order the service returns and an unknown number as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('registered')).mockResolvedValueOnce(reply('not-found'));
    await expect(carrier(fetcher).recognize!(REGISTERED)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!(REGISTERED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('TEST00001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('not-found'))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'))).recognize!('90009TEST00001'))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([
    ['the not-found notice without its 404', json({ success: false, data: null, error: 'An empty response returned.', code: 404 }), 'schema'],
    ['a 404 without the notice', new Response('<html>Not Found</html>', { status: 404 }), 'transport'],
    ['another JSON 404', json({ success: false, data: null, error: 'Route not found', code: 404 }, 404), 'transport'],
    ['the page-script gate', json({ success: false, data: null, error: 'You are not allowed to access this resource.', code: 403 }, 403), 'challenge'],
    ['an address block', json({ success: false, data: null, error: 'Ip block untill;15', code: 403 }, 403), 'rate_limited'],
    ['an address block in a success reply', json({ success: false, data: null, error: 'Ip block untill;15', code: 200 }), 'rate_limited'],
    ['HTTP 429', new Response('', { status: 429, headers: { 'Retry-After': '120' } }), 'rate_limited'],
    ['a server error', json({ success: false, data: null, error: 'Padding is invalid and cannot be removed.', code: 500 }, 500), 'indeterminate'],
    ['maintenance', new Response('<html>Down</html>', { status: 503 }), 'maintenance'],
    ['a challenge page', new Response('<html><title>Just a moment...</title></html>'), 'challenge'],
    ['an HTML page', new Response('<html>Track</html>'), 'schema'],
  ] as const)('keeps %s apart from a missing order', async (_name, response, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response.clone());
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
  });

  it('passes on the minutes an address block names', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ success: false, data: null, error: 'Ip block untill;15', code: 403 }, 403));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 900_000 });
  });

  it('rejects numbers without the five-digit customer id and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TEST00001', '9000', '90001', '9000ATEST0001', `90001${'A'.repeat(41)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes an order filed under Dynalogic to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('on-the-way'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: ON_THE_WAY, carrier: 'dynalogic' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dynalogic', source: 'dynalogic', result: { current_stage: 'out_for_delivery', summary_only: true } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === dynalogicOrderUrl(ON_THE_WAY))).toBe(true);
  });
});

describe('Dynalogic status vocabulary', () => {
  it('records every code the map stages or leaves out on purpose, with the stage the map gives it', () => {
    const recorded = statuses.entries.map(entry => entry.code);
    expect(new Set(recorded).size).toBe(recorded.length);
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(dynalogicStage(entry.code), entry.code).toBe(stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(('wording' in entry ? entry.wording : undefined) ?? entry.code))).toBe(stage);
      if (!stage) expect(statusMap.gaps.map(gap => gap.code)).toContain(entry.code);
    }
    expect(statusMap.gaps.every(gap => recorded.includes(gap.code!))).toBe(true);
    for (const code of ['DEL_DEF/0', 'DEL_DEF/1', 'DEL_DEF/2', 'DEL_DEF/3', 'DEL_DEF/4', 'DEL_FAIL/4', 'PU_DEF/4', 'RS_DEF/4']) {
      expect(recorded).toContain(code);
    }
    expect(statusMapAnswer({ carrier: 'dynalogic', providerCode: 'DEL_DEF/3', description: 'On the way to you' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'dynalogic', providerCode: 'COR_DEF/4', description: 'Completed by Dynalogic' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
