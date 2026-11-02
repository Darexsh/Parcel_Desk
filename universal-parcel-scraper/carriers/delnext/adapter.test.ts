import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DELNEXT_TRACKER, delnextLookupUrl, DelnextTracker } from './adapter.js';
import { normalizeDelnextNumber, parseDelnext } from './parser.js';
import { delnextScanStage, delnextStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'DNX4T7';
const IN_TRANSIT = 'TR8K2Q7';
const RETURNED = 'RT6W3N';
const PARTNER = 'PX3M9W';
const CANCELLED = 'CX7N2P';
const UNKNOWN = 'NF5K8R';
const DPD_DE_NUMBER = '09981234567890';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = page('delivered');
const partner = page('partner');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => { const $ = load(body); change($); return $.html(); };
type Row = readonly [day: string, time: string, place: string, line: string];
// Rows newest first, as the page lists them.
const history = (...rows: Row[]) => edit($ => $('.details-information .d-flex.flex-column').html(rows.map(([day, time, place, line]) =>
  `<div class="feed-item mb-5"><div class="feed-item-left d-flex flex-column"><p class="text-dark mb-1 mt-0">${day}</p>`
  + `<p class="small text-muted mb-1 mt-0">${time}</p><p class="small text-dark font-weight-bold mb-1 mt-0">${place}</p></div>`
  + `<div class="feed-item-right"><p class="text-dark mb-1 mt-0">${line}</p></div></div>`).join('')));
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const SENT = 'Encomenda enviada: verifique a estimativa de entrega acima. Será notificado quando a encomenda entrar em distribuição';
const RETURN_SOON = 'Encomenda não pôde ser entregue e será devolvida em breve. Se ainda a quiser receber entre em contacto com o nosso Apoio ao Cliente: info@delnext.com';
const withPartner = (name: string, number: string, notice = name) => partner.replace('entregue por:DPD DE', `entregue por:${name}`)
  .replace(/<strong>\s*DPD DE\s*<\/strong>/, `<strong>${notice}</strong>`).replace(DPD_DE_NUMBER, number);

describe('Delnext tracking adapter', () => {
  it('asks the tracker for the code once, at the address its form ends on, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(delivered));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DelnextTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' dnx 4t7 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DELNEXT_TRACKER}?tracking_code=${DELIVERED}&reloaded=PT`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads a delivered history as wall clocks, newest first, with each scan’s own line and without the recipient', () => {
    const result = normalizeCarrierResult(parseDelnext(delivered, DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregue', last_update: null, last_update_local: '2026-01-09T15:42:00', expected_delivery: null });
    expect(result.events?.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-01-09T15:42:00', 'Vila Exemplo', 'Entregue', 'delivered'],
      ['2026-01-09T09:05:00', 'Vila Exemplo', 'Encomenda em distribuição. Esperamos fazer a entrega durante o dia de hoje', 'out_for_delivery'],
      // Without the notice after the new day, and without the system's note under the failed attempt.
      ['2026-01-08T22:10:00', undefined, 'Nova data de entrega: 2026-01-09', 'in_transit'],
      ['2026-01-08T22:04:00', undefined, "Não foi possível entregar a sua encomenda hoje, ao contrário do previsto. Por favor ajude-nos a proceder à entrega clicando no botão 'Resolver'", 'failed_attempt'],
      // The page lists this round twice.
      ['2026-01-08T09:12:00', 'Vila Exemplo', 'Encomenda em distribuição. Esperamos fazer a entrega durante o dia de hoje', 'out_for_delivery'],
      ['2026-01-07T06:40:00', 'Armazém Norte', 'Encomenda lida em armazém', 'in_transit'],
      ['2026-01-06T18:20:00', 'Lisboa', SENT, 'in_transit'],
      ['2026-01-06T10:02:00', 'Cidade Origem', 'Envio registado no sistema Delnext', 'registered'],
    ]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map' && !event.time)).toBe(true);
    const json = JSON.stringify(result);
    for (const dropped of ['Maria Exemplo', 'Aldeia Destino', 'Proof of Delivery', 'Incidência', 'atualizada', 'image_proxy']) {
      expect(json, dropped).not.toContain(dropped);
    }
  });

  it('reads a parcel on its way with the estimate, while the estimate is not behind the scans', () => {
    const body = page('in-transit');
    expect(parseDelnext(body, IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Encomenda lida em armazém', last_update_local: '2026-01-12T07:15:00', expected_delivery: '2026-01-14' });
    expect(parseDelnext(body, IN_TRANSIT).events?.map(event => event.location)).toEqual(['Armazém Sul', 'MÁLAGA', 'Cidade Origem']);
    for (const estimate of ['11/01/2026', 'Unavailable', '31/02/2026', '14/01/2026 e 16/01/2026']) {
      expect(parseDelnext(body.replace('Entrega prevista entre: 14/01/2026', `Entrega prevista entre: ${estimate}`), IN_TRANSIT), estimate)
        .toMatchObject({ expected_delivery: null });
    }
  });

  it('settles a minute holding a return and a warehouse scan as returned, and ignores a partner the header does not name', () => {
    const result = parseDelnext(page('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Encomenda devolvida ao remetente',
      last_update_local: '2026-01-20T16:05:00', expected_delivery: null });
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'returned', 'exception', 'out_for_delivery', 'in_transit', 'registered']);
    expect(result.events?.[2]?.description).toBe(`${RETURN_SOON} (Absent)`);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
    // A newer scan after the return still decides.
    const after = history(['21/01/2026', '08:00', 'Lisboa', SENT], ['20/01/2026', '16:05', '', 'Encomenda devolvida ao remetente']);
    expect(parseDelnext(after, DELIVERED)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads a parcel a partner delivers as in transit, handing the partner and its number off', () => {
    const result = normalizeCarrierResult(parseDelnext(partner, PARTNER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'A sua encomenda será entregue por: DPD DE', summary_only: true, events: [],
      delivery_carrier: 'dpd-de', delivery_tracking_number: DPD_DE_NUMBER });
    expect(deliveryHandoff('delnext', PARTNER, result)).toEqual({ carrier: 'dpd-de', number: DPD_DE_NUMBER, basis: 'partner' });
    expect(JSON.stringify(result)).not.toContain('Beispielstadt');
    // A notice naming another partner, a number not of the partner's shape or the
    // code itself, and a partner outside the catalog keep only the wording.
    for (const [name, number, notice] of [['DPD DE', DPD_DE_NUMBER, 'MRW'], ['DPD DE', '250012345678901234', 'DPD DE'],
      ['DPD FR', '250012345678901234', 'DPD FR'], ['DPD DE', PARTNER, 'DPD DE'], ['DPD DE', 't', 'DPD DE'], ['DPD DE', '', ''],
      ['GLS PT NEW', '1234567', 'GLS PT NEW']] as const) {
      const other = parseDelnext(withPartner(name, number, notice), PARTNER);
      expect(other, `${name} ${number} ${notice}`).toMatchObject({ current_stage: 'in_transit', last_status_text: `A sua encomenda será entregue por: ${name}` });
      expect(other.delivery_carrier, `${name} ${number} ${notice}`).toBeUndefined();
      expect(other.delivery_tracking_number, `${name} ${number} ${notice}`).toBeUndefined();
    }
    expect(parseDelnext(withPartner('MRW', '123456789012'), PARTNER)).toMatchObject({ delivery_carrier: 'mrw', delivery_tracking_number: '123456789012' });
  });

  it('reads a cancelled parcel’s line without a day as its state', () => {
    expect(parseDelnext(page('cancelled'), CANCELLED)).toEqual({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'A Delnext recebeu corretamente os dados da sua encomenda mas o remetente cancelou o envio', last_update: null,
      expected_delivery: null, summary_only: true, events: [] });
  });

  it('reads the empty search page for the code asked as not found, and a page without scans as no history', async () => {
    expect(() => parseDelnext(page('not-found'), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const noScans = edit($ => $('.tracking-details-box-content').last().remove(), partner);
    expect(() => parseDelnext(noScans, PARTNER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('binds the page to the whole code asked', () => {
    for (const other of [IN_TRANSIT, `${DELIVERED}Z`, DELIVERED.slice(1), '']) {
      const body = edit($ => $('span.tracking-details').first().text(other));
      expect(() => parseDelnext(body, DELIVERED), other).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
      const notice = page('not-found').replace(`tracking_code = "${UNKNOWN}"`, `tracking_code = "${other}"`);
      expect(() => parseDelnext(notice, UNKNOWN), other).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseDelnext(page('not-found').replace(`"${UNKNOWN}"`, `"${UNKNOWN.toLowerCase()}"`), UNKNOWN))
      .toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDelnext(page('not-found').replace(/tracking_code = "\w+";/, ''), UNKNOWN))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a bot check, whatever its status, as a challenge, and the site’s own outage pages as maintenance', async () => {
    expect(() => parseDelnext(CHECK, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const status of [200, 403]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK, status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    }
    for (const body of ['<html><body><p>There seems to be a problem connecting to our database. Please give us a few minutes to remedy the problem.</p></body></html>',
      '<html><head><title>Resource Limit Is Reached</title></head><body></body></html>']) {
      expect(() => parseDelnext(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'maintenance' }));
    }
  });

  it('rejects changed pages and bounds the history', () => {
    const stub = `<script> window.location.replace('${delnextLookupUrl(DELIVERED)}') </script>`;
    for (const body of [
      stub, '', '<html><body><p>Página em manutenção</p></body></html>',
      edit($ => $('section.track-info').remove()), edit($ => $('section.track-info').clone().appendTo('body')),
      edit($ => $('.tracking-title').first().text('Código:')), edit($ => $('.details-information h3').remove()),
      edit($ => $('.details-information h3').clone().appendTo('body')), edit($ => $('.feed-item-left').first().children('p').last().remove()),
      edit($ => $('.feed-item-right').first().remove()),
      history(['31/02/2026', '10:00', '', 'Entregue']), history(['2026-01-09', '10:00', '', 'Entregue']),
      history(['09/01/2026', '24:00', '', 'Entregue']), history(['09/01/2026 10:01', '10:00', '', 'Entregue']),
      history(['-', '10:00', '', 'Entregue']), history(['09/01/2026', '10:00', '', '']),
      history(...Array.from({ length: 501 }, (_, index) => ['09/01/2026', `1${index % 10}:${String(index % 60).padStart(2, '0')}`, '', 'Encomenda lida em armazém'] as const)),
    ]) {
      expect(() => parseDelnext(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: expect.stringMatching(/^(?:schema|indeterminate)$/) }));
    }
    const long = history(...Array.from({ length: 150 }, (_, index) => [`${String(28 - Math.floor(index / 60)).padStart(2, '0')}/02/2026`,
      `${String(23 - Math.floor((index % 60) / 10)).padStart(2, '0')}:${String(59 - (index % 10)).padStart(2, '0')}`, 'Lisboa', 'Encomenda lida em armazém'] as const));
    const result = parseDelnext(long, DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-02-28T23:59:00' });
  });

  it('stages unknown lines by the shared rules, else leaves them without a stage', () => {
    const result = parseDelnext(history(['10/01/2026', '12:00', '', 'Encomenda extraviada'], ['10/01/2026', '11:00', '', 'Linha de exemplo']), DELIVERED);
    expect(result.events?.[0]).toMatchObject({ stage: 'exception', stage_source: expect.stringMatching(/^wording:/) });
    expect(result.events?.[1]?.stage).toBeUndefined();
    expect(parseDelnext(history(['10/01/2026', '11:00', '', 'Linha de exemplo']), DELIVERED)).toMatchObject({ status: 'unknown',
      last_status_text: 'Linha de exemplo', last_update_local: '2026-01-10T11:00:00' });
    expect(parseDelnext(history(['-', '-', '-', 'Linha de exemplo'], ['10/01/2026', '11:00', '', SENT]), DELIVERED))
      .toMatchObject({ current_stage: 'in_transit', last_status_text: SENT });
  });

  it('takes six- or seven-character codes of letters and digits, and nothing else, without a request', async () => {
    expect(normalizeDelnextNumber(' tr8-k2q7 ')).toBe(IN_TRANSIT);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DNX4T', 'DNX4T7AB', 'DNX4T_', 'DNX4T7🙂', '', '0'.repeat(80), `${DELIVERED}${' '.repeat(70)}`]) {
      expect(() => normalizeDelnextNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known parcel and an unknown code from plain HTTP', async () => {
    const noScans = edit($ => $('.tracking-details-box-content').last().remove(), partner);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(delivered)).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(partner)).mockResolvedValueOnce(reply(noScans));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-09T15:42:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(PARTNER)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!(PARTNER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too many requests',
      { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [302, 'transport'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [508, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('not-found'), status));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(delivered));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(delivered));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // The first try's timeout and the budget's end come close together; either is a correct answer.
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(2_200_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a parcel filed under Delnext to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(delivered));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'delnext' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'delnext', source: 'delnext', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === delnextLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Delnext status vocabulary', () => {
  it('maps every line it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(delnextScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'delnext', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(delnextScanStage('Nova data de entrega: 2026-01-02')).toBe('in_transit');
    expect(delnextScanStage(`${RETURN_SOON} (Acidente ou avaria de viatura)`)).toBe('exception');
    expect(delnextScanStage('  ENTREGUE. ')).toBe('delivered');
    expect(delnextScanStage('Nova data de entregaX')).toBeUndefined();
    expect(statusMap.stage('X1', 'entregue')).toBeUndefined();
    expect(delnextStage('Linha de exemplo')).toBeNull();
    for (const wording of ['constructor', 'toString', '']) expect(delnextScanStage(wording), wording).toBeUndefined();
  });
});
