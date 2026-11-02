import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CACESA_ENDPOINT, CacesaTracker } from './adapter.js';
import { normalizeCacesaNumber, parseCacesa } from './parser.js';
import { cacesaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const CLEARED = 'CNPRT90000000000000000017';
const NOTIFIED = 'CNES90000000017';
const UNKNOWN = 'CNPRT90000000000000000025';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown>[] => JSON.parse(text(name));
const json = 'application/json; charset=utf-8';
const reply = (name: string) => new Response(text(name), { status: 200, headers: { 'Content-Type': json } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CACESA HTTP adapter', () => {
  it('posts the whole number once, without an IP address, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('cleared'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CacesaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cnprt 9000-0000-0000-0000-0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://apiweb.cacesa.com/cacesa.api/api/Tracking');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ trackingId: CLEARED, ipAddress: '' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cacesa', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel through customs newest first, on Madrid’s clock, without the Spanish wording', () => {
    const result = parseCacesa(fixture('cleared'), CLEARED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel is going out from Cacesa facilities - More delivery information check with transport company.',
      last_update: '2026-01-14T11:15:00+01:00', expected_delivery: null, delivery_tracking_number: CLEARED });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-01-14T11:15:00+01:00', 'EVENTO/ico_almacen', 'in_transit'],
      ['2026-01-14T10:40:12+01:00', 'EVENTO/ico_okaduana', 'in_transit'],
      ['2026-01-14T10:02:55+01:00', 'EVENTO/ico_aduana', 'customs'],
      ['2026-01-14T09:31:27+01:00', 'EVENTO/ico_recepcionalmacen', 'in_transit'],
      ['2026-01-14T06:20:03+01:00', 'EVENTO/ico_almacen', 'in_transit'],
      ['2026-01-12T08:05:41+01:00', 'EVENTO/ico_notification', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Notificaci|Almac|Aduanas|Warehouse|Data registered/);
  });

  it('reads summer clocks with Madrid’s summer offset', () => {
    expect(parseCacesa(fixture('notified'), NOTIFIED)).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'Electronic notification of shipment received', last_update: '2026-07-20T13:45:09+02:00' });
  });

  it('hands a Cainiao number for Spain or Portugal on to Ecoscooting under the same number', () => {
    expect(deliveryHandoff('cacesa', CLEARED, parseCacesa(fixture('cleared'), CLEARED)))
      .toEqual({ carrier: 'ecoscooting', number: CLEARED, basis: 'reference' });
    expect(deliveryHandoff('cacesa', NOTIFIED, parseCacesa(fixture('notified'), NOTIFIED))).toBeNull();
  });

  it('reads a delivered milestone as delivered and leaves incidents and unknown icons to the wording rules', () => {
    const delivered = fixture('cleared');
    delivered.push({ ...delivered[5], english_Description: 'Delivered', milestone_Date: '2026-01-16T12:00:00', shipmentType: 'ENTREGADO', icon: 'ico_entregaenmano' });
    expect(parseCacesa(delivered, CLEARED)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      delivered_at: '2026-01-16T12:00:00+01:00' });
    const incident = fixture('cleared');
    incident.push({ ...incident[5], english_Description: 'Pending review', milestone_Date: '2026-01-15T09:00:00', shipmentType: 'INCIDENCIA', icon: 'ico_atention' });
    const result = parseCacesa(incident, CLEARED);
    expect(result.events![0]).toEqual({ time: '2026-01-15T09:00:00+01:00', description: 'Pending review', provider_code: 'INCIDENCIA/ico_atention' });
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
  });

  it('drops repeated milestones, orders equal clocks as the reply does and keeps only the requested shipment', () => {
    const payload = fixture('cleared');
    payload.push({ ...payload[5] }, { ...payload[5], english_Description: 'Later at the same second' },
      { ...payload[0], shipmentCode: 'CNPRT90000000000000000033', milestone_Date: '2026-02-01T00:00:00' });
    const result = parseCacesa(payload, CLEARED);
    expect(result.events).toHaveLength(7);
    expect(result.events!.slice(0, 2).map((event) => event.description))
      .toEqual(['Later at the same second', 'Parcel is going out from Cacesa facilities - More delivery information check with transport company.']);
  });

  it('keeps an unknown number, another shipment and an empty reply apart', () => {
    expect(() => parseCacesa(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCacesa(fixture('not-found'), CLEARED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCacesa([], CLEARED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (rows: Record<string, unknown>[]) => { rows[2]!.milestone_Date = '14/01/2026 09:31'; },
      (rows: Record<string, unknown>[]) => { rows[2]!.milestone_Date = '0001-01-01T00:00:00'; },
      (rows: Record<string, unknown>[]) => { rows[2]!.english_Description = ''; rows[2]!.spanish_Description = ''; },
      (rows: Record<string, unknown>[]) => { rows[2]!.shipmentType = { name: 'EVENTO' }; },
      (rows: Record<string, unknown>[]) => { rows[2] = 'EVENTO' as unknown as Record<string, unknown>; },
    ]) {
      const payload = fixture('cleared');
      change(payload);
      expect(() => parseCacesa(payload, CLEARED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseCacesa({ tracking: [] }, CLEARED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reports the not-found answer and a moved service apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(reply('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(new Response(null, { status: 301, headers: { Location: 'https://example.invalid/' } }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: CLEARED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps HTML and malformed replies apart from missing parcels', async () => {
    for (const body of ['<html>Maintenance</html>', '{"events":[]}']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).track({ number: CLEARED })).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('rejects numbers that are not letters and digits, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'CNPRT', 'CN123', 'CNPRT9000,CNPRT9001', 'CNPRT/90000000000000000017', `CN${'1'.repeat(39)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: CLEARED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCacesaNumber('cnes 9000.0000-017')).toBe(NOTIFIED);
  });

  it('sends a read that failed to reach CACESA once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply('notified'));
    await expect(carrier(fetcher).track({ number: NOTIFIED }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: CLEARED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under CACESA to the adapter and proposes its delivery carrier', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === CACESA_ENDPOINT
      ? reply('cleared') : new Response('{}', { status: 503 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: CLEARED, carrier: 'cacesa' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'cacesa', source: 'cacesa', result: { current_stage: 'in_transit' },
      handoff: { carrier: 'ecoscooting', number: CLEARED, basis: 'reference', confirmed: false } });
  });
});

describe('CACESA status vocabulary', () => {
  it('records every code the map knows with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      const [type, icon] = entry.code.split('/');
      expect(cacesaStage(type!, icon!)).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'cacesa', providerCode: 'EVENTO/ico_aduana', description: 'Start Custom clearance Process' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'cacesa', providerCode: 'INCIDENCIA/ico_aduanako', description: 'Held by customs-documentary verification' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMap.stage('ENTREGADO/ico_entregaenmano', 'delivered')).toBe('delivered');
    expect(statusMap.stage('INCIDENCIA/ico_atention', 'pending review')).toBeUndefined();
    expect(statusMap.stage('EVENTO/ico_tax', 'taxes')).toBeUndefined();
    expect(statusMap.stage('EVENTO', 'arrival notification')).toBeUndefined();
  });
});
