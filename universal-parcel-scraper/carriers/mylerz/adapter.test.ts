import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MYLERZ_HOSTS, mylerzTrackingUrl, MylerzTracker } from './adapter.js';
import { normalizeMylerzNumber, parseMylerz } from './parser.js';
import { mylerzStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '63000000000101';
const IN_TRANSIT = '63000000000202';
const UNKNOWN = '63000000000303';
const [EGYPT, MOROCCO, ALGERIA, JORDAN] = MYLERZ_HOSTS;

type Row = Record<string, unknown>;
type Shipment = Row & { PackageTrackingShipmentDetails: Row; PackageStatusLog: Row[] };
type Reply = Row & { Value: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (value: Shipment, body: Reply) => void) => {
  const body = fixture(name);
  change(body.Value, body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const hostOf = (input: Parameters<typeof fetch>[0]) => new URL(input instanceof Request ? input.url : String(input)).hostname;
/** Each instance answers by its host; an instance not named does not know the barcode. */
const instances = (answers: Partial<Record<(typeof MYLERZ_HOSTS)[number], () => Response | Promise<Response>>>) =>
  vi.fn<typeof fetch>(async (input) => (answers[hostOf(input) as (typeof MYLERZ_HOSTS)[number]] ?? (() => reply(fixture('not-found'))))());
const asked = (fetcher: ReturnType<typeof instances>) => fetcher.mock.calls.map(([input]) => hostOf(input));

describe('Mylerz HTTP adapter', () => {
  it('asks Egypt’s instance for the whole barcode once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MylerzTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 6300-0000 0002.02 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.mylerz.net/api/package/GetPackageTrackingDetailsByBarCode?barcode=${IN_TRANSIT}`);
    expect(mylerzTrackingUrl(JORDAN, IN_TRANSIT)).toBe(`https://api.jordan.mylerz.net/api/package/GetPackageTrackingDetailsByBarCode?barcode=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mylerz', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock to the second and stages it by its consumer status', () => {
    const result = parseMylerz(fixture('in-transit'), IN_TRANSIT);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'In-Transit',
      last_update: null, last_update_local: '2026-05-12T06:15:00', expected_delivery: null,
      events: [
        { local_time: '2026-05-12T06:15:00', description: 'In-Transit', provider_code: '3', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-05-11T09:30:00', description: 'Picked from shipper', provider_code: '7', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-05-10T20:01:02', description: 'Uploaded', provider_code: '12', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps the delivery without the address, the courier, the calls, the merchant, the cash or the repeated scan', () => {
    const result = parseMylerz(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Enjoy it :-)', last_update: null, last_update_local: '2026-04-02T13:20:41', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-04-02T13:20:41', '2', 'delivered'],
      ['2026-04-02T10:05:12', '4', 'out_for_delivery'],
      ['2026-04-02T04:10:00', '3', 'in_transit'],
      ['2026-04-01T18:33:27', '7', 'accepted'],
      ['2026-04-01T11:14:09', '12', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Street|Building|Shop|Courier|District|Hub|City|Merchant)|0100000000|450|Cash|Received by Myler|Answered/);
    const transit = JSON.stringify(parseMylerz(fixture('in-transit'), IN_TRANSIT));
    expect(transit).not.toMatch(/Sample (?:Driver|Road|Store|Depot)|01000000002|example\.invalid|780|Morning|2026-05-13/);
  });

  it('reads a history listed oldest first newest first, as the tracker shows it', () => {
    const result = parseMylerz(changed('delivered', (value) => { value.PackageStatusLog.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update_local: '2026-04-02T13:20:41', current_stage: 'delivered' });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['2', '4', '3', '7', '12']);
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const result = parseMylerz(changed('in-transit', (value) => {
      value.PackageStatusLog.reverse();
      value.PackageStatusLog[1]!.ChangedDate = value.PackageStatusLog[0]!.ChangedDate;
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['3', '7', '12']);
  });

  it('stages a status the map does not know by its wording, else leaves it without a stage', () => {
    const unknown = parseMylerz(changed('in-transit', (value) => {
      Object.assign(value.PackageStatusLog[0]!, { StatusBusId: 99, StatusBusEnName: 'Synthetic note' });
    }), IN_TRANSIT);
    // The newest scan keeps its wording; the stage comes from the newest scan that has one.
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Synthetic note' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-12T06:15:00', description: 'Synthetic note', provider_code: '99' });
    const worded = parseMylerz(changed('in-transit', (value) => {
      Object.assign(value.PackageStatusLog[0]!, { StatusBusId: 99, StatusBusEnName: 'Delivered' });
    }), IN_TRANSIT);
    expect(worded.events![0]).toMatchObject({ provider_code: '99', stage: 'delivered', stage_source: 'wording:language' });
    // A scan without a consumer status shows the internal name, which stages nothing.
    const internal = parseMylerz(changed('in-transit', (value) => {
      Object.assign(value.PackageStatusLog[0]!, { StatusBusId: null, StatusBusEnName: null });
    }), IN_TRANSIT);
    expect(internal.events![0]).toEqual({ local_time: '2026-05-12T06:15:00', description: 'Received in Hub' });
    expect(parseMylerz(changed('in-transit', (value) => { value.PackageStatusLog[0]!.StatusBusId = '3'; }), IN_TRANSIT).events![0])
      .toMatchObject({ provider_code: '3', stage: 'in_transit' });
  });

  it('reads NOT_FOUND as not found, any other error as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseMylerz(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMylerz(fixture('failure'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMylerz({ ...fixture('not-found'), ErrorDescription: 'Synthetic failure' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMylerz({ ...fixture('not-found'), Value: {} }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const log of [[], null, undefined]) {
      expect(() => parseMylerz(changed('delivered', (value) => { value.PackageStatusLog = log as never; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('counts a shipment only when it names the barcode asked', () => {
    expect(() => parseMylerz(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Mylerz answered for another shipment' }));
    expect(parseMylerz(changed('in-transit', (value) => { value.PackageTrackingShipmentDetails.Barcode = Number(IN_TRANSIT); }), IN_TRANSIT).events)
      .toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_value: Shipment, body: Reply) => { delete body.IsErrorState; },
      (_value: Shipment, body: Reply) => { body.IsErrorState = 'false'; },
      (_value: Shipment, body: Reply) => { delete (body as Row).Value; },
      (_value: Shipment, body: Reply) => { body.Value = 'shipment' as never; },
      (value: Shipment) => { delete (value as Row).PackageTrackingShipmentDetails; },
      (value: Shipment) => { delete value.PackageTrackingShipmentDetails.Barcode; },
      (value: Shipment) => { value.PackageTrackingShipmentDetails.Barcode = null; },
      (value: Shipment) => { value.PackageStatusLog = 'scans' as never; },
      (value: Shipment) => { value.PackageStatusLog = Array.from({ length: 301 }, () => value.PackageStatusLog[0]!); },
      (value: Shipment) => { value.PackageStatusLog[0] = 'scan' as never; },
      (value: Shipment) => { value.PackageStatusLog[0]!.ChangedDate = '12/05/2026 06:15'; },
      (value: Shipment) => { value.PackageStatusLog[0]!.ChangedDate = '2026-02-30T06:15:00'; },
      (value: Shipment) => { value.PackageStatusLog[0]!.ChangedDate = '2026-05-12T24:00:00'; },
      (value: Shipment) => { value.PackageStatusLog[0]!.ChangedDate = '2026-05-12T06:15:00Z'; },
      (value: Shipment) => { delete value.PackageStatusLog[0]!.ChangedDate; },
      (value: Shipment) => { value.PackageStatusLog[0]!.StatusBusId = 'three'; },
      (value: Shipment) => { value.PackageStatusLog[0]!.StatusBusId = 3.5; },
      (value: Shipment) => { value.PackageStatusLog[0]!.StatusBusId = -3; },
      (value: Shipment) => { value.PackageStatusLog[0]!.StatusBusId = { id: 3 }; },
      (value: Shipment) => { value.PackageStatusLog[0]!.StatusBusEnName = ['In-Transit']; },
      (value: Shipment) => { Object.assign(value.PackageStatusLog[0]!, { StatusBusEnName: '', StatusEnName: null }); },
    ]) {
      expect(() => parseMylerz(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('asks the other countries’ instances only for a barcode Egypt’s does not know, and takes the one that has it', async () => {
    const abroad = instances({ [MOROCCO]: () => reply(fixture('in-transit')) });
    await expect(carrier(abroad).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(asked(abroad)[0]).toBe(EGYPT);
    expect(new Set(asked(abroad))).toEqual(new Set(MYLERZ_HOSTS));
    expect(abroad).toHaveBeenCalledTimes(4);
    // A history from one instance stands even when another failed.
    const partial = instances({ [EGYPT]: () => reply(fixture('failure')), [ALGERIA]: () => reply(fixture('delivered')) });
    await expect(carrier(partial).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    const twice = instances({ [EGYPT]: () => reply(fixture('failure')), [MOROCCO]: () => reply(fixture('delivered')),
      [JORDAN]: () => reply(fixture('delivered')) });
    await expect(carrier(twice).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'Mylerz has the barcode in more than one country' });
  });

  it('reads a barcode as not found only when every instance says so, and keeps the first other failure', async () => {
    const nowhere = instances({});
    await expect(carrier(nowhere).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(nowhere).toHaveBeenCalledTimes(4);
    const lookup = (answers: Parameters<typeof instances>[0]) => carrier(instances(answers)).track({ number: UNKNOWN });
    await expect(lookup({ [JORDAN]: () => reply('', { status: 429 }) })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup({ [ALGERIA]: () => reply(fixture('failure')), [JORDAN]: () => reply('', { status: 429 }) }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ [EGYPT]: () => reply('', { status: 503 }), [MOROCCO]: () => reply('', { status: 403 }) }))
      .rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup({ [MOROCCO]: () => reply('<html><body>The request is blocked.</body></html>', { headers: { 'Content-Type': 'text/html' } }) }))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps a moved route, a refusal, a browser check and a broken reply apart from a missing parcel', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(instances({ [EGYPT]: () => reply(body, init) })).track({ number: UNKNOWN });
    // The API reads a missing barcode from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://mylerz.net/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Forbidden</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><div class="cf-turnstile"></div></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Mylerz</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"Value":')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(8);
    });

  it('asks every instance once more after a failed connection, inside the caller’s budget', async () => {
    let failed = false;
    const flaky = instances({ [JORDAN]: () => {
      if (failed) return reply(fixture('not-found'));
      failed = true;
      throw new TypeError('fetch failed');
    } });
    await expect(carrier(flaky).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(flaky).toHaveBeenCalledTimes(8);
    const down = instances({ [MOROCCO]: () => { throw new TypeError('fetch failed'); } });
    await expect(carrier(down).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    expect(down).toHaveBeenCalledTimes(8);
  });

  it('recognizes a known barcode and the unknown-barcode answer, and asks nothing for a number Mylerz does not issue', async () => {
    const fetcher = instances({ [EGYPT]: () => reply(fixture('delivered')) });
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-02T13:20:41' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const nowhere = instances({});
    await expect(carrier(nowhere).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(nowhere).recognize!('MYLE00000001')).resolves.toEqual({ known: false });
    expect(nowhere).toHaveBeenCalledTimes(4);
  });

  it('rejects numbers Mylerz does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['6300000000010', '630000000001011', '64000000000101', 'MYLE00000001', `63${'0'.repeat(63)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMylerzNumber(' 6300 0000-0001.01 ')).toBe(DELIVERED);
  });

  it('ends hanging reads inside the budget and leaves none running', async () => {
    const clock = fakeBudgetClock();
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(hanging).track({ number: IN_TRANSIT }, { budgetMs: 60 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hanging.mock.calls.length).toBeLessThanOrEqual(8);
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await clock.settle(expect(carrier(hanging).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' }));
  });

  it('routes a barcode filed under Mylerz to the adapter', async () => {
    const fetcher = instances({ [EGYPT]: () => reply(fixture('delivered')) });
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'mylerz' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'mylerz', source: 'mylerz', result: { current_stage: 'delivered' } });
    expect(asked(fetcher)).toEqual([EGYPT]);
  });
});

describe('Mylerz numbers', () => {
  it('suggests Mylerz for fourteen digits starting 63 at low confidence, and asks it among the first carriers', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('mylerz');
      expect(recognitionAskedCarriers(number), number).toContain('mylerz');
    }
    for (const number of ['64000000000101', '6300000000010', '630000000001011']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('mylerz');
    }
  });
});

describe('Mylerz status vocabulary', () => {
  it('records every consumer status the map knows with the stage it gives, and the internal names it does not read', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(null, entry.wording!.toLowerCase()), entry.wording).toBeUndefined();
        continue;
      }
      expect(statusMap.stage(entry.code!, (entry.wording ?? '').toLowerCase()), entry.code).toBe(entry.stage);
      expect(mylerzStage(entry.code!, entry.wording ?? ''), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'mylerz', providerCode: '4', description: 'mylerz on the way' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'mylerz', providerCode: '99', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(mylerzStage('99', 'Synthetic note')).toBeNull();
    expect(mylerzStage('', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(mylerzStage('03', 'In-Transit')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });
});
