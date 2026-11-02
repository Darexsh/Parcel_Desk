import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LogisimpleTracker } from './adapter.js';
import { LOGISIMPLE, normalizeLogisimpleNumber, parseLogisimple } from './parser.js';
import { courierPortalTrackingUrl } from './portal.js';
import { logisimpleMappedStage, logisimpleStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = '000000000017';
const UNKNOWN = '000000000025';
const PAGE = `https://portal.logisimple.pt/pt/tracking?tracking=${PARCEL}`;

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

const ROW = /<tr>\s*<td>2026-03-16<\/td>\s*<td>11:19<\/td>[\s\S]*?<\/tr>/;
/** The delivered page with its newest row changed. */
const newest = (change: (row: string) => string) => text('delivered.html').replace(ROW, change);
/** The delivered page with its two newest rows gone: the parcel is planned on a round. */
const planned = () => text('delivered.html').replace(ROW, '').replace(/<tr>\s*<td>2026-03-16<\/td>[\s\S]*?<\/tr>/, '');

describe('Logisimple HTTP adapter', () => {
  it('opens the Portuguese tracking page at the number’s address', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LogisimpleTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000 0000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PAGE);
    expect(courierPortalTrackingUrl(LOGISIMPLE, PARCEL)).toBe(PAGE);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Accept-Language': 'pt-PT,pt' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'logisimple', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the scans as wall clocks named by their state, with the warehouse’s town, newest first', () => {
    const result = parseLogisimple(text('delivered.html'), PARCEL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregue', last_update: null, last_update_local: '2026-03-16T11:19:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-16T11:19:00', 'Entregue', 'Vila Exemplo', 'delivered'],
      ['2026-03-16T07:23:00', 'Em Distribuição', undefined, 'out_for_delivery'],
      ['2026-03-13T16:42:00', 'Em Rota', 'Vila Exemplo', 'in_transit'],
      ['2026-03-13T16:35:00', 'Agendado', 'Vila Exemplo', 'in_transit'],
      ['2026-03-09T15:20:00', 'A Agendar', undefined, 'in_transit'],
      ['2026-03-09T14:28:00', 'Entrada Armazém', 'Vila Exemplo', 'in_transit'],
      ['2026-03-06T20:05:00', 'Em Transferência', 'Amostral', 'in_transit'],
      ['2026-02-27T12:45:00', 'Entrada Armazém', 'Amostral', 'in_transit'],
      ['2026-02-24T21:09:00', 'Aceite', undefined, 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The proof of delivery names who received the parcel; neither it, the warehouse's contact
    // details nor the sender's reference are kept.
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC RECEIVER|Recebido|example\.pt|200 000 000|EXE01|#0001|Consultar/);
  });

  it('keeps the expected day while the parcel is still to come', () => {
    expect(parseLogisimple(planned(), PARCEL)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Em Rota', last_update_local: '2026-03-13T16:42:00', expected_delivery: '2026-03-16' });
    // An estimate before the newest scan, or one the page words otherwise, is none.
    expect(parseLogisimple(planned().replace('2026-03-16 até 12:00', '2026-03-12 até 12:00'), PARCEL)).toMatchObject({ expected_delivery: null });
    expect(parseLogisimple(planned().replace('2026-03-16 até 12:00', 'Sample text'), PARCEL)).toMatchObject({ expected_delivery: null });
    expect(parseLogisimple(planned().replace('Prev. Entrega', 'Sample label'), PARCEL)).toMatchObject({ expected_delivery: null });
  });

  it('gives a state the map does not know the shared wording rules’ stage, for its name and then its explanation', () => {
    const changed = (state: string, detail = 'Sample text.') => parseLogisimple(newest((row) => row
      .replace('>Entregue<', `>${state}<`).replace('Todos os volumes foram entregues com sucesso ao destinatário.', detail)), PARCEL);
    expect(changed('Devolvido')).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language', last_status_text: 'Devolvido' });
    expect(changed('Sample state', 'O pedido foi devolvido ao remetente.')).toMatchObject({ current_stage: 'returned', last_status_text: 'Sample state' });
    // A state nothing reads has no stage, and the newest staged scan decides.
    const odd = changed('Sample state');
    expect(odd).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Sample state' });
    expect(odd.events![0]).not.toHaveProperty('stage');
    expect(logisimpleStage('Sample state', '')).toBeNull();
    // A scan without its state's name is shown by its explanation.
    expect(changed('', 'O pedido foi devolvido ao remetente.')).toMatchObject({ last_status_text: 'O pedido foi devolvido ao remetente.', current_stage: 'returned' });
  });

  it('reads the page for a number the portal does not know as not found', async () => {
    expect(() => parseLogisimple(text('not-found.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps only the shipment under the whole number asked, and has no history for one without scans', () => {
    // A notice or a card for another number leaves the answer open.
    expect(() => parseLogisimple(text('not-found.html'), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Logisimple answered for another shipment' }));
    expect(() => parseLogisimple(text('delivered.html').replace(`TRK#${PARCEL}`, `TRK#${UNKNOWN}`), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Logisimple answered for another shipment' }));
    expect(() => parseLogisimple(text('delivered.html').replace(`TRK#${PARCEL}`, `TRK#${PARCEL}1`), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A search for several numbers shows a card for each; the one asked is read.
    const page = text('delivered.html');
    const card = page.slice(page.indexOf('<div class="card card-tracking m-b-15"'), page.lastIndexOf('</div>', page.indexOf('</body>')));
    const other = card.replace(`TRK#${PARCEL}`, `TRK#${UNKNOWN}`).replace('>Entregue<', '>Aceite<');
    expect(parseLogisimple(text('delivered.html').replace(card, `${other}${card}`), PARCEL)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseLogisimple(text('delivered.html').replace(card, `${card}${card}`), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Logisimple answered for several shipments' }));
    const empty = text('delivered.html').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(() => parseLogisimple(empty, PARCEL)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const tableless = text('delivered.html').replace(/<table class="table table-history">[\s\S]*<\/table>/, '');
    expect(() => parseLogisimple(tableless, PARCEL)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a scan the page repeats once', () => {
    const repeated = newest((row) => `${row}${row}`);
    expect(parseLogisimple(repeated, PARCEL).events).toHaveLength(9);
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('data-tracking="100017"', ''),
      delivered.replace(/<th class="w-60px">Hora/, '<th class="w-60px">Sample'),
      delivered.replace('<th>Observações</th>', '<th>Data</th>'),
      newest((row) => row.replace('2026-03-16', '16-03-2026')),
      newest((row) => row.replace('2026-03-16', '2026-02-30')),
      newest((row) => row.replace('2026-03-16', '1999-03-16')),
      newest((row) => row.replace('11:19', '11h19')),
      newest((row) => row.replace('11:19', '24:00')),
      newest((row) => row.replace('11:19', '')),
      newest((row) => row.replace('>Entregue<', '><').replace('Todos os volumes foram entregues com sucesso ao destinatário.', '')),
      newest((row) => row.replace(/<td class="fs-13">[\s\S]*$/, '</tr>')),
      newest((row) => row.repeat(301)),
      delivered.replace('<table class="table table-history">', '<table class="table table-history"></table><table class="table table-history">'),
    ].entries()) {
      expect(() => parseLogisimple(body, PARCEL), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a firewall page, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: PARCEL });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://portal.logisimple.pt/pt' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html(' '))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
  });

  it('refuses what is no Logisimple number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345', '00000000017', '0000000000017', 'A00000000017', '000000000017,000000000025', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLogisimpleNumber(' 0000-0000-0017 ')).toBe(PARCEL);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('has no recognition: no rule offers Logisimple for a number', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Logisimple to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: PARCEL, carrier: 'logisimple' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'logisimple', source: 'logisimple', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === PAGE)).toBe(true);
  });
});

describe('Logisimple status vocabulary', () => {
  it('records every state the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'logisimple', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(logisimpleMappedStage(entry.wording), entry.wording).toBe(entry.stage);
    }
  });
});
