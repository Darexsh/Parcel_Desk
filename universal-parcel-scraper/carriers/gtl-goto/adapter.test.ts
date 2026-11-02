import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GTL_API, GtlTracker } from './adapter.js';
import { gtlRequestNumber, gtlWording, normalizeGtlNumber, parseGtl } from './parser.js';
import { gtlStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'GTL0000000001';
const IN_TRANSIT = 'TKGTL000000SAMPL';
const UNKNOWN = 'GTL0000000009';

type Row = Record<string, unknown>;
type Shipment = Row & { history: Row[] };
type Reply = Row & { data: Shipment };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (name: string, change: (data: Shipment, reply: Reply) => void) => {
  const body = fixture(name);
  change(body.data, body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const notFound = () => reply(text('not-found'), { status: 422 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GoTo Logistics HTTP adapter', () => {
  it('posts the number as GTL prints it to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('in-transit'))).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GtlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tkgtl-000000sampl ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(GTL_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    // The TKGTL number keeps the hyphen it is printed with.
    expect(JSON.parse(String(init!.body))).toEqual({ awb: 'TKGTL-000000SAMPL' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gtl-goto', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);

    await carrier(fetcher).track({ number: DELIVERED });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({ awb: DELIVERED });
  });

  it('keeps the delivery and each scan’s instant and hub, without the receiver, a phone or the repeated scan', () => {
    const result = parseGtl(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Paket sudah sampai dan diterima', last_update: '2026-03-12T07:41:09Z', expected_delivery: null });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.stage ?? null, event.location ?? null, event.description])).toEqual([
      ['2026-03-12T07:41:09Z', 'delivered', 'GTL Sample Hub', 'Paket sudah sampai dan diterima'],
      ['2026-03-12T03:05:00Z', 'out_for_delivery', 'GTL Sample Hub', 'Kurir sedang menuju lokasi pengantaran.'],
      ['2026-03-12T01:58:12Z', 'in_transit', 'GTL Sample Hub', 'Paket sudah berangkat dari GTL Sample Hub.'],
      ['2026-03-11T19:20:44Z', 'in_transit', 'GTL Sample Hub', 'Processed at delivery center'],
      ['2026-03-11T12:02:31Z', 'in_transit', 'GTL Sample Sortation', 'Arrived at sorting center'],
      // Ready for the next leg between two sorting centres, not for the recipient.
      ['2026-03-11T08:15:00Z', 'in_transit', 'GTL Sample Sortation', 'Parcel ready for pick-up'],
      // The hub's placeholder is no place.
      ['2026-03-11T06:40:10Z', 'in_transit', null, 'Shipment en route'],
      ['2026-03-11T05:53:27Z', 'in_transit', 'GTL Sample Sortation', 'Arrived at sorting center'],
      ['2026-03-11T05:43:02Z', 'accepted', null, 'Proceeding to carrier facility'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Person|Keluarga|0812|0000-0000/);
  });

  it('reads the current reply oldest first, staged by its codes, on local clocks and without people', () => {
    const result = parseGtl(fixture('current'), 'GTL0000000002');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Paket sudah sampai dan diterima', last_update: null, last_update_local: '2026-04-03T11:00:00' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code ?? null, event.stage, event.location])).toEqual([
      ['2026-04-03T11:00:00', 'signed_personally', 'delivered', 'GTL Other Hub'],
      ['2026-04-03T06:05:00', 'delivery_start', 'out_for_delivery', 'GTL Other Hub'],
      // The courier leaving the delivering hub: the code says out for delivery, the sentence in transit.
      ['2026-04-03T06:00:00', 'delivery_start', 'out_for_delivery', 'GTL Other Hub'],
      ['2026-04-02T23:00:00', 'station_inbound', 'in_transit', 'GTL Other Hub'],
      ['2026-04-02T16:00:00', 'sc_outbound', 'in_transit', 'Sample Sorting Center'],
      ['2026-04-02T04:00:00', 'sc_inbound', 'in_transit', 'Sample Sorting Center'],
      ['2026-04-01T22:00:00', 'pickup_station_out', 'in_transit', 'GTL Sample Hub'],
      ['2026-04-01T15:00:00', 'pickup_success', 'accepted', 'GTL Sample Hub'],
      ['2026-04-01T09:20:00', 'pickup_start', 'registered', 'GTL Sample Hub'],
      // The first scan has no code; its sentence says the order waits for the courier.
      ['2026-04-01T09:00:00', null, 'registered', 'GTL Sample Hub'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Person|Driver|Shop|Street)|0812|example\.invalid/);
  });

  it('reads the earlier reply’s location and a parcel between sorting centres', () => {
    const result = parseGtl(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Assigned to Transport', last_update: '2026-05-04T04:45:18Z' });
    expect(result.events!.map((event) => event.location ?? null)).toEqual([null, null, null, 'Sample Sorting Center', null]);
    expect(result.events!.at(-1)).toMatchObject({ description: 'Proceeding to carrier facility', stage: 'accepted' });
  });

  it('keeps a clock without an offset local, and reads epoch milliseconds as the page does', () => {
    const local = parseGtl(changed('in-transit', (data) => {
      data.history[0]!.date_time = '2026-05-04 11:45:18';
      data.history[1]!.date_time = '2026-05-04T09:11:52.000';
      data.history[2]!.date_time = Date.UTC(2026, 4, 4, 0, 52, 7);
    }), IN_TRANSIT);
    expect(local).toMatchObject({ last_update: null, last_update_local: '2026-05-04T11:45:18' });
    expect(local.events!.slice(0, 3).map((event) => [event.time ?? null, event.local_time ?? null])).toEqual([
      [null, '2026-05-04T11:45:18'],
      [null, '2026-05-04T09:11:52'],
      ['2026-05-04T00:52:07Z', null],
    ]);
    // An offset of the reply's own stays with its instant.
    const offset = parseGtl(changed('in-transit', (data) => { data.history[0]!.date_time = '2026-05-04T11:45:18+07:00'; }), IN_TRANSIT);
    expect(offset.events![0]!.time).toBe('2026-05-04T11:45:18+07:00');
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parseGtl(changed('delivered', (data) => { data.history.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-03-12T07:41:09Z' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Proceeding to carrier facility' });
  });

  it('takes the person a delivery names and phone numbers out of the wording', () => {
    expect(gtlWording('Paket sudah sampai dan diterima oleh Penerima sendiri.')).toBe('Paket sudah sampai dan diterima');
    expect(gtlWording('Successfully delivered to Sample Person')).toBe('Successfully delivered');
    expect(gtlWording('Delivered, received by Sample Person +62 812 0000 0000')).toBe('Delivered, received');
    expect(gtlWording('Hubungi kurir di 0812-0000-0000 untuk info')).toBe('Hubungi kurir di untuk info');
    // Other scans keep their words, and a date stays.
    expect(gtlWording('Shipment en route to sorting center')).toBe('Shipment en route to sorting center');
    expect(gtlWording('Jadwal ulang 2026-05-20')).toBe('Jadwal ulang 2026-05-20');
  });

  it('reads an unknown number as not found and a lookup that did not finish as inconclusive', () => {
    expect(() => parseGtl(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The service's own word that asking again may help.
    expect(() => parseGtl({ code: 5413, message: 'shipment not found', retryable: true }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGtl({ code: 5000, message: 'internal error', retryable: true }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGtl({ code: 200, data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGtl(changed('delivered', (data) => { data.history = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseGtl(changed('delivered', (data) => { delete (data as Row).history; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the whole number asked', () => {
    expect(() => parseGtl(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GoTo Logistics answered for another shipment' }));
    expect(() => parseGtl(changed('delivered', (data) => { data.awb = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGtl(changed('in-transit', (data) => { data.awb = 'TKGTL-000000SAMPX'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The number with or without its hyphen, in any case, is the same number.
    expect(parseGtl(changed('in-transit', (data) => { data.awb = 'tkgtl000000sampl'; }), 'TKGTL-000000SAMPL').events).toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Shipment, body: Reply) => { delete (body as Row).code; },
      (_data: Shipment, body: Reply) => { body.code = { value: 200 }; },
      (_data: Shipment, body: Reply) => { body.data = 'shipment' as never; },
      (data: Shipment) => { delete data.awb; },
      (data: Shipment) => { data.awb = 1; },
      (data: Shipment) => { data.history = 'history' as never; },
      (data: Shipment) => { data.history = Array.from({ length: 501 }, () => data.history[0]!); },
      (data: Shipment) => { data.history[0] = 'scan' as never; },
      (data: Shipment) => { data.history[0]!.date_time = '12/03/2026 07:41'; },
      (data: Shipment) => { data.history[0]!.date_time = '2026-02-30 07:41:09'; },
      (data: Shipment) => { data.history[0]!.date_time = '2026-03-12T24:00:00'; },
      (data: Shipment) => { data.history[0]!.date_time = 1_773_301_269; },
      (data: Shipment) => { delete data.history[0]!.date_time; },
      (data: Shipment) => { data.history[0]!.status = ['Delivered']; },
      (data: Shipment) => { data.history[0]!.status = ''; },
      (data: Shipment) => { data.history[0]!.hub_name = { name: 'GTL Sample Hub' }; },
    ]) {
      expect(() => parseGtl(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseGtl('reply', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a captcha, a moved route, a refusal and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'), { status: 422 })).rejects.toMatchObject({ kind: 'not_found' });
    // TikTok's gateway names its captcha in a header, whatever the status and body.
    const captcha = { 'bdturing-verify': '{"subtype":"slide","region":"sg"}' };
    await expect(lookup('', { headers: captcha })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(text('not-found'), { status: 422, headers: captcha })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fixture('delivered'), { headers: captcha })).rejects.toMatchObject({ kind: 'challenge' });
    // A GET of the lookup's address, or a moved route, is HTTP 404.
    await expect(lookup('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://gtl.id/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The lookup's refusal of a request without a number it can read.
    await expect(lookup({ code: 1212, message: '\'awb\' field is required', retryable: false }, { status: 400 }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><head><title>Access Denied</title></head></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>GoTo Logistics</title><div id="root"></div></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failure to reach GTL, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GtlTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gtl-goto', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('recognizes a known shipment and the not-found reply, and asks nothing for a number GTL does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(notFound());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T07:41:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('GTL000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers GTL does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['GTL000000001', 'GTL00000000001', 'GTL000000000A', 'TKGTL0000000000', 'TKGTL000000000000', 'TKP01F4DMKJT5', 'SAMPLETRACKING', `GTL${'0'.repeat(62)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGtlNumber(' tkgtl-000000sampl ')).toBe(IN_TRANSIT);
    expect(gtlRequestNumber(IN_TRANSIT)).toBe('TKGTL-000000SAMPL');
    expect(gtlRequestNumber('gtl 000 000 0001')).toBe(DELIVERED);
  });

  it('routes a number filed under GTL, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'gtl-goto' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gtl-goto', source: 'gtl-goto', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gtl-goto', source: 'gtl-goto' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === GTL_API)).toBe(true);
  });
});

describe('GoTo Logistics numbers', () => {
  it('claims TKGTL numbers with or without their hyphen, and GTL with ten digits', () => {
    for (const number of ['TKGTL-000000SAMPL', IN_TRANSIT, DELIVERED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'gtl-goto', confidence: 'high' });
    }
    for (const number of ['GTL000000001', 'GTL00000000001', 'TKGTL-000000SAMP', 'TKP01-F4DMKJT5']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('gtl-goto');
    }
  });
});

describe('GoTo Logistics status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      const code = entry.code ?? null;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(gtlStage(entry.wording, code)?.stage, entry.wording).toBe(entry.stage);
      // The adapter's own wording, without the receiver, keeps the stage.
      expect(gtlStage(gtlWording(entry.wording), code)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'gtl-goto', providerCode: null, description: 'Parcel ready for pick-up' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'gtl-goto', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared rules.
    expect(gtlStage('Out for delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(gtlStage('Synthetic note')).toBeNull();
  });
});
