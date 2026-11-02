import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BEX_HISTORY_API, BexExpressTracker, bexLookupUrl } from './adapter.js';
import { normalizeBexNumber, parseBex } from './parser.js';
import { bexLabel, bexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900000017';
const IN_TRANSIT = '900000025';
const UNKNOWN = '000000000';

type Row = Record<string, unknown>;
type Reply = Row & { listShipmentHistory: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (rows: Row[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.listShipmentHistory, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (statusCode: number, scanCode: number, statusName: string, timeStamp: string, shipmentId = 900000025) => ({
  shipmentId, statusCode, scanCode, reasonCode: 0, statusName, statusDate: timeStamp.slice(0, 10), statusLocation: 'Exampleburg', timeStamp, timeZone: 'GMT+2',
});

describe('BEX Express HTTP adapter', () => {
  it('asks the history lookup for the whole number once, with the tracking page’s token, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BexExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 900 000 025 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BEX_HISTORY_API}?trackingValue=${IN_TRANSIT}`);
    expect(bexLookupUrl('900-000-025')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect((init!.headers as Record<string, string>)['X-Auth-Token']).toMatch(/^[\da-z]{8}(?:-[\da-z]{4}){3}-[\da-z]{12}$/);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bex-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('labels each scan as the tracking page does, dates it with its stated offset and keeps no recipient detail', () => {
    const result = parseBex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Isplaćena otkupnina', last_update: '2026-03-20T10:00:00+01:00', expected_delivery: null,
      delivered_at: '2026-03-11T11:20:33+01:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-03-20T10:00:00+01:00', '31', 'Isplaćena otkupnina', undefined],
      ['2026-03-12T07:00:00+01:00', '21:109', 'Otkup za isplatu', undefined],
      ['2026-03-11T11:20:33+01:00', '21', 'Dostavljena pošiljka', 'delivered'],
      ['2026-03-11T08:01:40+01:00', '11:3', 'Preuzeto - Kod kurira na dostavi', 'out_for_delivery'],
      ['2026-03-10T15:30:12+01:00', '11:100', 'Preuzeto - Neuspela dostava', 'failed_attempt'],
      ['2026-03-10T08:05:00+01:00', '11:3', 'Preuzeto - Kod kurira na dostavi', 'out_for_delivery'],
      ['2026-03-10T06:12:44+01:00', '11:10', 'Preuzeto - Pošiljka u centru dostave', 'in_transit'],
      ['2026-03-09T21:40:05+01:00', '11:11', 'Preuzeto - Tranzitira ka centru dostave', 'in_transit'],
      ['2026-03-09T14:02:11+01:00', '11', 'Preuzeto', 'accepted'],
      ['2026-03-09T09:15:20+01:00', '1', 'Evidentirano', 'registered'],
    ]);
    expect(result.events!.map((event) => event.location)).toContain('Hubville');
    expect(result.events!.every((event) => event.local_time === undefined && (!event.stage || event.stage_source === 'carrier_map'))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Samp\*|060000|žiro|Primalac|Otkup je/i);
  });

  it('follows a parcel from abroad through customs, and orders scans on one clock as the reply does', () => {
    const result = parseBex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Preuzeto - Pošiljka u centru dostave', last_update: '2026-05-07T06:40:00+02:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.description, event.stage])).toEqual([
      ['11:15', 'Preuzeto - Pošiljka u centru dostave', 'in_transit'],
      ['11:8', 'Preuzeto - Pošiljka je u tranzitu do centra dostave', 'in_transit'],
      ['11:51', 'Preuzeto - Pošiljka preuzeta iz carine i Bex-u', 'in_transit'],
      ['1:51', 'Evidentirano - Predato Bex-u sa carine', 'in_transit'],
      ['-51:105', 'Evidentirano - Ocarinjeno', 'in_transit'],
      ['-51:104', 'Evidentirano - U procesu carinjenja', 'customs'],
      ['-51:103', 'Evidentirano - Stiglo na carinu', 'customs'],
      ['-51', 'Evidentirano – Ino tranzit', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Exam\*|060000|Primalac|očekivati/i);
  });

  it('keeps a wall clock without a usable offset local, and a timestamp’s own offset as it is', () => {
    const local = parseBex(changed('in-transit', (rows) => { rows[7]!.timeZone = null; rows[6]!.timeZone = 'Central Europe'; }), IN_TRANSIT);
    expect(local).toMatchObject({ last_update: null, last_update_local: '2026-05-07T06:40:00' });
    expect(local.events!.slice(0, 2).map((event) => [event.time, event.local_time])).toEqual([
      [undefined, '2026-05-07T06:40:00'], [undefined, '2026-05-06T22:15:30']]);
    const own = parseBex(changed('in-transit', (rows) => {
      rows[7]!.timeStamp = '2026-05-07T04:40:00.25Z';
      rows[6]!.timeStamp = '2026-05-06T22:15:30+02:00';
      rows[5]!.timeZone = 'gmt +2:00';
    }), IN_TRANSIT);
    expect(own.events!.slice(0, 3).map((event) => event.time)).toEqual(['2026-05-07T04:40:00Z', '2026-05-06T22:15:30+02:00', '2026-05-06T12:00:00+02:00']);
  });

  it('reads cancellations, returns, checks and the payout by their codes, and leaves a scan the page does not name to the wording rules', () => {
    const at = (...rows: Row[]) => parseBex(changed('in-transit', (list) => { list.push(...rows); }), IN_TRANSIT);
    expect(at(scan(0, 0, 'Stornirana', '2026-05-08T09:00:00'))).toMatchObject({ current_stage: 'exception', last_status_text: 'Otkazano' });
    expect(at(scan(-21, 4, 'Za PP', '2026-05-08T09:00:00'))).toMatchObject({ current_stage: 'exception', last_status_text: 'Evidentirano - na proveri podataka' });
    expect(at(scan(25, 0, 'Vratiti pošiljaocu', '2026-05-08T09:00:00'))).toMatchObject({ current_stage: 'returned', status: 'exception' });
    expect(at(scan(30, 2, 'Vraćena pošiljaocu', '2026-05-08T09:00:00'))).toMatchObject({ current_stage: 'returned', last_status_text: 'Vraćena pošiljka' });
    expect(at(scan(11, 46, 'Preuzeto', '2026-05-08T09:00:00'))).toMatchObject({ current_stage: 'ready_for_pickup', status: 'out_for_delivery' });
    // A scan of a named status that the map does not know keeps the page's label and no stage.
    const unknownScan = at(scan(11, 999, 'Preuzeto', '2026-05-08T09:00:00'));
    expect(unknownScan).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Preuzeto' });
    expect(unknownScan.events![0]).toMatchObject({ provider_code: '11:999', description: 'Preuzeto' });
    expect(unknownScan.events![0]!.stage).toBeUndefined();
    // A status the page does not name keeps its own name, which the shared wording rules read.
    expect(at(scan(77, 0, 'Dostavljeno', '2026-05-08T09:00:00')).events![0]).toMatchObject({ provider_code: '77', description: 'Dostavljeno primaocu' });
    expect(at(scan(77, 0, 'Synthetic status', '2026-05-08T09:00:00')).events![0]).toMatchObject({ description: 'Synthetic status' });
    // The page hides status -41.
    expect(at(scan(-41, 0, 'Synthetic hidden', '2026-05-08T09:00:00')).events).toHaveLength(8);
    // A repeated scan is kept once.
    expect(at(scan(11, 15, 'Preuzeto', '2026-05-07T06:40:00')).events).toHaveLength(8);
  });

  it('reads an unknown number as not found and a shipment without scans as no history', () => {
    expect(() => parseBex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBex(changed('delivered', (_rows, body) => { body.listShipmentHistory = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseBex(changed('delivered', (_rows, body) => { body.listShipmentHistory = null as never; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseBex({ eventPrediction: '', listShipmentHistory: [scan(-41, 0, 'Synthetic hidden', '2026-05-08T09:00:00')] }, IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a history only when every scan names the number asked', () => {
    expect(() => parseBex(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'BEX Express answered for another shipment' }));
    expect(() => parseBex(changed('in-transit', (rows) => { rows[3]!.shipmentId = 900000033; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The service names a shipment as a whole number, without leading zeroes.
    expect(parseBex({ listShipmentHistory: [scan(1, 0, 'Evidentirano', '2026-05-08T09:00:00', 17)] }, '000000017'))
      .toMatchObject({ current_stage: 'registered' });
    expect(parseBex(changed('in-transit', (rows) => { rows[0]!.shipmentId = IN_TRANSIT; }), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_rows: Row[], body: Reply) => { delete (body as Row).listShipmentHistory; },
      (_rows: Row[], body: Reply) => { body.listShipmentHistory = 'scans' as never; },
      (rows: Row[]) => { rows[1] = 'scan' as never; },
      (rows: Row[]) => { delete rows[1]!.shipmentId; },
      (rows: Row[]) => { rows[1]!.shipmentId = 'SYNTHETIC'; },
      (rows: Row[]) => { rows[1]!.shipmentId = 9.5; },
      (rows: Row[]) => { delete rows[1]!.statusCode; },
      (rows: Row[]) => { rows[1]!.statusCode = '11a'; },
      (rows: Row[]) => { rows[1]!.scanCode = 3.5; },
      (rows: Row[]) => { rows[1]!.statusName = ['Carina']; },
      (rows: Row[]) => { rows[1]!.statusCode = 77; rows[1]!.statusName = ' '; },
      (rows: Row[]) => { rows[1]!.statusLocation = { town: 'Hubville' }; },
      (rows: Row[]) => { rows[1]!.timeStamp = '05.05.2026 08:30'; },
      (rows: Row[]) => { rows[1]!.timeStamp = '2026-05-05T24:00:00'; },
      (rows: Row[]) => { rows[1]!.timeStamp = '2026-02-30T08:30:00'; },
      (rows: Row[]) => { rows[1]!.timeStamp = '2026-05-05T08:30:00+25:00'; },
      (rows: Row[]) => { rows[1]!.timeStamp = null; },
      (rows: Row[]) => { rows[1]!.timeZone = 2; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 500 }, () => rows[1]!)); },
    ]) {
      expect(() => parseBex(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBex('[]', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A missing scan code is scan 0; the summary is never read.
    expect(parseBex(changed('in-transit', (rows, body) => { delete rows[7]!.scanCode; body.eventPrediction = { synthetic: true }; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'accepted', last_status_text: 'Preuzeto' });
  });

  it('keeps an unknown number, a refused request, a refused token, a moved route and a browser check apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 400 })).rejects.toMatchObject({ kind: 'not_found' });
    // The validation error ASP.NET answers a request without the number.
    await expect(lookup({ title: 'One or more validation errors occurred.', status: 400, errors: { trackingValue: ['The trackingValue field is required.'] } },
      { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ message: 'User with this token doesn\'t exist.' }, { status: 401 })).rejects.toMatchObject({ kind: 'challenge', status: 401 });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://bexexpress.rs/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Synthetic error page</body></html>', { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"eventPrediction":""}')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its last activity and the unknown-number answer, and asks nothing for a number BEX does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 400 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-20T09:00:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('90000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers BEX Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['90000001', '9000000170', 'BEX900000017', 'SAMPLETRACKING', '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBexNumber('900-000 017')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the service once more', async () => {
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

  it('routes a number filed under BEX Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'bex-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'bex-express', source: 'bex-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(BEX_HISTORY_API))).toBe(true);
  });
});

describe('BEX Express status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the payouts it leaves out', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) continue;
      const [status, scanCode = '0'] = entry.code.split(':');
      if (Number(status) !== 0) expect(bexLabel(Number(status), Number(scanCode), 'Synthetic'), entry.code).toBe(entry.wording);
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(bexStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'bex-express', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(bexStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(bexLabel(0, 0, 'Stornirana')).toBe('Otkazano');
    expect(statusMapAnswer({ carrier: 'bex-express', providerCode: '11:3', description: 'Preuzeto - Kod kurira na dostavi' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'bex-express', providerCode: '30:2', description: 'Vraćena pošiljka' })).toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'bex-express', providerCode: '31:4', description: 'Isplaćena otkupnina' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'bex-express', providerCode: '11:999', description: 'Preuzeto' })).toEqual({ kind: 'unknown' });
    expect(bexStage('11:999', 'Preuzeto')).toBeNull();
    expect(bexStage('77', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(bexStage('77', 'Dostavljeno primaocu')).toBeNull();
    expect(bexStage('77', 'Synthetic status')).toBeNull();
  });
});
