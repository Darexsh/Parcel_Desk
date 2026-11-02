import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import type { CarrierError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VIADIRETA_TRACKER, ViadiretaTracker, viadiretaLookupUrl } from './adapter.js';
import { normalizeViadiretaNumber, parseViadireta } from './parser.js';
import { newDeliveryDay, statusMap, viadiretaMappedStage, viadiretaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'VD900000000017';
const UNKNOWN = 'VD900000000099';
// VDVD, the label's day 1 March 2026 and six digits.
const DATED = 'VDVD010326000017';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt = {};</script></body></html>';
// The parcel before its delivery: the delivery row gone.
const onItsWay = () => text('delivered.html').replace(/<div class="tl-item">\s*<div class="tl-dot tl-success">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '');

describe('ViaDireta numbers', () => {
  const offers = (number: string) => {
    const match = detectCarrierMatch(number);
    return [match.carrier, ...(match.candidates ?? [])];
  };

  it('names ViaDireta for VD and twelve digits, and for VDVD, a date and six digits', () => {
    for (const number of [DELIVERED, DELIVERED.toLowerCase(), DATED, 'VDVD311299999999', 'VDVD011025000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'viadireta', confidence: 'high' });
    }
    expect(parseTrackingInput(`Envio ${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'viadireta' });
  });

  it('leaves other lengths, letters and impossible dates alone', () => {
    for (const other of [
      'VD90000000001', 'VD9000000000170', 'VE900000000017', 'DV900000000017', 'VDX00000000017',
      'VDVD01032600001', 'VDVD0103260000170',
      // Day 00 and 32, month 00 and 13.
      'VDVD000326000017', 'VDVD320326000017', 'VDVD010026000017', 'VDVD011326000017',
      // VD and ten digits is Relais Colis's layout too.
      'VD9000000017',
    ]) {
      expect(offers(other), other).not.toContain('viadireta');
    }
  });

  it('names ViaDireta for its own names', () => {
    for (const name of ['ViaDireta', 'Via Direta', 'Via Directa', 'Viadirecta']) expect(carrierIdFromName(name), name).toBe('viadireta');
  });
});

describe('ViaDireta HTTP adapter', () => {
  it('opens the tracking page with the number in its address, in Portuguese', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ViadiretaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' vd 9000 0000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${VIADIRETA_TRACKER}?codigo=${DELIVERED}`);
    expect(url).toBe(viadiretaLookupUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Accept-Language': 'pt-PT,pt;q=0.9' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'viadireta', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the movements as wall clocks, newest first, and the page order on one clock', () => {
    const result = parseViadireta(text('delivered.html'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Realizado com Sucesso', last_update: null, last_update_local: '2026-03-04T16:12:40', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-03-04T16:12:40', 'Realizado com Sucesso', 'delivered'],
      ['2026-03-04T08:05:13', 'O Serviço encontra-se em Distribuição', 'out_for_delivery'],
      ['2026-03-03T11:20:00', 'Agendado com Destinatário para. Nova data: 04-03-2026', 'in_transit'],
      ['2026-03-02T22:47:09', 'Entrada no Armazém da Viadirecta', 'in_transit'],
      ['2026-03-02T17:31:26', 'Atribuição da Zona de Distribuição', 'registered'],
      ['2026-03-02T17:31:26', 'Registo na Plataforma da Viadirecta', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The summary, which follows the language asked, is not read.
    expect(JSON.stringify(result)).not.toMatch(/Entregue com Sucesso|synthetic-token/);
  });

  it('reads a dated number', () => {
    const page = text('delivered.html').replaceAll(DELIVERED, DATED);
    expect(parseViadireta(page, DATED)).toMatchObject({ status: 'delivered' });
  });

  it('gives the delivery day the newest movement sets until the parcel is delivered', () => {
    expect(parseViadireta(onItsWay(), DELIVERED)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'O Serviço encontra-se em Distribuição', last_update_local: '2026-03-04T08:05:13', expected_delivery: '2026-03-04' });
    // A failed round sets a later day; the shared rules read a problem the map does not know.
    const failed = onItsWay().replace('O Serviço encontra-se em Distribuição', 'Cliente ausente e incontactável. Nova data: 05-03-2026');
    expect(parseViadireta(failed, DELIVERED)).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      expected_delivery: '2026-03-05' });
    // A day that is not one, or one before the newest movement, is no expectation.
    expect(parseViadireta(failed.replace('05-03-2026', '31-02-2026'), DELIVERED).expected_delivery).toBeNull();
    expect(parseViadireta(failed.replace('05-03-2026', '03-03-2026'), DELIVERED).expected_delivery).toBeNull();
    expect(parseViadireta(onItsWay().replace('Nova data: 04-03-2026', ''), DELIVERED).expected_delivery).toBeNull();
  });

  it('puts the movements in clock order when the page does not', () => {
    const result = parseViadireta(text('delivered.html').replace('02-03-2026 22:47:09', '05-03-2026 09:00:00'), DELIVERED);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-03-05T09:00:00', '2026-03-04T16:12:40', '2026-03-04T08:05:13',
      '2026-03-03T11:20:00', '2026-03-02T17:31:26', '2026-03-02T17:31:26']);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-03-05T09:00:00' });
  });

  it('keeps a movement the page lists twice once, and leaves an unknown wording without a stage', () => {
    const doubled = text('delivered.html').replace(/(<div class="tl-item">\s*<div class="tl-dot tl-success">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>)/, '$1$1');
    expect(parseViadireta(doubled, DELIVERED).events).toHaveLength(6);
    const unknown = parseViadireta(text('delivered.html').replace('Realizado com Sucesso', 'Movimento de exemplo'), DELIVERED);
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-04T16:12:40', description: 'Movimento de exemplo' });
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Movimento de exemplo' });
  });

  it('leaves the notice for a number the page cannot show inconclusive, as a failing lookup gets it too', async () => {
    expect(() => parseViadireta(text('unavailable.html'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ViaDireta could not show the shipment' }));
    // It carries no reason: nothing on the page says the number is unknown rather than the lookup broken.
    let error: unknown;
    try { parseViadireta(text('unavailable.html'), UNKNOWN); } catch (caught) { error = caught; }
    expect((error as CarrierError).reason).toBeUndefined();
    await expect(carrier(replying(() => html(text('unavailable.html')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    // The form alone, with neither a shipment nor the notice, is not an answer.
    const bare = text('unavailable.html').replace(/<div class="alert alert-error"[\s\S]*?<\/div>/, '');
    expect(() => parseViadireta(bare, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a page opened with the whole number asked', () => {
    expect(() => parseViadireta(text('delivered.html'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ViaDireta answered for another shipment' }));
    expect(() => parseViadireta(text('unavailable.html'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ViaDireta answered for another shipment' }));
    // The form keeps the number asked, but the card names another.
    expect(() => parseViadireta(text('delivered.html').replace(`Envio Nº ${DELIVERED}`, `Envio Nº ${UNKNOWN}`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ViaDireta answered for another shipment' }));
    // A page that dropped the number from its form did not look it up.
    expect(() => parseViadireta(text('delivered.html').replace(`value="${DELIVERED}"\n`, 'value=""\n'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = text('delivered.html').replace(/(<div class="tracking-status-card"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>)/, '$1$1');
    expect(() => parseViadireta(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ViaDireta answered for several shipments' }));
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('id="codigo"', 'id="codigoEnvio"'),
      delivered.replace(`<div class="ts-cod">Envio Nº ${DELIVERED}</div>`, '<div class="ts-cod"></div>'),
      delivered.replace('<h3>Histórico de Movimentos</h3>', '$&<div class="tracking-timeline"></div>'),
      delivered.replace('>04-03-2026 16:12:40<', '>2026-03-04 16:12:40<'),
      delivered.replace('>04-03-2026 16:12:40<', '>04-03-2026 24:00:00<'),
      delivered.replace('>04-03-2026 16:12:40<', '>30-02-2026 16:12:40<'),
      delivered.replace('<div class="tl-desc">Realizado com Sucesso</div>', '<div class="tl-desc"> </div>'),
      delivered.replace('<div class="tl-time">04-03-2026 16:12:40</div>', ''),
      delivered.replace(/(<div class="tl-item">\s*<div class="tl-dot tl-success">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>)/, (row) => row.repeat(301)),
    ].entries()) {
      expect(() => parseViadireta(body, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a shipment without movements', () => {
    const empty = text('delivered.html').replace(/<div class="tracking-timeline"[\s\S]*?<\/div>(?=\s*<\/div>\s*<div id="trkInfoModal")/, '');
    expect(() => parseViadireta(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const cleared = text('delivered.html').replace(/<div class="tl-item">[\s\S]*<\/div>(?=\s*<\/div>\s*<\/div>\s*<div id="trkInfoModal")/, '');
    expect(() => parseViadireta(cleared, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a firewall page, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: DELIVERED });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 301, headers: { Location: VIADIRETA_TRACKER } })))
      .rejects.toMatchObject({ kind: 'transport', status: 301 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
  });

  it('refuses what the carrier does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['VD90000000001', 'VD9000000000170', 'VE900000000017', 'VDVD0103260000', '900000000017', 'V'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    // VD and ten digits is the example the page's own form shows.
    expect(normalizeViadiretaNumber(' vd 9000 0000 17 ')).toBe('VD9000000017');
    expect(normalizeViadiretaNumber(DATED.toLowerCase())).toBe(DATED);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the page shows, and never takes its notice for an unknown number', async () => {
    await expect(carrier(replying(() => html(text('delivered.html')))).recognize!(DELIVERED))
      .resolves.toMatchObject({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T16:12:40' });
    await expect(carrier(replying(() => html(text('unavailable.html')))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('VE900000000017')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'viadireta', source: 'viadireta', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === viadiretaLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('ViaDireta status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      const wording = entry.wording.replace('<date>', '02-03-2026');
      expect(statusMapAnswer({ carrier: 'viadireta', providerCode: null, description: wording }), wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(viadiretaStage(wording), wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('reads a wording without its new delivery day, closing full stop or long dash', () => {
    expect(viadiretaMappedStage('Cliente ausente e incontactável')).toBe('failed_attempt');
    expect(viadiretaMappedStage('Cliente ausente e incontactável. Nova data: 02-03-2026.')).toBe('failed_attempt');
    expect(viadiretaMappedStage('Entrega não conseguida – Nova tentativa a. Nova data: 02-03-2026')).toBe('failed_attempt');
    expect(newDeliveryDay('Agendado com Destinatário para. Nova data: 02-03-2026')).toEqual([2, 3, 2026]);
    expect(newDeliveryDay('Realizado com Sucesso')).toBeNull();
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'movimento de exemplo')).toBeUndefined();
    expect(statusMap.stage('X1', 'realizado com sucesso')).toBeUndefined();
    expect(viadiretaStage('Movimento de exemplo')).toBeNull();
    expect(statusMapAnswer({ carrier: 'viadireta', providerCode: null, description: 'Movimento de exemplo' })).toEqual({ kind: 'unknown' });
  });
});
