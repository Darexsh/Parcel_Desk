import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PCP_EXPRESS_API, PcpExpressTracker } from './adapter.js';
import { normalizePcpExpressNumber, parsePcpExpress } from './parser.js';
import { pcpExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'AAABBBB3260105M00001';
const IN_TRANSIT = 'AAACCCB1260210M00002';
const UNKNOWN = 'AAADDDB3260301M00003';

type Row = Record<string, unknown>;
type Shipment = Row & { header: Row; detail: Row[] };
type Reply = Row & { list: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.list[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const refusal = (msg: string) => reply({ status: false, msg }, { status: 500 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PCP Express HTTP adapter', () => {
  it('posts the whole AWB in capitals, as a JSON string, to the results page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PcpExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' aaaccc b1260210 m00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PCP_EXPRESS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBe(`"${IN_TRANSIT}"`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pcp-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock, its status id and its town, newest first, and the failed delivery’s reason', () => {
    const result = parsePcpExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SHIPMENT STATUS DELIVERED', last_update: null, last_update_local: '2026-01-09T14:22:10',
      expected_delivery: null, service_name: 'TITIPAN REGULER EXPRESS - (TREX)' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location, event.description])).toEqual([
      ['2026-01-09T14:22:10', '2', 'delivered', 'SAMPLE CITY', 'SHIPMENT STATUS DELIVERED'],
      ['2026-01-09T08:31:02', '77', 'out_for_delivery', 'SAMPLE CITY', 'ASSIGNMENT DELIVERY PROCESS'],
      ['2026-01-09T08:30:40', '42', 'out_for_delivery', 'SAMPLE CITY', 'DELIVERY PROCESS'],
      ['2026-01-08T16:05:11', '1', 'failed_attempt', 'SAMPLE CITY', 'SHIPMENT STATUS ON PROCESS / KIRIM ULANG: PENERIMA TIDAK DITEMPAT'],
      ['2026-01-08T09:12:00', '77', 'out_for_delivery', 'SAMPLE CITY', 'ASSIGNMENT DELIVERY PROCESS'],
      ['2026-01-08T09:11:31', '42', 'out_for_delivery', 'SAMPLE CITY', 'DELIVERY PROCESS'],
      ['2026-01-07T21:40:05', '41', 'in_transit', 'SAMPLE CITY', 'ARRIVAL AT DESTINATION'],
      // The repeated manifest scan is kept once.
      ['2026-01-06T03:15:44', '39', 'in_transit', 'SAMPLE ORIGIN', 'MANIFESTING PROCESS'],
      ['2026-01-06T02:50:19', '201', 'in_transit', 'SAMPLE ORIGIN', 'ARRIVE AT OPERATION'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Recipient|Receiver|Courier|Sender)|SAMPLE (?:RECEIVER|COURIER|SENDER|REGENCY)|DITERIMA|DRSMP|DMO|BAGAAA|AOAAA|ONLINE SHOP/i);
  });

  it('reads a parcel on its way, naming the branch when the scan has no town', () => {
    const result = parsePcpExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'ARRIVAL AT DESTINATION',
      last_update_local: '2026-02-11T06:02:33', service_name: 'JAMINAN ESOK TIBA - (JET)' });
    expect(result.events!.map((event) => [event.provider_code, event.location])).toEqual([
      ['41', 'Sample Town'], ['39', 'SAMPLE ORIGIN'], ['201', 'SAMPLE ORIGIN'],
    ]);
  });

  it('takes a delivery as the parcel’s status whatever its clock, and orders scans of one second as the reply does', () => {
    const late = parsePcpExpress(changed('delivered', (shipment) => {
      shipment.detail.unshift({ ...shipment.detail[1]!, TrackingDate: '2026-01-10 09:00:00' });
    }), DELIVERED);
    expect(late).toMatchObject({ current_stage: 'delivered', last_status_text: 'SHIPMENT STATUS DELIVERED', last_update_local: '2026-01-10T09:00:00' });
    const tied = parsePcpExpress(changed('in-transit', (shipment) => {
      for (const row of shipment.detail) row.TrackingDate = '2026-02-11 06:02:33';
    }), IN_TRANSIT);
    expect(tied.events!.map((event) => event.provider_code)).toEqual(['41', '39', '201']);
  });

  it('stages a status id it does not know by the status name, and keeps a reason only in its own form', () => {
    const result = parsePcpExpress(changed('in-transit', (shipment) => {
      shipment.detail.push({ ...shipment.detail[2]!, TrackingDate: '2026-02-10 15:00:00', StatusId: 9001, StatusName: 'PICKUP ORDER' });
      shipment.detail.unshift({ ...shipment.detail[0]!, TrackingDate: '2026-02-11 10:00:00', StatusId: 1,
        StatusName: 'SHIPMENT STATUS ON PROCESS / KIRIM ULANG', RelatioanName: 'Sample note 0000000000' });
    }), IN_TRANSIT);
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '9001', stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events![0]).toMatchObject({ description: 'SHIPMENT STATUS ON PROCESS / KIRIM ULANG', stage: 'failed_attempt' });
    expect(result).toMatchObject({ current_stage: 'failed_attempt', status: 'exception' });
  });

  it('reads an unknown number as not found and the tracker’s other refusals apart', () => {
    expect(() => parsePcpExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePcpExpress({ status: false, msg: 'AWB tidak valid.!' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parsePcpExpress({ status: false, msg: 'Awb wajib diisi.!' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePcpExpress({ status: false, msg: 'Execution Timeout Expired.  The timeout period elapsed.' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePcpExpress({ status: false }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePcpExpress(changed('delivered', (shipment) => { shipment.detail = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parsePcpExpress(changed('delivered', (shipment) => { delete (shipment as Row).detail; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it and each of its scans name the AWB asked', () => {
    expect(() => parsePcpExpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PCP Express answered for another shipment' }));
    expect(() => parsePcpExpress(changed('in-transit', (shipment) => { shipment.detail[1]!.AwbNo = DELIVERED; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A second shipment under the same AWB leaves it unclear which one is meant.
    expect(() => parsePcpExpress(changed('in-transit', (_shipment, body) => { body.list.push(body.list[0]!); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Another shipment beside the one asked is left out.
    const beside = parsePcpExpress(changed('in-transit', (_shipment, body) => { body.list.unshift(fixture('delivered').list[0]!); }), IN_TRANSIT);
    expect(beside.events).toHaveLength(3);
    expect(parsePcpExpress(changed('in-transit', (shipment) => {
      shipment.header.TrackingNo = IN_TRANSIT.toLowerCase();
      for (const row of shipment.detail) row.AwbNo = ` ${IN_TRANSIT.toLowerCase()} `;
    }), IN_TRANSIT).events).toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).status; },
      (_shipment: Shipment, body: Reply) => { body.status = 'true'; },
      (_shipment: Shipment, body: Reply) => { delete (body as Row).list; },
      (_shipment: Shipment, body: Reply) => { body.list = []; },
      (_shipment: Shipment, body: Reply) => { body.list = Array.from({ length: 11 }, () => body.list[0]!); },
      (_shipment: Shipment, body: Reply) => { body.list[0] = 'shipment' as never; },
      (shipment: Shipment) => { delete (shipment as Row).header; },
      (shipment: Shipment) => { delete shipment.header.TrackingNo; },
      (shipment: Shipment) => { shipment.detail = 'scans' as never; },
      (shipment: Shipment) => { shipment.detail = Array.from({ length: 501 }, () => shipment.detail[0]!); },
      (shipment: Shipment) => { shipment.detail[0] = 'scan' as never; },
      (shipment: Shipment) => { delete shipment.detail[0]!.AwbNo; },
      (shipment: Shipment) => { shipment.detail[0]!.TrackingDate = '11/02/2026 06:02'; },
      (shipment: Shipment) => { shipment.detail[0]!.TrackingDate = '2026-02-30 06:02:33'; },
      (shipment: Shipment) => { shipment.detail[0]!.TrackingDate = '2026-02-11 24:00:00'; },
      (shipment: Shipment) => { delete shipment.detail[0]!.TrackingDate; },
      (shipment: Shipment) => { shipment.detail[0]!.StatusId = -1; },
      (shipment: Shipment) => { shipment.detail[0]!.StatusId = 41.5; },
      (shipment: Shipment) => { shipment.detail[0]!.StatusId = [41]; },
      (shipment: Shipment) => { shipment.detail[0]!.StatusName = ''; },
      (shipment: Shipment) => { shipment.detail[0]!.StatusName = ['ARRIVAL AT DESTINATION']; },
      (shipment: Shipment) => { shipment.detail[0]!.Location = 7; },
      (shipment: Shipment) => { shipment.header.ServiceName = {}; },
    ]) {
      expect(() => parsePcpExpress(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A clock with a fraction of a second, and a status id as text, are the same scan.
    expect(parsePcpExpress(changed('in-transit', (shipment) => {
      shipment.detail[0]!.TrackingDate = '2026-02-11 06:02:33.000';
      shipment.detail[0]!.StatusId = '41';
    }), IN_TRANSIT).events![0]).toMatchObject({ local_time: '2026-02-11T06:02:33', provider_code: '41' });
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    // The tracker answers an unknown number with HTTP 500 and its message.
    await expect(lookup(refusal('Awb/Refno tidak ditemukan.!'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(refusal('AWB tidak valid.!'))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup(refusal('Execution Timeout Expired.'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply(fixture('delivered'), { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply('<html><title>500 Internal Server Error</title></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('', { status: 301, headers: { Location: 'https://www.pcpexpress.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><title>PCP Express</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a read that failed to reach PCP Express once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A reply is never sent again.
    const answered = vi.fn<typeof fetch>().mockImplementation(async () => refusal('Execution Timeout Expired.'));
    await expect(carrier(answered).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(answered).toHaveBeenCalledTimes(1);
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number PCP Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(refusal('Awb/Refno tidak ditemukan.!'));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-09T14:22:10' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('AAA000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers PCP Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['AAA0000000000', 'AAAAAAAAAAAAAAAA', `AAA${'0'.repeat(28)}`, 'AAA000000000000,AAA000000000001', 'AAA00000000000%']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePcpExpressNumber('aaa 000-0000-0000 0001')).toBe('AAA000000000000001');
  });

  it('routes a number filed under PCP Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'pcp-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pcp-express', source: 'pcp-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === PCP_EXPRESS_API)).toBe(true);
  });
});

describe('PCP Express status vocabulary', () => {
  it('records every status id and name the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[]) {
      // The detail page's Indonesian wording is not what the adapter reads.
      if (entry.confirmedBy === 'portal') continue;
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(pcpExpressStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'pcp-express', providerCode: '1', description: 'SHIPMENT STATUS ON PROCESS / KIRIM ULANG: PENERIMA TIDAK DITEMPAT' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'pcp-express', providerCode: '9001', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // An id and name the map does not know fall to the shared wording rules.
    expect(pcpExpressStage('9001', 'SHIPMENT RETURNED')).toEqual({ stage: 'returned', source: 'wording:returned' });
    expect(pcpExpressStage('9001', 'Synthetic note')).toBeNull();
  });
});
