import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, URVAAM_API, UrvaamTracker } from './adapter.js';
import { normalizeUrvaamNumber, parseUrvaam } from './parser.js';
import { statusMap, urvaamStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '2700000000000011';
const IN_TRANSIT = '2800000000000021';
const UNKNOWN = '2000000000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { data: Row[] };
type Reply = Row & { meta: Row; response: Row & { data: Shipment[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.response.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (fields: Row): Row => ({ id: 1, driver_id: 0, is_delete: 0, ...fields });

describe('Urvaam HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new UrvaamTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2800 0000 0000 0021 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(URVAAM_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Accept-Language': 'es-ES', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`line_nos=${IN_TRANSIT}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'urvaam', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock, names the depot as the place and drops the signature, the driver and the sender’s reference', () => {
    const result = parseUrvaam(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado (Entregado al buzon)', last_update: null, last_update_local: '2026-03-12T13:44:07', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.description, event.location ?? null])).toEqual([
      ['2026-03-12T13:44:07', '3', 'delivered', 'Entregado (Entregado al buzon)', null],
      ['2026-03-12T07:02:06', '2', 'out_for_delivery', 'En Reparto', null],
      // The repeated sort scan is kept once.
      ['2026-03-11T18:58:47', '18', 'in_transit', 'Clasificado', null],
      ['2026-03-11T16:34:04', '19', 'in_transit', 'Recibido Plataforma', 'Sample-Depot'],
      ['2026-03-11T13:50:40', '18', 'in_transit', 'Clasificado', null],
      ['2026-03-11T12:25:05', '1', 'accepted', 'Recibido Plataforma', 'Urvaam-Bcn'],
      ['2026-03-06T18:09:33', '0', 'registered', 'Envio Grabado', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('pickup_point');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLEREF|sample\.invalid|1234|已签收|Assinado|Successful Delivery/);
  });

  it('reads a failed round, a claim and a second receipt on the same second in the page’s order', () => {
    const result = parseUrvaam(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Segundo recibido Plataforma', last_update_local: '2026-04-21T17:17:08' });
    expect(result.events!.slice(0, 4).map((event) => [event.provider_code, event.stage, event.description, event.location ?? null])).toEqual([
      ['9', 'in_transit', 'Segundo recibido Plataforma', 'Sample-Town'],
      ['15', 'exception', 'indemnización', null],
      ['8', 'failed_attempt', 'Incidencia (Ausente)', null],
      ['2', 'out_for_delivery', 'En Reparto', null],
    ]);
  });

  it('turns a history listed oldest first newest first', () => {
    const result = parseUrvaam(changed('delivered', (shipment) => { shipment.data.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update_local: '2026-03-12T13:44:07', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '0' });
  });

  it('keeps scans of one second in the page’s order, reversed when it lists them oldest first', () => {
    const result = parseUrvaam(changed('in-transit', (shipment) => { shipment.data.reverse(); }), IN_TRANSIT);
    expect(result.events!.slice(0, 3).map((event) => event.provider_code)).toEqual(['9', '15', '8']);
  });

  it('keeps the pickup point the page shows under a scan, without its opening hours', () => {
    const result = parseUrvaam(changed('in-transit', (shipment) => {
      shipment.data.unshift(scan({ update_time: '2026-04-22 10:15:00', status: '5', track_status: 6, caption: '自提点签收',
        caption_es: 'Entregado al punto de Recogida', caption_en: 'Delivered to the pickup point',
        network_info: { name: 'Sample Shop', address: 'Calle Sample 1', city: 'Sampletown', work_time: [{ name: 'Lunes', time: '10:00-14:00' }] } }));
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      pickup_point: 'Sample Shop\nCalle Sample 1\nSampletown' });
    expect(result.events![0]).toMatchObject({ provider_code: '5', stage: 'ready_for_pickup', location: 'Sampletown' });
    expect(JSON.stringify(result)).not.toMatch(/Lunes|10:00-14:00/);
  });

  it('reads a return to the sender from its wording, whatever its code', () => {
    const result = parseUrvaam(changed('delivered', (shipment) => {
      Object.assign(shipment.data[0]!, { caption_es: `Devuelto al remitente (${DELIVERED})` });
      Object.assign(shipment.data[6]!, { caption_es: `Devolver al remitente (${DELIVERED})` });
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: `Devuelto al remitente (${DELIVERED})` });
    expect(result.events!.find((event) => event.provider_code === '1')).toMatchObject({ stage: 'exception', description: `Devolver al remitente (${DELIVERED})` });
  });

  it('reads an unknown number as not found, a shipment without scans as no history and a refused lookup apart', () => {
    expect(() => parseUrvaam(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const data of [[], null, undefined]) {
      expect(() => parseUrvaam(changed('delivered', (shipment) => { shipment.data = data as never; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
    // The service's answer when the route wants a signed-in session, and its answer without a number.
    expect(() => parseUrvaam({ meta: { code: 1000, msg: 'Por favor,vuelva a iniciar sensíon' }, response: {} }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseUrvaam({ meta: { code: 400, msg: 'Error de sistema' }, response: {} }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when it names the whole number asked', () => {
    expect(() => parseUrvaam(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Urvaam answered for another shipment' }));
    const both = fixture('delivered');
    both.response.data.unshift(fixture('in-transit').response.data[0]!);
    expect(parseUrvaam(both, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-03-12T13:44:07' });
    const twice = fixture('delivered');
    twice.response.data.push(fixture('delivered').response.data[0]!);
    expect(() => parseUrvaam(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).meta; },
      (_shipment: Shipment, body: Reply) => { delete (body as Row).response; },
      (_shipment: Shipment, body: Reply) => { body.response.data = 'shipments' as never; },
      (_shipment: Shipment, body: Reply) => { body.response.data = Array.from({ length: 51 }, () => body.response.data[0]!); },
      (_shipment: Shipment, body: Reply) => { body.response.data[0] = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.line_no; },
      (shipment: Shipment) => { shipment.line_no = Number(DELIVERED); },
      (shipment: Shipment) => { shipment.data = 'scans' as never; },
      (shipment: Shipment) => { shipment.data = Array.from({ length: 501 }, () => shipment.data[0]!); },
      (shipment: Shipment) => { shipment.data[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.data[0]!.update_time = '12/03/2026 13:44'; },
      (shipment: Shipment) => { shipment.data[0]!.update_time = '2026-02-30 13:44:07'; },
      (shipment: Shipment) => { shipment.data[0]!.update_time = '2026-03-12 24:00:00'; },
      (shipment: Shipment) => { delete shipment.data[0]!.update_time; },
      (shipment: Shipment) => { shipment.data[0]!.caption_es = ['Entregado']; },
      (shipment: Shipment) => { shipment.data[0]!.caption_es = ''; shipment.data[0]!.caption_en = null; },
      (shipment: Shipment) => { shipment.data[0]!.status = { code: 3 }; },
      (shipment: Shipment) => { shipment.data[0]!.status = 3.5; },
      (shipment: Shipment) => { shipment.data[0]!.track_status = 'delivered'; },
    ]) {
      expect(() => parseUrvaam(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads codes sent as numbers and an English caption when the Spanish one is missing', () => {
    const result = parseUrvaam(changed('delivered', (shipment) => {
      Object.assign(shipment.data[0]!, { status: 3, track_status: 4, caption_es: null });
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '3', stage: 'delivered', description: 'Delivered' });
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.urvaam.es/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>var arg1="00"; document.cookie="acw_sc__v2=" + arg1;</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>urvaam</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Urvaam does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T13:44:07' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('YT0000000000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Urvaam does not issue, the sender’s reference among them, and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['270000000000001', '27000000000000111', '1700000000000011', 'YT0000000000000001', 'SAMPLEREF000001', '2'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeUrvaamNumber('2700-0000-0000-0011')).toBe(DELIVERED);
  });

  it('tries a read that does not reach the service once more inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('routes a number filed under Urvaam to the adapter, and detection claims none', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'urvaam' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'urvaam', source: 'urvaam', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === URVAAM_API)).toBe(true);
    // Sixteen digits are shared with other carriers' numbers.
    for (const number of [DELIVERED, IN_TRANSIT]) expect(detectCarrierMatch(number).candidates).not.toContain('urvaam');
  });
});

describe('Urvaam status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(urvaamStage(entry.code, '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'urvaam', providerCode: '8', description: 'Incidencia (Ausente)' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'urvaam', providerCode: '77', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });

  it('takes the tracker’s category for a code the map does not know, and the wording rules where the category says only in transit', () => {
    expect(urvaamStage('77', '6', 'Synthetic note')).toEqual({ stage: 'ready_for_pickup', source: 'carrier_map' });
    expect(urvaamStage('77', '5', 'Synthetic note')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(urvaamStage('77', '7', 'Synthetic note')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(urvaamStage('77', '2', 'Incidencia (Ausente)')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(urvaamStage('77', '2', 'Synthetic note')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(urvaamStage('77', '', 'Synthetic note')).toBeNull();
    // A failed round for a lost, stolen or refused parcel is a problem, not an attempt.
    expect(urvaamStage('8', '2', 'Incidencia (Robado)')?.stage).toBe('exception');
    expect(urvaamStage('8', '2', 'Incidencia (No acepta el envio)')?.stage).toBe('exception');
    expect(urvaamStage('8', '2', 'Incidencia (Falta teléfono)')?.stage).toBe('failed_attempt');
  });
});
