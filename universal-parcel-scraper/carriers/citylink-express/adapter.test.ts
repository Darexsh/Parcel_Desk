import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CITYLINK_API, CitylinkTracker } from './adapter.js';
import { citylinkCode, citylinkWording, normalizeCitylinkNumber, parseCitylink } from './parser.js';
import { citylinkStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '960300000000002';
const IN_TRANSIT = '960300000000001';
const UNKNOWN = '060300000000000';

type Row = Record<string, unknown>;
type Data = Row & { trackDetails: Row[] };
type Reply = { req: Row & { data: Data } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Data, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.req.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('City-Link Express HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CitylinkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9603 0000 0000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(CITYLINK_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ tracking: IN_TRANSIT, xr_option: 'false' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'citylink-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the delivery newest first, dated on Malaysia’s clock, without the people it names or the repeated scan', () => {
    const result = parseCitylink(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package Delivered', last_update: '2026-03-07T15:20:30+08:00', expected_delivery: null,
      delivered_at: '2026-03-07T15:20:30+08:00', weight_kg: 1.25 });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-03-07T15:20:30+08:00', 'DL:91', 'delivered', 'Package Delivered'],
      ['2026-03-07T09:44:00+08:00', 'OD', 'out_for_delivery', 'With City-Link delivery courier'],
      ['2026-03-06T17:15:00+08:00', 'SP:60', 'failed_attempt', 'Unable To Contact Receiver At Primary Number'],
      ['2026-03-06T10:05:12+08:00', 'OD', 'out_for_delivery', 'With City-Link delivery courier'],
      ['2026-03-06T09:10:30+08:00', 'RV', 'in_transit', 'At City-Link local facility'],
      ['2026-03-06T01:15:02+08:00', 'HD', 'in_transit', 'Departed sorting facility'],
      ['2026-03-05T20:30:00+08:00', 'CR', 'in_transit', 'At City-Link local facility'],
      // Singapore keeps Malaysia's clock, whichever of the two stamped the scan.
      ['2026-03-05T06:12:45+08:00', 'OB', 'in_transit', 'Departed City-Link origin facility'],
      ['2026-03-04T14:32:10+08:00', 'PK', 'in_transit', 'Arrived City-Link facility'],
      // The shipper's record has no place to settle its clock.
      ['2026-03-03T10:15:00', 'SR', 'registered', 'Shipment information sent to City-Link'],
    ]);
    expect(result.events![0]).toMatchObject({ location: 'Sample Town, Malaysia' });
    expect(result.events!.at(-1)!.location).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Courier|Person)|SAMPLE PERSON|Signed for/);
  });

  it('reads an in-transit parcel and drops the shipper’s record prefix', () => {
    const result = parseCitylink(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'At City-Link local facility',
      last_update: '2026-03-11T18:07:45+08:00', weight_kg: 0.4 });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events).toHaveLength(6);
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-03-09T21:30:05', description: 'Packed', provider_code: 'SR',
      stage: 'registered', stage_source: 'carrier_map' });
  });

  it('dates a scan only where its country keeps Malaysia’s clock', () => {
    const result = parseCitylink(changed('in-transit', (data) => {
      data.trackDetails[5]!.location = 'Sample Town, Thailand';
      data.trackDetails[4]!.location = 'Sample Town, Brunei';
      data.trackDetails[3]!.location = 'Sample Hub';
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-03-11T18:07:45' });
    expect(result.events!.slice(0, 3).map((event) => [event.time ?? null, event.local_time ?? null])).toEqual([
      [null, '2026-03-11T18:07:45'], ['2026-03-11T05:45:00+08:00', null], [null, '2026-03-11T03:25:11'],
    ]);
  });

  it('takes couriers, signers and phone numbers out of the wording', () => {
    expect(citylinkWording('With City-Link delivery courier: Sample Courier')).toBe('With City-Link delivery courier');
    expect(citylinkWording('Package Delivered - Signed for by: Sample Person')).toBe('Package Delivered');
    expect(citylinkWording('Received by: Sample Person')).toBe('Received by');
    expect(citylinkWording('Received by')).toBe('Received by');
    expect(citylinkWording('Delivered, received by Sample Person at the door')).toBe('Delivered');
    expect(citylinkWording('Rider: Sample Rider 000-000 0000')).toBe('Rider');
    expect(citylinkWording('Call the branch on +00 0-000 0000 to arrange delivery')).toBe('Call the branch on to arrange delivery');
    expect(citylinkWording('SR - Shipped')).toBe('Shipped');
    expect(citylinkWording('Courier unable to deliver')).toBe('Courier unable to deliver');
    expect(citylinkCode({ CP_Code: 'sp', DisposeCode: '60' })).toBe('SP:60');
    expect(citylinkCode({ CP_Code: 'PK', DisposeCode: '' })).toBe('PK');
  });

  it('reads the tracker’s 404 as not found, and a record without scans as no history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseCitylink(changed('delivered', (data) => { data.trackDetails = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseCitylink(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCitylink(changed('in-transit', (data) => { data.trackingNo = '960300000000009'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'City-Link answered for another shipment' }));
    expect(parseCitylink(changed('in-transit', (data) => { data.trackingNo = ` ${IN_TRANSIT} `; }), IN_TRANSIT).events).toHaveLength(6);
  });

  it('keeps a failed lookup inconclusive', () => {
    expect(() => parseCitylink(changed('in-transit', (data) => { data.returncode = '01'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCitylink(changed('in-transit', (_data, body) => { body.req.status = 500; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Data, body: Reply) => { delete (body as Partial<Reply>).req; },
      (_data: Data, body: Reply) => { body.req.data = null as never; },
      (data: Data) => { delete data.returncode; },
      (data: Data) => { delete data.trackingNo; },
      (data: Data) => { data.trackingNo = 960300000000001; },
      (data: Data) => { data.trackDetails = 'scans' as never; },
      (data: Data) => { delete (data as Partial<Data>).trackDetails; },
      (data: Data) => { data.trackDetails = Array.from({ length: 501 }, () => data.trackDetails[0]!); },
      (data: Data) => { data.trackDetails[0] = 'scan' as never; },
      (data: Data) => { data.trackDetails[0]!.detDate = '2026-03-09'; },
      (data: Data) => { data.trackDetails[0]!.detDate = '31/02/2026'; },
      (data: Data) => { data.trackDetails[0]!.detTime = '21:30'; },
      (data: Data) => { data.trackDetails[0]!.detTime = '240000'; },
      (data: Data) => { data.trackDetails[0]!.status = ['Packed']; },
      (data: Data) => { data.trackDetails[0]!.status = ''; },
      (data: Data) => { data.trackDetails[0]!.location = 7; },
    ]) {
      expect(() => parseCitylink(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a missing route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // WordPress's answer for a route it does not have, and any other 404, is a moved route.
    await expect(lookup({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } },
      { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Page not found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(fixture('not-found'), { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.citylinkexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // A not-found body with HTTP 200 is no answer the tracker gives.
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>City-Link Express</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number City-Link does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-03-07T07:20:30.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('96030000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers City-Link does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['96030000000000', '9603000000000001', 'MY960300000000', 'SAMPLETRACKING', '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCitylinkNumber('9603-0000-0000-001')).toBe(IN_TRANSIT);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under City-Link to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'citylink-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'citylink-express', source: 'citylink-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === CITYLINK_API)).toBe(true);
  });
});

describe('City-Link Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const code = ('code' in entry ? entry.code : undefined) ?? null;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(citylinkStage(code ?? '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'citylink-express', providerCode: 'SP:60', description: 'Unable To Contact Receiver At Primary Number' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    // A code's family stages it whatever its disposal code, apart from a problem scan's.
    expect(citylinkStage('DL:00', 'Synthetic note')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(citylinkStage('SP:99', 'Synthetic note')).toBeNull();
    expect(citylinkStage('SP:99', 'Unable to access premises')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'citylink-express', providerCode: 'ZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(citylinkStage('ZZ', 'Delivered')).toMatchObject({ stage: 'delivered' });
  });
});
