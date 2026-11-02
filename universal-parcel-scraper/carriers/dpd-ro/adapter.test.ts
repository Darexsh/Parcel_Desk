import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DPD_RO_ENDPOINT, DpdRoTracker } from './adapter.js';
import { parseDpdRo, parseDpdRoReply } from './parser.js';
import { dpdRoOperation, dpdRoPhase, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '80000000001';
const ABROAD = '80000000002';
const CANCELLED = '80000000003';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(`${name}.json`)) as Record<string, unknown>;
const reply = (name: string) => new Response(text(`${name}.json`), { headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
const missing = () => new Response(text('not-found.html'), { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPD Romania HTTP adapter', () => {
  it('asks the public track endpoint once, in English, through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DpdRoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 8000 0000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://mydpd.dpd.ro/rest/public/track?id=${DELIVERED}&language=en`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpd-ro', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, with offset clocks and without the recipient or proof of delivery', () => {
    const result = parseDpdRo(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-04T11:20:30+02:00', delivered_at: '2026-03-04T11:20:30+02:00',
      expected_delivery: null });
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-04T11:20:30+02:00', '-14', 'delivered', 'Example City'],
      ['2026-03-04T08:05:00+02:00', '12', 'out_for_delivery', 'Example City'],
      ['2026-03-04T07:30:00+02:00', '175', null, null],
      ['2026-03-03T04:10:00+02:00', '1', 'in_transit', 'Example City'],
      ['2026-03-02T22:30:00+02:00', '2', 'in_transit', 'Sample Town'],
      ['2026-03-02T18:05:00+02:00', '11', 'in_transit', 'Sample Town'],
      ['2026-03-02T16:40:00+02:00', '39', 'accepted', 'Sample Town'],
      ['2026-03-02T09:15:00+02:00', '148', 'registered', null],
    ]);
    expect(result.events![2]).toEqual({ time: '2026-03-04T07:30:00+02:00', description: 'Predict', provider_code: '175' });
    const kept = JSON.stringify(result);
    for (const dropped of ['ABC**', 'received from', 'SYNTHETIC-POD-TOKEN', 'Expected Delivery', '09:00 - 12:00']) {
      expect(kept).not.toContain(dropped);
    }
  });

  it('keeps the estimate of a parcel on its way abroad, its partner scan place and none of the partner mapping', () => {
    const result = parseDpdRo(fixture('abroad'), ABROAD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrival Scan',
      last_update: '2026-03-11T07:50:00+01:00', expected_delivery: '2026-03-13' });
    expect(result.events!.map(event => [event.provider_code, event.location ?? null])).toEqual([
      ['1', 'SAMPLEDORF, Germany'], ['176', 'Sample Town'], ['39', 'Sample Town'], ['148', null]]);
    expect(result.delivered_at).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/00000000000000|example\.com|99-/);
  });

  it('names ACS and its number when DPD Romania hands it the receiving leg, as for a parcel to Cyprus', () => {
    const payload = fixture('abroad') as { externalCarriermappings: Record<string, unknown>[] };
    payload.externalCarriermappings = [{ barcode: '9900000001', externalCarrierId: 3, externalCarrier: 'ACS', mappingFor: 'RECEIVER',
      trackURL: 'https://www.acscourier.net/en/track-and-trace?trackingNumber=9900000001' }];
    expect(parseDpdRo(payload, ABROAD)).toMatchObject({ delivery_carrier: 'acs-courier', delivery_tracking_number: '9900000001' });
    // The sender's leg, and a partner that cannot be asked, name none.
    payload.externalCarriermappings[0]!.mappingFor = 'SENDER';
    expect(parseDpdRo(payload, ABROAD).delivery_carrier).toBeUndefined();
    Object.assign(payload.externalCarriermappings[0]!, { mappingFor: 'RECEIVER', externalCarrier: 'Example Network' });
    expect(parseDpdRo(payload, ABROAD).delivery_carrier).toBeUndefined();
  });

  it('reads a cancelled waybill as an exception without an estimate', () => {
    expect(parseDpdRo(fixture('cancelled'), CANCELLED)).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Canceled', last_update: '2026-08-03T15:08:23+03:00', expected_delivery: null,
      events: [{ provider_code: '128', stage: 'exception', location: 'Sample Town' }, { provider_code: '148', stage: 'registered' }] });
  });

  it('keeps unknown codes visible without a stage and answers a reply without scans from its phase', () => {
    const payload = fixture('abroad') as { events: Record<string, unknown>[]; info: unknown };
    payload.events.push({ operationCode: 9001, description: 'Example new operation', dateTime: '2026-03-12T09:00:00+0200', place: '', comments: [] });
    const unknown = parseDpdRo(payload, ABROAD);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Example new operation' });
    expect(unknown.events![0]).toEqual({ time: '2026-03-12T09:00:00+02:00', description: 'Example new operation', provider_code: '9001' });
    payload.events = [];
    expect(parseDpdRo(payload, ABROAD)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', provider_code: 'IN_TRANSIT',
      last_status_text: 'In transit', summary_only: true, last_update: null, events: [] });
    payload.info = { phase: 'SOMETHING_NEW' };
    expect(() => parseDpdRo(payload, ABROAD)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the reply to the whole requested waybill and dated scans', () => {
    expect(() => parseDpdRo(fixture('delivered'), '80000000009')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [{ dateTime: '2026-03-02T09:15:00' }, { dateTime: '' }, { operationCode: null }, { operationCode: { code: 1 } }]) {
      const payload = fixture('delivered') as { events: Record<string, unknown>[] };
      Object.assign(payload.events[0]!, change);
      expect(() => parseDpdRo(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDpdRo({ barcode: DELIVERED, events: {} }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads MyDPD’s not-found page as not found and other replies by their own kind', () => {
    expect(() => parseDpdRoReply(404, text('not-found.html'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDpdRoReply(404, '<html>Not Found</html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseDpdRoReply(200, '<html><title>Just a moment...</title></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDpdRoReply(200, '<html><title>Un instant…</title></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDpdRoReply(200, '<html><title>SkyLogistics</title><div class="cf-turnstile"></div></html>', DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseDpdRoReply(200, `\uFEFF${text('delivered.json')}`, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('recognizes a known waybill and the not-found page without a browser or recipient inputs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('delivered')).mockResolvedValueOnce(missing());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T09:20:30.000Z' });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('60000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(missing())).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [400, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('<html></html>', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a 404 that is not MyDPD’s page and a blocked HTTP 200 apart from missing waybills', async () => {
    for (const [response, kind] of [[new Response('Not Found', { status: 404 }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>'), 'challenge'], [new Response('{"items":[]}'), 'schema']] as const) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects numbers DPD Romania does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['8000000000', '800000000011', '60000000001', '00000000000000', 'RO80000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a waybill filed under DPD Romania to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'dpd-ro' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dpd-ro', source: 'dpd-ro', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${DPD_RO_ENDPOINT}?`))).toBe(true);
  });
});

describe('DPD Romania numbers', () => {
  it('suggests eleven digits starting with 8 and is asked about them only for a lookup in Romania', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(DELIVERED).candidates).toContain('dpd-ro');
    expect(recognitionAskedCarriers(DELIVERED, { countryHint: 'RO' })[0]).toBe('dpd-ro');
    for (const countryHint of [undefined, 'BG', 'DE', 'AL', 'NZ']) {
      expect(recognitionAskedCarriers(DELIVERED, { countryHint }), `${countryHint}`).not.toContain('dpd-ro');
    }
    for (const other of ['70000000001', '8000000001', '800000000012']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('dpd-ro');
    }
  });
});

describe('DPD Romania status vocabulary', () => {
  it('records every code and phase with the stage the adapter gives it, and its documented English wording', () => {
    for (const entry of statuses.entries) {
      if (!('code' in entry) || !entry.code) continue;
      const known = /^-?\d+$/.test(entry.code) ? dpdRoOperation(entry.code) : dpdRoPhase(entry.code);
      expect(known?.stage, entry.code).toBe('stage' in entry ? entry.stage : undefined);
      if (entry.language === 'en') expect(known?.wording, entry.code).toBe(entry.wording);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(dpdRoOperation('152')).toEqual({ wording: 'Routed to another DPD Location', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'dpd-ro', providerCode: '128', description: 'Canceled' })).toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMapAnswer({ carrier: 'dpd-ro', providerCode: '175', description: 'Predict' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
