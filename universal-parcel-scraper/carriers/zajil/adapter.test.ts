import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ZAJIL_API, ZajilTracker } from './adapter.js';
import { normalizeZajilNumber, parseZajil } from './parser.js';
import { statusMap, zajilStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '00000000001';
const IN_TRANSIT = '00000000002';
const UNKNOWN = '00000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { history: Row[]; current_update: Row };

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(`${name}.json`)) as Shipment;
const changed = (name: string, change: (shipment: Shipment) => void) => {
  const shipment = fixture(name);
  change(shipment);
  return shipment;
};
// A history row of the fixtures' shape, with another update, wording, clock and place.
const status = (shipment: Shipment, update: string, wording: string, date: string, place: string): Row => ({
  ...shipment.history[0]!, website_update: update, arabic_update: wording, date, location_name: place, location_city: place,
});
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Zajil HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ZajilTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000-0000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ZAJIL_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zajil', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment as its current status alone, on a wall clock, without amounts or branch codes', () => {
    const result = parseZajil(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'تم التوصيل',
      last_update: null, last_update_local: '2026-03-09T14:21:05', expected_delivery: null, destination_country: 'SA', summary_only: true,
      events: [{ local_time: '2026-03-09T14:21:05', location: 'Dammam', description: 'تم التوصيل', provider_code: 'delivered',
        stage: 'delivered', stage_source: 'carrier_map' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/not found|string|feedback|POD|Abha|-----/);
  });

  it('reads a shipment released from a hub', () => {
    expect(parseZajil(fixture('in-transit'), IN_TRANSIT)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'جارى عمليه النقل', last_update_local: '2026-03-10T08:47:31',
      summary_only: true, events: [{ local_time: '2026-03-10T08:47:31', location: 'HUB07-DMM', provider_code: 'In_Transit', stage: 'in_transit' }],
    });
  });

  it('keeps a longer history newest first, without the flag of a lone status', () => {
    const result = parseZajil(changed('delivered', (shipment) => {
      shipment.history.unshift(
        status(shipment, 'processing', 'تم استلام الطلب', '2026-03-07T10:00:00.000', 'Abha'),
        status(shipment, 'out_for_delviery', 'خرجت للتوصيل', '2026-03-09T09:15:00.250', 'Dammam'),
        status(shipment, 'arrived', 'وصلت إلى الفرع', '2026-03-08T19:30:00.000', 'Dammam'),
      );
    }), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-03-09T14:21:05' });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-03-09T14:21:05', 'delivered', 'delivered'],
      ['2026-03-09T09:15:00', 'out_for_delviery', 'out_for_delivery'],
      ['2026-03-08T19:30:00', 'arrived', 'in_transit'],
      ['2026-03-07T10:00:00', 'processing', 'registered'],
    ]);
  });

  it('keeps statuses of one second in the reply’s order, reversed when it lists them oldest first', () => {
    const result = parseZajil(changed('delivered', (shipment) => {
      shipment.history.unshift(
        status(shipment, 'processing', 'تم استلام الطلب', '2026-03-07T10:00:00.000', 'Abha'),
        status(shipment, 'out_for_delviery', 'خرجت للتوصيل', '2026-03-09T14:21:05.000', 'Dammam'),
      );
    }), DELIVERED);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['delivered', 'out_for_delviery', 'processing']);
  });

  it('takes the shipment’s own update over its newest status, and words a status without its Arabic line by its update', () => {
    const ahead = parseZajil(changed('in-transit', (shipment) => { shipment.website_update = 'undelivered'; }), IN_TRANSIT);
    expect(ahead).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'جارى عمليه النقل' });
    const unworded = parseZajil(changed('in-transit', (shipment) => {
      shipment.history[0]!.arabic_update = '';
      shipment.current_update.arabic_update = '';
      shipment.website_update = 'Synthetic_update';
    }), IN_TRANSIT);
    expect(unworded).toMatchObject({ current_stage: 'in_transit', last_status_text: 'In Transit' });
    // An update the map does not know leaves the status without a stage.
    const unknown = parseZajil(changed('in-transit', (shipment) => {
      for (const row of [shipment.history[0]!, shipment.current_update]) row.website_update = 'Synthetic_update';
      shipment.website_update = 'Synthetic_update';
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'جارى عمليه النقل' });
    expect(unknown).not.toHaveProperty('current_stage');
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('reads a shipment without statuses from its own update, and nothing at all as no history', () => {
    expect(parseZajil(changed('in-transit', (shipment) => {
      shipment.history = [];
      (shipment as Row).current_update = null;
    }), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'جارى عمليه النقل', last_update_local: null,
      provider_code: 'In_Transit', summary_only: true, events: [] });
    expect(() => parseZajil(changed('in-transit', (shipment) => {
      shipment.history = [];
      (shipment as Row).current_update = null;
      shipment.website_update = '';
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the lookup’s own error as not found', () => {
    expect(() => parseZajil(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseZajil(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Zajil answered for another shipment' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete shipment.shipment; },
      (shipment: Shipment) => { shipment.shipment = { number: IN_TRANSIT }; },
      (shipment: Shipment) => { shipment.history = 'history' as never; },
      (shipment: Shipment) => { shipment.history = Array.from({ length: 501 }, () => shipment.history[0]!); },
      (shipment: Shipment) => { shipment.history[0] = 'row' as never; },
      (shipment: Shipment) => { shipment.current_update = 'current' as never; },
      (shipment: Shipment) => { shipment.history[0]!.website_update = null; },
      (shipment: Shipment) => { shipment.history[0]!.website_update = 'in transit'; },
      (shipment: Shipment) => { shipment.history[0]!.arabic_update = 7; },
      (shipment: Shipment) => { shipment.history[0]!.location_name = ['Dammam']; },
      (shipment: Shipment) => { shipment.history[0]!.date = '2026-03-10 08:47:31'; },
      (shipment: Shipment) => { shipment.history[0]!.date = '2026-02-30T08:47:31.090'; },
      (shipment: Shipment) => { shipment.history[0]!.date = '2026-03-10T08:47:31Z'; },
      (shipment: Shipment) => { shipment.history[0]!.date = 1773132451090; },
    ]) {
      expect(() => parseZajil(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], [{ code: 'other' }], 'shipment']) {
      expect(() => parseZajil(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a failed lookup, a moved route, a browser check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // The server error it answers for an eleven-digit number it has no shipment for proves no absence.
    await expect(lookup(raw('server-error.html'), { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found', status: 500 });
    // Only the lookup's own error is an unknown number: a bare 404 page or another error is a moved route.
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup([{ message: 'other', code: 'other' }], { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://zajil-express.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Attention Required! | Cloudflare</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '30' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup('<html><title>Zajil</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[502, 'indeterminate'], [503, 'maintenance'], [504, 'indeterminate']] as const)('preserves HTTP %s as %s', async (code, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: code }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends a read that fails to reach the site only once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects numbers Zajil does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000000', '0000000000000', 'Z000000', 'Z00000000', 'A0000000', 'ZZ0000000000', `0${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeZajilNumber('000 000 000 001')).toBe('000000000001');
    expect(normalizeZajilNumber('z0000000')).toBe('Z0000000');
  });

  it('routes a number filed under Zajil to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'zajil' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'zajil', source: 'zajil', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${ZAJIL_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Zajil numbers', () => {
  it('claims no number shape: the digit runs stay with the carriers whose rules already offer them', () => {
    for (const number of [DELIVERED, '000000000001', 'Z0000000']) {
      expect(detectCarrierMatch(number).carrier).not.toBe('zajil');
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('zajil');
    }
  });
});

describe('Zajil status vocabulary', () => {
  it('records every update the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries.filter((item) => item.code)) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(zajilStage(entry.code!, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'zajil', providerCode: 'delivered', description: 'تم التوصيل' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'zajil', providerCode: 'Synthetic_update', description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
    expect(zajilStage('Synthetic_update', 'Synthetic status')).toBeNull();
  });
});
