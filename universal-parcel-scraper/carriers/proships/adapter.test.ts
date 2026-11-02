import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PROSHIPS_ACTION, PROSHIPS_API, PROSHIPS_PAGE, ProshipsTracker } from './adapter.js';
import { normalizeProshipsNumber, parseProships, parseProshipsNonce, proshipsWording } from './parser.js';
import { proshipsMappedStage, proshipsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ML000000011MH';
const CUSTOMS = 'ML000000002MH';
const UNKNOWN = '0000000000000';
const NONCE = '0a1b2c3d4e';

type Reply = { success: boolean; data: string };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const PAGE = text('tracking-page.html');
/** A fixture whose HTML is changed in place by `change`. */
const changed = (name: string, change: (html: string) => string): Reply => {
  const reply = fixture(name);
  return { ...reply, data: change(reply.data) };
};
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
/** A site that serves the tracking page, then `lookup` for the plugin's action. */
const site = (lookup: () => Response, page: () => Response = () => html(PAGE)) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url).startsWith(PROSHIPS_PAGE) ? page() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('ProShips HTTP adapter', () => {
  it('reads the nonce from the number’s tracking page, then posts the whole number with it, through the supplied transport', async () => {
    const fetcher = site(() => json(fixture('customs')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ProshipsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ml 000-000-002 mh ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(String(pageUrl)).toBe(`${PROSHIPS_PAGE}?tracking=${CUSTOMS}`);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(url)).toBe(PROSHIPS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ action: PROSHIPS_ACTION, tracking_code: CUSTOMS, nonce: NONCE });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'proships', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('takes the lookup’s nonce, not the theme’s, and needs exactly one', () => {
    expect(parseProshipsNonce(PAGE)).toBe(NONCE);
    expect(() => parseProshipsNonce(PAGE.replace(`'nonce', '${NONCE}'`, "'nonce', ''"))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseProshipsNonce(PAGE.replace("'get_tracking_info'", "'other_action'"))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseProshipsNonce(PAGE.replace('</body>', "<script>formData.append('nonce', 'ffffffffff');</script></body>")))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseProshipsNonce(CLOUDFLARE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps each scan’s wall clock, once, newest first, and stages it by its wording', () => {
    const result = parseProships(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-03-14T15:20:00' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-03-14T15:20:00', 'Entregado', 'delivered'],
      ['2026-03-14T09:05:00', 'SALIDA DE MANIFIESTO En manos del cartero', 'out_for_delivery'],
      ['2026-03-13T19:40:00', 'Envío ingresó a ciudad destino', 'in_transit'],
      ['2026-03-13T08:10:00', 'Envío en tránsito a destino', 'in_transit'],
      ['2026-03-12T16:30:00', 'Paquete ingresó al centro de clasificación', 'in_transit'],
      // The scan listed twice is kept once.
      ['2026-03-12T04:15:00', 'Recepción en aduana', 'customs'],
      ['2026-03-02T01:55:00', 'Orden generada', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map' && !event.location)).toBe(true);
    expect(parseProships(fixture('customs'), CUSTOMS)).toMatchObject({ status: 'in_transit', current_stage: 'customs',
      last_status_text: 'Recepción en aduana', last_update_local: '2026-05-20T17:45:00', events: [{ stage: 'customs' }, { stage: 'registered' }] });
  });

  it('reads a history listed oldest first newest first', () => {
    const reversed = changed('delivered', (body) => {
      const [head, ...rows] = body.split('<div class="tracking-event">');
      const [last, tail] = rows.pop()!.split(/(?=\s*<\/div>\s*<\/div>\s*$)/);
      return [head, ...[...rows, last].reverse()].join('<div class="tracking-event">') + tail;
    });
    const result = parseProships(reversed, DELIVERED);
    expect(result).toMatchObject({ last_update_local: '2026-03-14T15:20:00', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Orden generada' });
  });

  it('keeps scans of one instant in the carrier\'s order when it lists them oldest first', () => {
    const row = (date: string, title: string) => `<div class="tracking-event"><div class="event-date">${date}</div><div class="event-title">${title}</div></div>`;
    const reply = { success: true, data: `<div class="tracking-container"><div class="tracking-header"><h3>${CUSTOMS}</h3></div><div class="tracking-events">${
      row('18-05-2026 21:12', 'Orden generada')}${row('20-05-2026 17:45', 'Envío en tránsito a destino')}${row('20-05-2026 17:45', 'Recepción en aduana')}</div></div>` };
    expect(parseProships(reply, CUSTOMS).events!.map((event) => event.description)).toEqual(['Recepción en aduana', 'Envío en tránsito a destino', 'Orden generada']);
  });

  it('takes the current status’s word for a parcel held, delivered or returned when the scans have not caught up', () => {
    const held = parseProships(changed('customs', (body) => body.replace('<h3>Recepción en aduana</h3>', '<h3>Retener</h3>')), CUSTOMS);
    expect(held).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', last_status_text: 'Retener',
      last_update_local: '2026-05-20T17:45:00' });
    // A current status of the journey's middle leaves the newest scan's stage.
    const middle = parseProships(changed('customs', (body) => body.replace('<h3>Recepción en aduana</h3>', '<h3>Envío en tránsito a destino</h3>')), CUSTOMS);
    expect(middle).toMatchObject({ current_stage: 'customs', last_status_text: 'Recepción en aduana' });
    // Without scans, an ended status is a summary and anything else no history.
    const noScans = (status: string) => changed('customs', (body) => body.replace('<h3>Recepción en aduana</h3>', `<h3>${status}</h3>`)
      .replace(/<div class="tracking-event">[\s\S]*<\/div>\s*<\/div>\s*<\/div>(?=\s*<\/div>\s*<\/div>\s*$)/, ''));
    expect(parseProships(noScans('Entregado'), CUSTOMS)).toMatchObject({ status: 'delivered', current_stage: 'delivered', summary_only: true, events: [] });
    expect(() => parseProships(noScans('Recepción en aduana'), CUSTOMS)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // A wording neither the map nor the shared rules know has no stage.
    const unknown = parseProships(changed('customs', (body) => body.replaceAll('Recepción en aduana', 'Nota de muestra')), CUSTOMS);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Nota de muestra' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('takes signatories and phone numbers out of the wording', () => {
    expect(proshipsWording('Entregado, recibido por Persona Ejemplo')).toBe('Entregado');
    expect(proshipsWording('Entregado - Firmado por Persona Ejemplo')).toBe('Entregado');
    expect(proshipsWording('Llamar al 300 000 0000 para coordinar')).toBe('Llamar al para coordinar');
    expect(proshipsWording('  SALIDA  DE MANIFIESTO   En manos del cartero ')).toBe('SALIDA DE MANIFIESTO En manos del cartero');
    expect(proshipsWording('Envío entregado a distribuidor')).toBe('Envío entregado a distribuidor');
    const signed = parseProships(changed('delivered', (body) => body.replace('>Entregado</div>', '>Entregado recibido por Persona Ejemplo</div>')), DELIVERED);
    expect(signed.events![0]).toMatchObject({ description: 'Entregado', stage: 'delivered' });
    expect(JSON.stringify(signed)).not.toContain('Persona Ejemplo');
  });

  it('reads the tracker’s answer for an unknown number as not found, and other refusals as inconclusive', () => {
    expect(() => parseProships(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The answer names the number it looked up; one naming another proves nothing about this one.
    expect(() => parseProships(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ProShips answered for another number' }));
    expect(() => parseProships({ success: false, data: 'Por favor ingresa un número de seguimiento' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ProShips did not complete the lookup' }));
  });

  it('keeps only the reply that names the whole number asked', () => {
    expect(() => parseProships(fixture('customs'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ProShips answered for another shipment' }));
    // The tracker echoes the number as it was sent, in any case.
    expect(parseProships(changed('customs', (body) => body.replace(CUSTOMS, CUSTOMS.toLowerCase())), CUSTOMS).events).toHaveLength(2);
    expect(() => parseProships(changed('customs', (body) => body.replace(CUSTOMS, `${CUSTOMS}9`)), CUSTOMS))
      .toThrow(expect.objectContaining({ message: 'ProShips answered for another shipment' }));
  });

  it('rejects a changed reply', () => {
    for (const [index, reply] of [
      { success: 'true', data: fixture('customs').data },
      { success: true, data: { html: '' } },
      { success: false },
      changed('customs', (body) => body.replace('tracking-container', 'tracking-box')),
      changed('customs', (body) => body + body),
      changed('customs', (body) => body.replace(/<h3>ML\d+MH<\/h3>/, '')),
      changed('customs', (body) => body.replace('<h3>Recepción en aduana</h3>', '<h3>A</h3><h3>B</h3>')),
      changed('customs', (body) => body.replace('20-05-2026 17:45', '2026-05-20 17:45')),
      changed('customs', (body) => body.replace('20-05-2026 17:45', '20-05-2026 24:00')),
      changed('customs', (body) => body.replace('20-05-2026 17:45', '30-02-2026 17:45')),
      changed('customs', (body) => body.replace('20-05-2026 17:45', '')),
      changed('customs', (body) => body.replace('>Orden generada<', '><')),
      changed('customs', (body) => body.replace('<div class="event-title">Orden generada</div>', '')),
      changed('customs', (body) => body.replace(/(<div class="tracking-events">)([\s\S]*?)(\s*<\/div>\s*<\/div>\s*$)/,
        (_all, open: string, rows: string, close: string) => open + rows.repeat(151) + close)),
    ].entries()) {
      expect(() => parseProships(reply, CUSTOMS), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refused nonce, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: () => Response, page?: () => Response) => carrier(site(body, page)).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // The plugin's answer to a nonce it does not accept is plain text.
    await expect(lookup(() => html('Error de seguridad'))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'nonce_expired' });
    await expect(lookup(() => html('-1'))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'nonce_expired' });
    // WordPress answers an action no plugin registers with HTTP 400 and `0`; a 404 or a redirect is a move too.
    await expect(lookup(() => html('0', { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://proships.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json(fixture('not-found')), () => html('', { status: 301, headers: { Location: 'https://proships.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json(fixture('not-found')), () => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json(fixture('not-found')), () => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('<html><title>Proships</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(fixture('not-found')), () => html('<html><title>Proships</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s from the page and from the lookup', async (status, kind) => {
      const fromLookup = site(() => new Response('', { status }));
      await expect(carrier(fromLookup).track({ number: CUSTOMS })).rejects.toMatchObject({ kind });
      expect(fromLookup).toHaveBeenCalledTimes(2);
      const fromPage = site(() => json(fixture('customs')), () => new Response('', { status }));
      await expect(carrier(fromPage).track({ number: CUSTOMS })).rejects.toMatchObject({ kind });
      expect(fromPage).toHaveBeenCalledTimes(1);
    });

  it('refuses what ProShips cannot look up, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000', 'SAMPLETRACKING', 'ML000000001MH,ML000000002MH', '0'.repeat(41), '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: CUSTOMS }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeProshipsNumber(' ml 000-000-011 mh ')).toBe(DELIVERED);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: CUSTOMS }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('declares no recognition: ProShips delivers other carriers’ numbers', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under ProShips to the adapter', async () => {
    const fetcher = site(() => json(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'proships' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'proships', source: 'proships', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === PROSHIPS_API)).toBe(true);
  });
});

describe('ProShips status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'proships', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(proshipsStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'devuelto al remitente')).toBeUndefined();
    expect(proshipsMappedStage('ENTREGADO')).toBeUndefined();
    expect(proshipsMappedStage('entregado')).toBe('delivered');
    expect(proshipsStage('Devuelto al remitente')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(proshipsStage('Nota de muestra')).toBeNull();
    expect(statusMapAnswer({ carrier: 'proships', providerCode: null, description: 'Nota de muestra' })).toEqual({ kind: 'unknown' });
  });
});
