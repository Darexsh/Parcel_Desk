import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ceskaPostaUrl, CeskaPostaTracker } from './adapter.js';
import { parseCeskaPosta } from './parser.js';
import { ceskaPostaCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const COLLECTED = 'RR900000019CZ';
const RETURNED = 'DR9000000002U';
const PRE_ADVICE = 'DR9000000003U';
const UNKNOWN = 'DR9999999992U';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Row { id: string; date: string; text: string; postoffice?: string | null; [key: string]: unknown }
interface Item { id?: string; attributes: Record<string, unknown>; states: { state: Row[] } }
const edited = (name: string, change: (item: Item, payload: Item[]) => void = () => {}): Item[] => {
  const payload = JSON.parse(text(name)) as Item[];
  change(payload[0]!, payload);
  return payload;
};
const rows = (result: ReturnType<typeof parseCeskaPosta>) =>
  result.events!.map(event => [event.local_time, event.provider_code, event.stage ?? null, event.stage_source ?? null, event.location ?? null]);

describe('Česká pošta tracking adapter', () => {
  it('asks the public B2C service for the whole number in English once and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CeskaPostaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rr 900 000 019 cz ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://b2c.cpost.cz/services/ParcelHistory/getDataAsJson?idParcel=${COLLECTED}&language=en`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ceska-posta', step: 'direct', outcome: 'ok' }));
  });

  it('orders an item collected from a post office newest day first, keeps calendar days and drops the service line', () => {
    const result = parseCeskaPosta(JSON.parse(text('collected')), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery of the consignment.', last_update: null, last_update_local: '2026-03-06',
      expected_delivery: null, pickup_point: 'Example Town', weight_kg: 0.02 });
    expect(result.delivered_at).toBeUndefined();
    expect(result.history_truncated).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-03-06', '91', 'delivered', 'carrier_map', 'Example Town'],
      // Rows of one day come oldest first; a notice keeps the stage of the row before it.
      ['2026-03-04', '43', 'ready_for_pickup', 'none', null],
      ['2026-03-04', '42', 'ready_for_pickup', 'none', null],
      ['2026-03-04', '82', 'ready_for_pickup', 'carrier_map', 'Example Town'],
      ['2026-03-04', '53', 'out_for_delivery', 'carrier_map', 'Example Town'],
      ['2026-03-04', '51', 'in_transit', 'carrier_map', 'Example Town'],
      ['2026-03-03', '-F', 'in_transit', 'carrier_map', null],
      ['2026-03-03', '21', 'accepted', 'carrier_map', 'Sample City 1'],
      ['2026-03-02', '-M', 'registered', 'carrier_map', null],
    ]);
    expect(result.events!.every(event => !('time' in event))).toBe(true);
    const kept = JSON.stringify(result);
    for (const dropped of ['99901', '99902', '999000111', 'Example Town post office', '2026-03-19', 'example line', 'nbsp']) {
      expect(kept, dropped).not.toContain(dropped);
    }
  });

  it('names the office an item waits at while it waits there', () => {
    const result = parseCeskaPosta(edited('collected', item => { item.states.state = item.states.state.filter(row => row.id !== '91'); }), COLLECTED);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Example Town',
      last_status_text: 'The consignment was deposited - addressee not at home.', last_update_local: '2026-03-04' });
  });

  it('reads a Balíkovna item sent back as returned, without a pickup point or the courier’s position', () => {
    const result = parseCeskaPosta(JSON.parse(text('returned')), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'The consignment was returned to the sender.',
      last_update_local: '2026-02-11', weight_kg: 0.58 });
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-02-11', '9V', 'returned', 'carrier_map', 'Depo Example 704'],
      ['2026-02-10', '51', 'in_transit', 'carrier_map', 'Depo Example 704'],
      ['2026-02-09', 'P3', 'exception', 'carrier_map', 'Example Town Box Sample Street'],
      ['2026-02-06', '43', 'ready_for_pickup', 'none', null],
      ['2026-02-05', '43', 'ready_for_pickup', 'none', null],
      ['2026-02-05', 'P2', 'ready_for_pickup', 'carrier_map', 'Example Town Box Sample Street'],
      ['2026-02-05', 'QB', 'out_for_delivery', 'none', null],
      ['2026-02-05', '53', 'out_for_delivery', 'carrier_map', 'Depo Example 71'],
      ['2026-02-05', '43', 'in_transit', 'none', null],
      ['2026-02-05', '51', 'in_transit', 'carrier_map', 'Depo Example 71'],
      ['2026-02-05', '-B', 'in_transit', 'carrier_map', null],
      ['2026-02-05', '-I', 'in_transit', 'carrier_map', 'Example sorting centre'],
      ['2026-02-04', '43', 'in_transit', 'none', null],
      ['2026-02-04', '-F', 'in_transit', 'carrier_map', null],
      ['2026-02-04', '21', 'accepted', 'carrier_map', 'Depo Example 701'],
      ['2026-02-02', '-M', 'registered', 'carrier_map', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/49\.12|17\.76|10:11:12|9990[3-7]/);
    // A delivery after the item was sent back is the sender's.
    const delivered = parseCeskaPosta(edited('returned', item => {
      item.states.state = item.states.state.map(row => (row.id === '9V' ? { ...row, id: '91', text: 'Delivery of the consignment.' } : row));
    }), RETURNED);
    expect(delivered).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(delivered.pickup_point).toBeUndefined();
    // Collected from the box: the box is the pickup point.
    const collected = parseCeskaPosta(edited('returned', item => {
      item.states.state = [...item.states.state.slice(0, 11),
        { id: '91', date: '2026-02-06', text: 'Delivery of the consignment.', postoffice: 'Example Town Box Sample Street', publicAccess: 1 }];
    }), RETURNED);
    expect(collected).toMatchObject({ current_stage: 'delivered', pickup_point: 'Example Town Box Sample Street' });
  });

  it('reads the sender’s data alone as a registered item', async () => {
    expect(parseCeskaPosta(JSON.parse(text('pre-advice')), PRE_ADVICE)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'Receipt of data about consignment.', last_update: null,
      last_update_local: '2026-03-10', expected_delivery: null,
      events: [{ local_time: '2026-03-10', description: 'Receipt of data about consignment.', provider_code: '-L', stage: 'registered', stage_source: 'carrier_map' }] });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('pre-advice')));
    await expect(carrier(fetcher).recognize!(PRE_ADVICE)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-10T00:00:00' });
  });

  it('keeps new and uncertain codes visible without a stage, drops repeated rows and caps long histories', () => {
    const result = parseCeskaPosta(edited('collected', item => {
      item.states.state.push({ id: '88', date: '2026-03-07', text: 'The consignment left the register.' },
        { id: 'Z9', date: '2026-03-08', text: '' }, { ...item.states.state[8]! });
    }), COLLECTED);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Z9', last_update_local: '2026-03-08' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events!.slice(0, 3)).toEqual([
      { local_time: '2026-03-08', description: 'Z9', provider_code: 'Z9' },
      { local_time: '2026-03-07', description: 'The consignment left the register.', provider_code: '88' },
      { local_time: '2026-03-06', description: 'Delivery of the consignment.', provider_code: '91', location: 'Example Town', stage: 'delivered', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.filter(event => event.provider_code === '91')).toHaveLength(1);
    const long = parseCeskaPosta(edited('collected', item => {
      item.states.state.unshift(...Array.from({ length: 120 }, (_, index) => ({ id: '-F', date: '2026-03-03', text: `The consignment is transported ${index}.` })));
    }), COLLECTED);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ current_stage: 'delivered', history_truncated: true });
  });

  it('reads the no-record notice alone as a missing item, and other notices as inconclusive', async () => {
    expect(() => parseCeskaPosta(JSON.parse(text('not-found')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('collected'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-06T00:00:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const withheld = edited('not-found', item => { item.states.state[0] = { id: '-4', date: '2026-03-10', text: 'Czech Post does not display information for this consignment type.' }; });
    expect(() => parseCeskaPosta(withheld, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = edited('collected', item => { item.states.state.push({ id: '-3', date: '2026-03-10', text: 'There is no record for a consignment with this posting number.' }); });
    expect(() => parseCeskaPosta(mixed, COLLECTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = edited('collected', item => { item.states.state = item.states.state.filter(row => row.id === '-1'); });
    expect(() => parseCeskaPosta(empty, COLLECTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCeskaPosta({ ident: 1, text: 'Error' }, COLLECTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the answer to the whole requested number and rejects malformed items', () => {
    expect(() => parseCeskaPosta(JSON.parse(text('collected')), 'RR900000022CZ')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (item: Item) => { delete item.id; },
      (item: Item) => { item.states.state[0]!.date = '2026-02-30'; },
      (item: Item) => { item.states.state[0]!.date = '04.03.2026'; },
      (item: Item) => { item.states.state[0]!.id = 'not a code'; },
      (item: Item) => { (item as { states: unknown }).states = []; },
      (item: Item) => { (item.states.state as unknown[])[0] = 'row'; },
      (_item: Item, payload: Item[]) => { payload.push(JSON.parse(text('pre-advice'))[0]); },
    ]) expect(() => parseCeskaPosta(edited('collected', change), COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, 'item', {}]) expect(() => parseCeskaPosta(payload, COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('[]', status));
      await expect(carrier(fetcher).track({ number: COLLECTED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(COLLECTED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 0000</body></html>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['{"items":[]}', 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
      await expect(carrier(fetcher).recognize!(COLLECTED), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: COLLECTED })).rejects.toThrow('unexpectedly large');
  });

  it('takes its own item numbers and S10 codes, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['RR900000018CZ', 'DR900000002U', 'DR90000000021U', 'D19000000002U', '123456789012', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const number = new URL(String(url)).searchParams.get('idParcel')!;
      return reply(JSON.stringify(edited('not-found', item => { item.id = number; })));
    });
    for (const number of ['RR900000019DE', 'BA9000000001X', 'NP9000000001C', UNKNOWN]) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(any.mock.calls.map(([url]) => String(url))).toEqual(['RR900000019DE', 'BA9000000001X', 'NP9000000001C', UNKNOWN].map(ceskaPostaUrl));
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

  it('routes an item filed under Česká pošta to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('returned')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: RETURNED, carrier: 'ceska-posta' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ceska-posta', source: 'ceska-posta', result: { current_stage: 'returned' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === ceskaPostaUrl(RETURNED))).toBe(true);
  });

  it('claims its domestic numbers and is asked about Czech S10 codes, which detection leaves with the postal fallback', () => {
    expect(detectCarrierMatch(RETURNED)).toMatchObject({ carrier: 'ceska-posta', confidence: 'high' });
    for (const prefix of ['NB', 'NP', 'NR']) {
      expect(detectCarrierMatch(`${prefix}9000000002U`)).toMatchObject({ carrier: 'ceska-posta', confidence: 'high' });
    }
    for (const prefix of ['NA', 'RR', 'LF']) {
      expect(detectCarrierMatch(`${prefix}9000000002U`).candidates).not.toContain('ceska-posta');
    }
    expect(detectCarrierMatch(COLLECTED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(COLLECTED)).toContain('ceska-posta');
    expect(recognitionAskedCarriers('RR900000018CZ')).not.toContain('ceska-posta');
    expect(recognitionAskedCarriers('RR900000019DE')).not.toContain('ceska-posta');
    expect(parseTrackingInput(`https://www.postaonline.cz/trackandtrace/-/zasilka/${RETURNED}`))
      .toMatchObject({ trackingNumber: RETURNED, carrier: 'ceska-posta', source: 'link' });
  });
});

describe('Česká pošta status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(stage);
      expect(ceskaPostaCodeStage(entry.code), entry.code).toBe(stage);
    }
    for (const code of ['constructor', 'toString', '__proto__']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage(null, 'the consignment is being delivered.')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'ceska-posta', providerCode: 'P2', description: 'The consignment was deposited to Balíkovna.' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    for (const code of ['42', '43', 'QB', '88']) {
      expect(statusMapAnswer({ carrier: 'ceska-posta', providerCode: code, description: 'Any wording' }), code).toMatchObject({ kind: 'intentional_gap' });
    }
  });
});
