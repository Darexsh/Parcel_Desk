import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AMPM_PAGE, AmpmTracker, ampmLookupUrl } from './adapter.js';
import { normalizeAmpmNumber, parseAmpm } from './parser.js';
import { ampmMappedStage, ampmStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = 'IDTS00000000000001';
const RETURNED = 'IDTS00000000000002';
const DELIVERED = 'IDTS00000000000003';
const DESTROYED = 'CNA000000000004';
const UNKNOWN = 'IDTS00000000000009';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Grupo ampm HTTP adapter', () => {
  it('opens the tracking page with the number in its address, as the form does', async () => {
    const fetcher = replying(() => html(text('in-transit.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AmpmTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' idts 0000-0000-0000-01 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${AMPM_PAGE}?tracking-id=${IN_TRANSIT}`);
    expect(url).toBe(ampmLookupUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ampm', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the movements as wall clocks, newest first, with their type, office and stage, and the promised day', () => {
    const result = parseAmpm(text('in-transit.html'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'PROCESADO EN INSTALACIONES', last_update: null, last_update_local: '2026-03-17T09:02:13', expected_delivery: '2026-03-20' });
    expect(result.events).toEqual([
      { local_time: '2026-03-17T09:02:13', location: 'HUB EJEMPLO', description: 'PROCESADO EN INSTALACIONES', provider_code: 'PI', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-17T08:10:44', location: 'HUB EJEMPLO', description: 'ENTRADA A CENTRO OPERATIVO', provider_code: 'AE', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-16T11:20:15', location: 'HUB EJEMPLO', description: 'ENVIO RECOLECTADO', provider_code: 'ER-01', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/MUESTRA|Pueblo Ejemplo|Cliente|ESTANDAR|000000000001|SAMPLE-TOKEN|podrastreo/);
  });

  it('reads a run that ended with the parcel returned, without the delivery details', () => {
    const result = parseAmpm(text('returned.html'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'DEVUELTO', last_update_local: '2026-02-12T15:27:08', expected_delivery: null });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([['EN', 'returned'], ['CM', 'out_for_delivery'], ['ER-01', 'accepted']]);
    expect(JSON.stringify(result)).not.toMatch(/Cliente|No Disponible|2026-02-12T15:27:00-06:00|SAMPLE-TOKEN/);
  });

  it('reads a delivery by its wording, keeps a row the page lists twice once and drops who received it', () => {
    const result = parseAmpm(text('delivered.html'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'ENTREGADO', last_update_local: '2026-03-04T13:05:47', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2026-03-04T13:05:47', 'EN', 'CEDIS EJEMPLO', 'delivered'],
      ['2026-03-04T09:44:02', 'CM', 'CEDIS EJEMPLO', 'out_for_delivery'],
      ['2026-03-03T07:20:31', 'AE', 'CEDIS EJEMPLO', 'in_transit'],
      ['2026-03-02T10:15:00', 'ER-01', 'HUB EJEMPLO', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/MUESTRA|INE|Domicilio|Puerto Ejemplo|2026-03-04T13:05:00-06:00/);
  });

  it('puts every movement after a return on the way back, and keeps an exception', () => {
    const result = parseAmpm(text('destroyed.html'), DESTROYED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'DESTRUIDO',
      last_update_local: '2026-05-06T12:21:33', expected_delivery: null });
    // Equal clocks keep the page's order, newest first.
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['5561', 'exception'], ['PI', 'returned'], ['SR', 'returned'], ['PDEV', 'returned'], ['VI', 'returned'], ['PI', 'returned'],
      ['DAC', 'returned'], ['RC', 'returned'], ['TE', 'exception'], ['AE', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/CAINIAO|E-COMERCE/);
  });

  it('puts the movements in clock order when the page does not, and leaves an unknown wording without a stage', () => {
    const body = text('in-transit.html').replace('17-03-2026 09:02:13', '15-03-2026 09:02:13').replace('PROCESADO EN INSTALACIONES', 'MOVIMIENTO DE MUESTRA');
    const result = parseAmpm(body.replace('<td>PI</td>', '<td>ZZ</td>'), IN_TRANSIT);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-03-17T08:10:44', '2026-03-16T11:20:15', '2026-03-15T09:02:13']);
    expect(result.events![2]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'ENTRADA A CENTRO OPERATIVO' });
  });

  it('reads the tracker’s “invalid or without information” as inconclusive, not as a missing parcel', async () => {
    expect(() => parseAmpm(text('not-found.html'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // Another notice is not the tracker's answer.
    expect(() => parseAmpm(text('not-found.html').replace('inválido o sin información', 'no disponible por el momento'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a page whose heading names the whole number asked', () => {
    expect(() => parseAmpm(text('in-transit.html'), RETURNED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Grupo ampm answered for another shipment' }));
    expect(() => parseAmpm(text('not-found.html'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Grupo ampm answered for another shipment' }));
    expect(() => parseAmpm(text('in-transit.html').replace(`RASTREO: ${IN_TRANSIT}`, `RASTREO: ${IN_TRANSIT}0`), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Grupo ampm answered for another shipment' }));
    expect(() => parseAmpm(text('in-transit.html').replace(`RASTREO: ${IN_TRANSIT}`, 'RASTREO:'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Grupo ampm did not name the shipment' }));
    // The tracker echoes the number as it was typed.
    expect(parseAmpm(text('in-transit.html').replace(`RASTREO: ${IN_TRANSIT}`, `RASTREO: ${IN_TRANSIT.toLowerCase()}`), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed page', () => {
    const page = text('in-transit.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      page.replace('class="rastreo"', 'class="numero"'),
      page.replace('<p class="rastreo"', '<p class="rastreo">RASTREO: IDTS00000000000005</p><p class="rastreo"'),
      page.replace('id="grvMovimientos"', 'id="movimientos"'),
      page.replace('<th scope="col">OFICINA</th>', '<th scope="col">LUGAR</th>'),
      page.replace('16-03-2026 11:20:15', '2026-03-16 11:20:15'),
      page.replace('16-03-2026 11:20:15', '16-03-2026 24:00:00'),
      page.replace('16-03-2026 11:20:15', '30-02-2026 11:20:15'),
      page.replace('<td>ENVIO RECOLECTADO</td>', '<td> </td>'),
      page.replace('<td>HUB EJEMPLO</td></tr>', '</tr>'),
      page.replace(/(<\/tr>)(<tr style)/, (_all, end: string, start: string) => end + '<tr><td>16-03-2026 11:20:15</td><td>ZZ</td><td>MUESTRA</td><td>HUB</td></tr>'.repeat(501) + start),
    ].entries()) {
      expect(() => parseAmpm(body, IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a shipment whose table holds no movement', () => {
    const empty = text('in-transit.html').replace(/<\/tr><tr style[\s\S]*?<\/tbody><\/table>/, '</tr></tbody></table>');
    expect(() => parseAmpm(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads no promise it cannot parse', () => {
    expect(parseAmpm(text('in-transit.html').replace('20-03-2026 21:00:00', ''), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    expect(parseAmpm(text('in-transit.html').replace('20-03-2026 21:00:00', '31-02-2026 21:00:00'), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('keeps a browser check, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: IN_TRANSIT });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 301, headers: { Location: 'https://grupoampm.com/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 301 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    // A page that carries the tracker's heading is the tracker's, whatever else it embeds.
    await expect(lookup(() => html(text('in-transit.html').replace('</footer>', '<div class="g-recaptcha"></div></footer>'))))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
  });

  it('refuses what the carrier does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000001', 'IDTSZZZZZZZZZZ', `IDTS${'0'.repeat(27)}`, 'IDTS0000000001,IDTS0000000002', 'IDTS/000000001', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAmpmNumber(' cna 0000 0000 0004 ')).toBe(DESTROYED);
    expect(normalizeAmpmNumber('0000000001')).toBe('0000000001');
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('declares no recognition: the tracker never says a number is unknown', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Grupo ampm to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ampm' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ampm', source: 'ampm', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === ampmLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Grupo ampm status vocabulary', () => {
  it('records every movement type the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (!entry.code) continue;
      expect(statusMapAnswer({ carrier: 'ampm', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(ampmStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('reads EN by its outcome and leaves the rest to the shared rules', () => {
    expect(ampmMappedStage('EN', 'devuelto')).toBe('returned');
    expect(ampmMappedStage('EN', 'entregado')).toBeUndefined();
    expect(ampmMappedStage('PI', 'otra palabra')).toBe('in_transit');
    expect(ampmStage('EN', 'ENTREGADO')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(ampmStage('ZZ', 'MOVIMIENTO DE MUESTRA')).toBeNull();
    expect(statusMap.stage(null, 'devuelto')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'ampm', providerCode: 'ZZ', description: 'MOVIMIENTO DE MUESTRA' })).toEqual({ kind: 'unknown' });
  });
});
