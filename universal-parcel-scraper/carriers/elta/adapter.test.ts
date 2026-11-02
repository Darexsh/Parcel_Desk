import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ELTA_ENDPOINT, EltaTracker } from './adapter.js';
import { parseElta } from './parser.js';
import { eltaScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const COLLECTED = 'ZZ000000014GR';
const ATTEMPTED = 'ZZ000000028GR';
const ABSENT = 'ZZ000000031GR';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
// The endpoint labels its JSON as HTML.
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

type Slot = { out_date: string; out_time: string; out_station: string; out_status_name: string };
type Reply = [{ code: string; response: { out_flag: number | string; out_title: string; out_counter: number; out_status: Slot[] } }];
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name) as Reply;
  change(payload);
  return payload;
};

describe('ELTA tracking adapter', () => {
  it('posts the whole item code once, in English, through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EltaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 gr ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.elta.gr/trackApi');
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect([...new URLSearchParams(String(init!.body))]).toEqual([['code[]', COLLECTED], ['in_lang', '2']]);
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'elta', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an item collected from a post office newest first, as wall clocks', () => {
    const result = parseElta(fixture('collected'), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item delivered', last_update: null, last_update_local: '2026-03-05T14:10:00', expected_delivery: null,
      pickup_point: 'EXAMPLE POST OFFICE 1 - ELTA' });
    expect(result.events!.map(event => [event.local_time, event.description, event.location, event.stage, event.stage_source])).toEqual([
      ['2026-03-05T14:10:00', 'Item delivered', 'EXAMPLE POST OFFICE 1 - ELTA', 'delivered', 'carrier_map'],
      ['2026-03-04T12:15:00', 'SMS text message sent for item to be collected', 'EXAMPLE POST OFFICE 1 - ELTA', 'ready_for_pickup', 'none'],
      ['2026-03-04T12:14:00', 'Item at post office - Can be collected', 'EXAMPLE POST OFFICE 1 - ELTA', 'ready_for_pickup', 'carrier_map'],
      ['2026-03-04T12:13:00', 'Arrival in EXAMPLE POST OFFICE 1 - ELTA', 'EXAMPLE POST OFFICE 1 - ELTA', 'in_transit', 'carrier_map'],
      ['2026-03-04T06:10:00', 'Shipment in transit', 'SAMPLE SORTING CENTRE', 'in_transit', 'carrier_map'],
      ['2026-03-03T17:45:00', 'Shipment in transit', 'SAMPLE TOWN AGENCY', 'in_transit', 'carrier_map'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
  });

  it('keeps equal clocks in the tracker’s order, drops repeated scans and names the point an item waits at', () => {
    const result = parseElta(fixture('attempted'), ATTEMPTED);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Item at post office - Can be collected', pickup_point: 'SAMPLE HUB DELIVERY' });
    expect(result.events!.map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-03-10T18:54:00', 'Item at post office - Can be collected', 'ready_for_pickup'],
      ['2026-03-10T12:22:00', 'ADDRESSEE NOT AVAILABLE AT TIME OF DELIVERY', 'failed_attempt'],
      ['2026-03-10T12:22:00', 'Notification of attempted delivery', 'failed_attempt'],
      ['2026-03-10T07:29:00', 'With Courier for delivery', 'out_for_delivery'],
      ['2026-03-10T05:27:00', 'Arrival in SAMPLE HUB DELIVERY', 'in_transit'],
      ['2026-03-09T23:55:00', 'Shipment in transit', 'in_transit'],
    ]);
    // Listed oldest first, newest first in the result, scans of one minute too.
    const shuffled = edited('attempted', payload => {
      const slots = payload[0].response.out_status;
      slots.splice(0, payload[0].response.out_counter, ...slots.slice(0, payload[0].response.out_counter).reverse());
    });
    expect(parseElta(shuffled, ATTEMPTED).events!.map(event => [event.local_time, event.description]))
      .toEqual(result.events!.map(event => [event.local_time, event.description]));
  });

  it('names no pickup point for an item the recipient will collect elsewhere or that was brought to the door', () => {
    const ownPickup = edited('attempted', payload => {
      payload[0].response.out_status[0] = { ...payload[0].response.out_status[0]!, out_status_name: 'ADDRESSEE REQUEST OWN PICK-UP' };
    });
    const answer = parseElta(ownPickup, ATTEMPTED);
    expect(answer).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(answer.pickup_point).toBeUndefined();
    const door = edited('collected', payload => {
      payload[0].response.out_status.splice(1, 3, { out_date: '20260305', out_time: '0805', out_station: 'SAMPLE TOWN AGENCY',
        out_status_name: 'With Courier for delivery' });
      payload[0].response.out_counter = 4;
    });
    const delivered = parseElta(door, COLLECTED);
    expect(delivered).toMatchObject({ current_stage: 'delivered' });
    expect(delivered.pickup_point).toBeUndefined();
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const payload = edited('collected', reply => {
      reply[0].response.out_status[0] = { ...reply[0].response.out_status[0]!, out_status_name: 'Item returned to sender' };
    });
    expect(parseElta(payload, COLLECTED)).toMatchObject({ status: 'exception', current_stage: 'returned',
      current_stage_source: 'wording:language', last_status_text: 'Item returned to sender' });
    const unknown = edited('collected', reply => {
      reply[0].response.out_status[0] = { ...reply[0].response.out_status[0]!, out_status_name: 'Item weighed at counter' };
    });
    const result = parseElta(unknown, COLLECTED);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Item weighed at counter' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ local_time: '2026-03-05T14:10:00', description: 'Item weighed at counter',
      location: 'EXAMPLE POST OFFICE 1 - ELTA' });
    // A notice after an unstaged scan stays unstaged too, and does not decide the status.
    const notice = edited('collected', reply => {
      reply[0].response.out_status.splice(0, 2, { out_date: '20260305', out_time: '0900', out_station: 'EXAMPLE POST OFFICE 1 - ELTA',
        out_status_name: 'SMS text message sent for item to be collected' }, { out_date: '20260305', out_time: '0859',
        out_station: 'EXAMPLE POST OFFICE 1 - ELTA', out_status_name: 'Item weighed at counter' });
    });
    const quiet = parseElta(notice, COLLECTED);
    expect(quiet).toMatchObject({ status: 'unknown', last_status_text: 'Item weighed at counter', last_update_local: '2026-03-05T09:00:00' });
    expect(quiet.events![0]!.stage).toBeUndefined();
  });

  it('binds the reply to the whole requested code and rejects malformed histories', () => {
    expect(() => parseElta(fixture('collected'), 'ZZ000000045GR')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = fixture('collected') as unknown[];
    twice.push(twice[0]);
    for (const payload of [twice, [], {}, null, [{ code: COLLECTED }],
      edited('collected', reply => { reply[0].code = `${COLLECTED} ${ATTEMPTED}`; }),
      edited('collected', reply => { reply[0].response.out_counter = 99; }),
      edited('collected', reply => { reply[0].response.out_status[2]!.out_time = '2575'; }),
      edited('collected', reply => { reply[0].response.out_status[2]!.out_date = '2026-03-04'; }),
      edited('collected', reply => { reply[0].response.out_status[2]!.out_status_name = ' '; }),
      edited('collected', reply => { (reply[0].response.out_status as unknown[])[2] = 'scan'; })]) {
      expect(() => parseElta(payload, COLLECTED), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the tracker’s no-history notice as a missing item', () => {
    expect(() => parseElta(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const greek = edited('not-found', reply => { reply[0].response.out_title = 'Ιστορικό Μη Διαθέσιμο'; });
    expect(() => parseElta(greek, ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [edited('not-found', reply => { reply[0].response.out_title = 'Service temporarily unavailable'; }),
      edited('not-found', reply => { reply[0].response.out_flag = 1; }),
      edited('collected', reply => { reply[0].response.out_counter = 0; }),
      edited('collected', reply => { reply[0].response.out_status.forEach(slot => { slot.out_date = ''; }); })]) {
      const number = payload[0].code;
      expect(() => parseElta(payload, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseElta(edited('collected', reply => { reply[0].response.out_flag = '0'; }), COLLECTED)).toMatchObject({ status: 'delivered' });
  });

  it('takes S10 codes with a valid check digit and twelve-digit codes, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015GR', 'ZZ00000001GR', '12345678901', '1234567890123', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const code = new URLSearchParams(String(init!.body)).get('code[]')!;
      return reply(text('not-found').replace(ABSENT, code));
    });
    for (const number of ['RR000000014DE', '123456789012']) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('recognizes a known item and the no-history notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('collected'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T14:10:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages, empty and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [['<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference</BODY></HTML>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['', 'indeterminate'], ['  ', 'indeterminate'], ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(COLLECTED), body).rejects.toMatchObject({ kind });
    }
    const bom = vi.fn<typeof fetch>().mockResolvedValue(reply(`\uFEFF${text('collected')}`));
    await expect(carrier(bom).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: COLLECTED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('collected')));
    await expect(carrier(flaky).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    await expect(carrier(immediate).track({ number: COLLECTED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: COLLECTED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: COLLECTED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an item filed under ELTA to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('collected')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: COLLECTED, carrier: 'elta' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'elta', source: 'elta', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === ELTA_ENDPOINT)).toBe(true);
  });

  it('is asked about Greek S10 codes, which detection leaves with the postal fallback, and keeps its links', () => {
    expect(detectCarrierMatch(COLLECTED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(COLLECTED)[0]).toBe('elta');
    expect(recognitionAskedCarriers('ZZ000000015GR')).not.toContain('elta');
    expect(recognitionAskedCarriers('RR000000014DE')).not.toContain('elta');
    expect(parseTrackingInput(`https://www.elta.gr/en/track?code=${COLLECTED}`))
      .toMatchObject({ trackingNumber: COLLECTED, carrier: 'elta', source: 'link' });
  });
});

describe('ELTA status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(eltaScanStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(stage);
    }
    expect(eltaScanStage('Arrival in      SAMPLE TOWN AGENCY')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Arrivals', 'Item delivered to sender']) expect(eltaScanStage(wording), wording).toBeUndefined();
    expect(statusMap.stage('7', 'item delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'elta', description: 'Item at post office - Can be collected' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'elta', description: 'SMS text message sent for item to be collected' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
