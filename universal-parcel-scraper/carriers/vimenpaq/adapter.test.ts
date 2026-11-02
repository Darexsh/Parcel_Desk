import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VimenpaqTracker } from './adapter.js';
import { controlboxTrackUrl } from './controlbox.js';
import { normalizeVimenpaqNumber, parseVimenpaq, VIMENPAQ, VIMENPAQ_API } from './parser.js';
import { statusMap, vimenpaqStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'AAA0000000001';
const IN_TRANSIT = 'BBB0000000000';
const TRACKING = 'TBA000000000000';
const UNKNOWN = 'CCC0000000000';
const LOOKUP = `${VIMENPAQ_API}/Consultas/RastreoGuia?tracking=`;

type Row = Record<string, unknown>;
type Guide = Row & { Status: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Guide;
const changed = (name: string, change: (guide: Guide) => void) => {
  const guide = fixture(name);
  change(guide);
  return guide;
};
const row = (CreatedDate: string, StatusDescription: string, Comment: string | null = null): Row => ({ CreatedDate, Comment, StatusDescription });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Vimenpaq HTTP adapter', () => {
  it('posts the whole number in capitals to the app tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VimenpaqTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' aaa 0000-000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LOOKUP}${DELIVERED}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: '"{}"',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vimenpaq', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(controlboxTrackUrl({ ...VIMENPAQ, api: `${VIMENPAQ_API}/` }, 'tba 000000000000')).toBe(`${LOOKUP}${TRACKING}`);
  });

  it('keeps each status’s wall clock and wording, once per burst, without the comments', () => {
    const result = parseVimenpaq(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-05-13T15:48:19', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-05-13T15:48:19', 'Entregado', 'delivered'],
      // Written three times in two seconds: the first counts.
      ['2026-05-13T09:02:09', 'Disponible para retiro', 'ready_for_pickup'],
      ['2026-05-12T23:40:03', 'En ruta para entrega', 'in_transit'],
      ['2026-05-12T18:20:45', 'Consolidado', 'in_transit'],
      ['2026-05-12T16:45:00', 'Recibido en Centro de Distribución', 'in_transit'],
      ['2026-05-11T11:42:50', 'En proceso de recoleccion', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample|000-0000000|AAA 0\.0|cons#|Bolsa|Pendiente|13\/5/);
  });

  it('reads a guide on its way and one waiting at a branch', () => {
    expect(parseVimenpaq(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'En ruta para entrega', last_update_local: '2026-06-03T00:57:23' });
    const waiting = parseVimenpaq(changed('in-transit', (guide) => {
      guide.Status.unshift(row('2026-06-03T14:37:22.297', 'Disponible para retiro', 'Sample Person'));
    }), IN_TRANSIT);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Disponible para retiro' });
    expect(JSON.stringify(waiting)).not.toContain('Sample Person');
  });

  it('keeps the same wording apart a minute or more later, and orders rows by their clocks', () => {
    const result = parseVimenpaq(changed('delivered', (guide) => {
      guide.Status = [guide.Status[6]!, row('2026-05-14T08:00:00', 'Disponible para retiro'), guide.Status[1]!,
        row('2026-05-13T09:03:12.5', 'Disponible para retiro'), row('2026-05-12T20:00:00', 'Sample note')];
    }), DELIVERED);
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null])).toEqual([
      ['2026-05-14T08:00:00', 'ready_for_pickup'],
      ['2026-05-13T09:03:12', 'ready_for_pickup'],
      ['2026-05-13T09:02:11', 'ready_for_pickup'],
      ['2026-05-12T20:00:00', null],
      ['2026-05-12T16:45:00', 'in_transit'],
    ]);
  });

  it('reads a handover to a third party as a delivery', () => {
    expect(parseVimenpaq(changed('delivered', (guide) => {
      guide.Status[0]!.StatusDescription = 'Entregado a Tercero'.padEnd(255);
    }), DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Entregado a Tercero' });
  });

  it('reads the empty guide as not found and a guide without rows as no history', () => {
    expect(() => parseVimenpaq(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseVimenpaq(changed('not-found', (guide) => { guide.Status = null as never; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseVimenpaq(changed('delivered', (guide) => { guide.Status = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a guide only when it or the tracking number it holds is the number asked', () => {
    expect(() => parseVimenpaq(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Vimenpaq answered for another shipment' }));
    const held = changed('in-transit', (guide) => { guide.Tracking = TRACKING; });
    expect(parseVimenpaq(held, TRACKING).events).toHaveLength(3);
    expect(() => parseVimenpaq(held, `${TRACKING}0`)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseVimenpaq(changed('delivered', (guide) => { guide.NumeroGuia = ' AAA0000000001   '; }), DELIVERED).events).toHaveLength(6);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (guide: Guide) => { delete (guide as Row).NumeroGuia; },
      (guide: Guide) => { delete (guide as Row).Status; },
      (guide: Guide) => { guide.Status = 'rows' as never; },
      (guide: Guide) => { guide.Status = Array.from({ length: 501 }, () => guide.Status[0]!); },
      (guide: Guide) => { guide.Status[0] = 'row' as never; },
      (guide: Guide) => { guide.NumeroGuia = 7; },
      (guide: Guide) => { guide.Status[0]!.StatusDescription = ' '.repeat(255); },
      (guide: Guide) => { guide.Status[0]!.StatusDescription = ['Entregado']; },
      (guide: Guide) => { delete guide.Status[0]!.CreatedDate; },
      (guide: Guide) => { guide.Status[0]!.CreatedDate = '0001-01-01T00:00:00'; },
      (guide: Guide) => { guide.Status[0]!.CreatedDate = '2026-02-30T10:00:00'; },
      (guide: Guide) => { guide.Status[0]!.CreatedDate = '2026-05-13T24:00:00'; },
      (guide: Guide) => { guide.Status[0]!.CreatedDate = '2026-05-13T15:48:19Z'; },
      (guide: Guide) => { guide.Status[0]!.CreatedDate = '5/13/2026 3:48:19 PM'; },
    ]) {
      expect(() => parseVimenpaq(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseVimenpaq(changed('not-found', (guide) => { guide.Status = fixture('delivered').Status; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseVimenpaq([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The API answers a missing guide with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup({ Message: 'No HTTP resource was found that matches the request URI.' }, { status: 404 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://ssl3.controlbox.net:8443/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Rastreo</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ Message: 'An error has occurred.' })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty guide, and asks nothing for a number Vimenpaq does not take', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-13T15:48:19' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('AAA0000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Vimenpaq does not take and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['AAA0000', 'SAMPLETRACKING', `AAA${'0'.repeat(28)}`, 'AAA000000/0000', 'AAA0000*000000']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeVimenpaqNumber('tba 0000.0000-0000')).toBe(TRACKING);
  });

  it('retries a request that does not reach the API once, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('routes a number filed under Vimenpaq to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'vimenpaq' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'vimenpaq', source: 'vimenpaq', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${LOOKUP}${DELIVERED}`)).toBe(true);
  });
});

describe('Vimenpaq status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    expect(statuses.entries.length).toBeGreaterThan(0);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'vimenpaq', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(vimenpaqStage(`${entry.wording.toUpperCase()}   `), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // Wording the map does not know falls to the shared rules.
    expect(vimenpaqStage('Devuelto')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(vimenpaqStage('Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'vimenpaq', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
