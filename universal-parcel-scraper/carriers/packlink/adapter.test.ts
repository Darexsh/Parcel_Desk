import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PACKLINK_API, PacklinkTracker } from './adapter.js';
import { carrierWording, normalizePacklinkReference, parsePacklink } from './parser.js';
import { packlinkStage, packlinkWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ES2026COM0000000101';
const IN_TRANSIT = 'ES2026COM0000000102';
const UNKNOWN = 'ES2026COM0000000103';

type Row = Record<string, unknown>;
type Parcel = Row & { checkpoints: Row[] };
type Reply = Row & { parcels: Parcel[]; status_history: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Packlink HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole reference in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PacklinkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' es2026com 0000000102 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PACKLINK_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'packlink', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each parcel’s shared scans once, newest first, with Packlink’s instants as Madrid wall clocks', () => {
    const result = parsePacklink(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO', last_update: null, last_update_local: '2026-05-13T18:05:00', expected_delivery: null,
      delivery_tracking_number: '3000000000000101' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['2026-05-13T18:05:00', 'DELIVERED', 'delivered', 'ENTREGADO'],
      ['2026-05-13T11:20:00', 'OUT_FOR_DELIVERY_INCIDENT_02', 'failed_attempt', 'REPARTO FALLIDO'],
      ['2026-05-13T09:45:00', 'OUT_FOR_DELIVERY', 'out_for_delivery', 'EN REPARTO'],
      ['2026-05-13T05:10:00', 'IN_TRANSIT_02', 'in_transit', 'DELEGACION DESTINO'],
      ['2026-05-12T19:30:00', 'IN_TRANSIT', 'in_transit', 'EN ARRASTRE'],
      ['2026-05-12T10:15:00', 'READY_FOR_COLLECTION', 'registered', 'SIN RECEPCION'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    // The places, the parcel numbers and the page's public id are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Sample|"00001"|0\.5|SyntheticPublicId|30000000000001010000001/);
  });

  it('reads a carrier’s wording under Packlink’s catch-all codes and passes on the parcel’s own number', () => {
    const result = parsePacklink(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'SALIÓ DE INTERNACIONAL',
      last_update_local: '2026-05-21T11:25:00', expected_delivery: '2026-05-26', delivery_tracking_number: '00000000000102' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['IN_TRANSIT', 'in_transit', 'carrier_map'],
      ['IN_TRANSIT', 'in_transit', 'carrier_map'],
      // A notice that the parcel has yet to reach the destination depot, not a delivery incident.
      ['OUT_FOR_DELIVERY_INCIDENT', 'in_transit', 'carrier_map'],
      // The origin depot's receipt, not a parcel still waiting for collection.
      ['READY_FOR_COLLECTION', 'accepted', 'carrier_map'],
    ]);
    // Every scan carries the same town, so no place is kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE TOWN/);
  });

  it('names no carrier number when the shipment has only its reference and several parcels', () => {
    const result = parsePacklink(changed('in-transit', (body) => {
      body.parcels.push({ ...body.parcels[0]!, carrier_tracking_number: '00000000000103' });
    }), IN_TRANSIT);
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events).toHaveLength(4);
  });

  it('falls back to Packlink’s own milestones while no parcel has a scan', () => {
    const result = parsePacklink(changed('in-transit', (body) => {
      body.parcels[0]!.checkpoints = [];
      body.status_history = [body.status_history.at(-1)!];
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Waiting for carrier to collect the order',
      last_update: '2026-05-17T10:10:30.200Z' });
    expect(result.events).toEqual([{ time: '2026-05-17T10:10:30.200Z', description: 'Waiting for carrier to collect the order',
      provider_code: 'READY_FOR_COLLECTION', stage: 'registered', stage_source: 'carrier_map' }]);
    expect(() => parsePacklink(changed('in-transit', (body) => { body.parcels = []; body.status_history = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('gives a scan without the carrier’s wording Packlink’s own, and leaves notices without a stage', () => {
    const result = parsePacklink(changed('delivered', (body) => {
      const [first] = body.parcels;
      body.parcels = [first!];
      Object.assign(first!.checkpoints[5]!, { status: 'DELIVERED_02', raw_carrier_status: { code: null, description: null } });
      Object.assign(first!.checkpoints[4]!, { status: 'OUT_FOR_DELIVERY_02', raw_carrier_status: null });
      Object.assign(first!.checkpoints[3]!, { status: 'OUT_FOR_DELIVERY_09', raw_carrier_status: {} });
      first!.checkpoints[2]!.occurred_at = null;
    }), DELIVERED);
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['DELIVERED_02', 'ready_for_pickup', 'Package at pick-up point and ready for collection'],
      ['OUT_FOR_DELIVERY_02', null, 'Delivery date scheduled'],
      // A code the table does not name takes its family's.
      ['OUT_FOR_DELIVERY_09', 'out_for_delivery', 'The package is ready to be delivered to the final destination'],
      // The undated scan is left out.
      ['IN_TRANSIT', 'in_transit', 'EN ARRASTRE'],
      ['READY_FOR_COLLECTION', 'registered', 'SIN RECEPCION'],
    ]);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
  });

  it('takes phone numbers and e-mail addresses out of a carrier’s wording', () => {
    expect(carrierWording('LLAME AL +00 000 000 000 O ESCRIBA A sample@example.com')).toBe('LLAME AL O ESCRIBA A');
    expect(carrierWording('ENTREGA PREVISTA 2026-05-20')).toBe('ENTREGA PREVISTA 2026-05-20');
  });

  it('reads an unknown reference as not found and counts a shipment only when it names the reference asked', () => {
    expect(() => parsePacklink(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePacklink(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Packlink answered for another shipment' }));
    expect(parsePacklink(changed('in-transit', (body) => { body.shipment_reference = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(4);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.shipment_reference; },
      (body: Reply) => { body.shipment_reference = 102; },
      (body: Reply) => { body.parcels = 'parcels' as never; },
      (body: Reply) => { body.parcels = Array.from({ length: 51 }, () => body.parcels[0]!); },
      (body: Reply) => { body.parcels[0]!.checkpoints = Array.from({ length: 501 }, () => body.parcels[0]!.checkpoints[0]!); },
      (body: Reply) => { body.parcels[0]!.checkpoints[0] = 'scan' as never; },
      (body: Reply) => { body.parcels[0]!.checkpoints[0]!.status = 'in transit'; },
      (body: Reply) => { delete body.parcels[0]!.checkpoints[0]!.status; },
      (body: Reply) => { body.parcels[0]!.checkpoints[0]!.occurred_at = '2026-05-19 09:20'; },
      (body: Reply) => { body.parcels[0]!.checkpoints[0]!.occurred_at = '2026-05-19T09:20:00'; },
      (body: Reply) => { body.parcels[0]!.checkpoints[0]!.occurred_at = '2026-02-30T09:20:00Z'; },
      (body: Reply) => { body.parcels[0]!.checkpoints[0]!.raw_carrier_status = 'RECIBIDO'; },
      (body: Reply) => { body.parcels[0]!.checkpoints[0]!.raw_carrier_status = { description: ['RECIBIDO'] }; },
      (body: Reply) => { body.parcels[0]!.checkpoints = []; body.status_history = [{ status: 'IN_TRANSIT' }]; },
    ]) {
      expect(() => parsePacklink(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePacklink({ messages: [{ message: 'Unauthorized' }] }, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePacklink([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown reference, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // A route the API does not have is a 404 without a body.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.packlink.es/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Packlink</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Packlink</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known reference and the unknown-reference answer, and asks nothing for a number Packlink does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-13T18:05:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ES2026XYZ0000000101')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Packlink does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ES2026COM000000010', 'ES2026COM00000001011', 'ES1999COM0000000101', 'E52026COM0000000101', 'SAMPLETRACKING']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePacklinkReference('es-2026-pro-0000000101')).toBe('ES2026PRO0000000101');
  });

  it('sends a read that failed to reach the API once more', async () => {
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

  it('routes a reference filed under Packlink, or detected as one, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'packlink' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'packlink', source: 'packlink', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'packlink', source: 'packlink' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${PACKLINK_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Packlink references', () => {
  it('are the shape the adapter accepts', () => {
    for (const number of [DELIVERED, 'FR2025PRO0000000001', 'UN2026COM0000000000']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'packlink', confidence: 'high' });
      expect(normalizePacklinkReference(number)).toBe(number);
    }
  });
});

describe('Packlink status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; language?: string; stage?: string; unmapped?: boolean }[]) {
      const staged = packlinkStage(entry.code, entry.wording);
      if (entry.unmapped) {
        expect(staged, entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'packlink', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(staged?.stage, `${entry.code} ${entry.wording}`).toBe(entry.stage);
      // The map answers what it stages itself; the shared wording rules answer the rest.
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), `${entry.code} ${entry.wording}`)
        .toBe(staged?.source === 'carrier_map' ? entry.stage : undefined);
      if (entry.language === 'en') expect(packlinkWording(entry.code), entry.code).toBe(entry.wording);
    }
    expect(statusMapAnswer({ carrier: 'packlink', providerCode: 'OUT_FOR_DELIVERY_INCIDENT', description: 'TU ENVÍO ESTÁ PENDIENTE DE LLEGAR A DESTINO' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'packlink', providerCode: 'SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Under a catch-all code, the carrier's wording decides before the code's family.
    expect(packlinkStage('OUT_FOR_DELIVERY_INCIDENT', 'REPARTO FALLIDO')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(packlinkStage('OUT_FOR_DELIVERY_INCIDENT', 'SYNTHETIC NOTE')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(packlinkStage('IN_TRANSIT_100', 'SYNTHETIC NOTE')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // A code of one milestone keeps its stage whatever the carrier says.
    expect(packlinkStage('DELIVERED_02', 'ENTREGADO')).toEqual({ stage: 'ready_for_pickup', source: 'carrier_map' });
    expect(packlinkStage('SYNTHETIC', 'Synthetic note')).toBeNull();
  });
});
