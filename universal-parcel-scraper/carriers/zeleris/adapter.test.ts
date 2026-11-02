import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ZELERIS_ENDPOINT, ZelerisTracker } from './adapter.js';
import { parseZeleris, parseZelerisRedirect } from './parser.js';
import { statusMap, zelerisRailStage, zelerisScanStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The label's code; the page prints the same shipment with the next day's admission date.
const DELIVERED = '2472CA19900000123Q';
const PRINTED = '2472F129900000123Q';
const UNDELIVERED = '221503F9900000456K';
const DEPOT = '262BC4B9900000789B';
const ABSENT = '26BE362D999999999Z';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const moved = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });
const searchPage = (number: string, flag = 'not_found=1') => `https://www.zeleris.com/seguimiento-de-envios/?tracking_number=${number}&${flag}`;
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseZeleris>) => result.events!.map(event => [event.local_time, event.description, event.stage]);
// The visible rail's current step comes before the copy the page leaves in a comment.
const withStep = (html: string, from: string, to: string) => html.replace(`<span>${from}</span>`, `<span>${to}</span>`);

describe('Zeleris tracking adapter', () => {
  it('asks the shipment page once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ZelerisTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2472ca19 900000123q ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.zeleris.com/detalle-de-envio/?tracking_number=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zeleris', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment newest first, as wall clocks, under the code the page prints', () => {
    const result = parseZeleris(page('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Tu envío ha sido entregado.', last_update: null, last_update_local: '2026-06-03T13:27:00',
      expected_delivery: null, canonical_tracking_number: PRINTED,
      events: [
        { local_time: '2026-06-03T13:27:00', description: 'Tu envío ha sido entregado.', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-06-03T08:12:00', description: 'Tu envío está en reparto.', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-05-31T20:41:00', description: 'Tu envío ya esta preparado. Te avisaremos cuando este en camino.',
          stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The printed code itself is the same shipment.
    expect(parseZeleris(page('delivered'), PRINTED).canonical_tracking_number).toBeUndefined();
  });

  it('keeps every delivery round, once each, and takes the rail’s final non-delivery over the last attempt', () => {
    const result = parseZeleris(page('undelivered'), UNDELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'no entrega definitiva', last_update_local: '2026-04-24T18:52:00' });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-04-24T18:52:00', 'Te hemos enviado un SMS al número de teléfono registrado en el pedido.', undefined],
      ['2026-04-24T10:00:00', 'No hemos podido entregarte el envío.', 'failed_attempt'],
      ['2026-04-24T07:44:00', 'Tu envío está en reparto.', 'out_for_delivery'],
      ['2026-04-23T18:49:00', 'Te hemos enviado un SMS al número de teléfono registrado en el pedido.', undefined],
      ['2026-04-23T10:00:00', 'Tu envío está pendiente para el próximo reparto.', 'in_transit'],
      ['2026-04-23T07:41:00', 'Tu envío está en reparto.', 'out_for_delivery'],
      ['2026-04-21T17:15:00', 'Tu envío ya esta preparado. Te avisaremos cuando este en camino.', 'accepted'],
    ]);
    // Without the rail's verdict, the text message moves nothing: the attempt before it stands.
    const attempted = parseZeleris(withStep(page('undelivered'), 'no entrega definitiva', 'en reparto'), UNDELIVERED);
    expect(attempted).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Te hemos enviado un SMS al número de teléfono registrado en el pedido.' });
  });

  it('takes whichever of the rail and the newest scan is further along', () => {
    // At the destination depot with only the admission shown.
    expect(parseZeleris(page('depot'), DEPOT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'pendiente en plataforma', last_update_local: '2026-05-08T19:03:00' });
    // A rail still in transit on a delivery round's morning.
    const round = page('delivered').replace(/\s*<div class="zeleris-shipping-tracking-row">(?:(?!<div class="zeleris-shipping-tracking-row">)[\s\S])*?Tu envío ha sido entregado\.[\s\S]*?<\/div> -->\s*<\/div>/, '');
    const behind = parseZeleris(withStep(round, 'entregada 03/06/2026 13:27', 'en transito'), DELIVERED);
    expect(behind).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Tu envío está en reparto.' });
    expect(behind.events).toHaveLength(2);
    // A step the map does not know leaves the scans to decide.
    expect(parseZeleris(withStep(page('depot'), 'pendiente en plataforma', 'en aduana'), DEPOT)).toMatchObject({ current_stage: 'accepted' });
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const shared = parseZeleris(page('depot').replace('Tu envío ya esta preparado. Te avisaremos cuando este en camino.', 'Envío retenido en aduana'), DEPOT);
    expect(shared.events![0]).toMatchObject({ stage: 'customs', stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseZeleris(withStep(page('depot').replace('Tu envío ya esta preparado. Te avisaremos cuando este en camino.', 'Bulto pesado'),
      'pendiente en plataforma', 'en aduana'), DEPOT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Bulto pesado' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events).toEqual([{ local_time: '2026-05-08T19:03:00', description: 'Bulto pesado' }]);
  });

  it('answers with the rail alone when the page lists no scan, and has no history without either', () => {
    const empty = page('depot').replace(/\s*<div class="zeleris-shipping-tracking-row">[\s\S]*?<\/div> -->\s*<\/div>/, '');
    expect(parseZeleris(empty, DEPOT)).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'pendiente en plataforma', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    expect(() => parseZeleris(withStep(empty, 'pendiente en plataforma', 'en aduana'), DEPOT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the page to the requested shipment and rejects pages it cannot read', () => {
    // Another shipment, or the same expedition under another prefix or letter.
    for (const number of [UNDELIVERED, '2572CA19900000123Q', '2472CA19900000123R', '2472CA19900000124Q', '2472CA1A900000123Q']) {
      expect(() => parseZeleris(page('delivered'), number), number).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of [
      page('delivered').replace(`Pedido ${PRINTED}`, `Pedido ${PRINTED} ${UNDELIVERED}`),
      page('delivered').replace(`Pedido ${PRINTED}`, PRINTED),
      page('delivered').replace('<div class="zeleris-shipping-tracking-detail scrollToMe">',
        '<div class="zeleris-shipping-tracking-detail"></div><div class="zeleris-shipping-tracking-detail scrollToMe">'),
      page('delivered').replace('13:27                    </div>', '24:10                    </div>'),
      page('delivered').replace('03/06/2026                    </div>', '2026-06-03                    </div>'),
      page('delivered').replace('03/06/2026                    </div>', '31/02/2026                    </div>'),
      page('delivered').replace('Tu envío ha sido entregado.', ''),
      page('delivered').replace('zeleris-shipping-tracking-col-time', 'zeleris-shipping-tracking-col-hour'),
      '<html><body>Mantenimiento</body></html>']) {
      expect(() => parseZeleris(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('depot').replace(/<div class="zeleris-shipping-tracking-row">[\s\S]*?<\/div> -->\s*<\/div>/, (row: string) => row.repeat(301));
    expect(() => parseZeleris(many, DEPOT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The search page alone, and block pages, are no answer about the shipment.
    const search = page('delivered').replace(/<div class="zeleris-shipping-tracking-detail scrollToMe">[\s\S]*<div class="elementor-shortcode">/, '<div>');
    expect(() => parseZeleris(search, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<html><head><title>Web Page Blocked</title></head><body>Attack ID: 20000001</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>']) {
      expect(() => parseZeleris(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('reads only the search page’s not-found flag for the requested number as a missing shipment', () => {
    expect(() => parseZelerisRedirect(searchPage(ABSENT), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseZelerisRedirect(`/seguimiento-de-envios/?tracking_number=${ABSENT}&not_found=1`, ABSENT))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const location of [searchPage(ABSENT, 'tracking_error=1'), searchPage(DEPOT), searchPage(ABSENT, 'not_found=0'),
      `https://www.zeleris.com/seguimiento-de-envios/?not_found=1`, `https://example.com/seguimiento-de-envios/?tracking_number=${ABSENT}&not_found=1`,
      `https://www.zeleris.com/detalle-de-envio/?tracking_number=${ABSENT}`, 'https://www.zeleris.com/', 'http://[', null]) {
      expect(() => parseZelerisRedirect(location, ABSENT), String(location)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('takes Zeleris codes only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ES2024COM0000457118', '2472CA19900000123', '2472CA199000001234', '2472CG19900000123Q', '203912003934AD', '900000123Q']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the redirect for an unknown number as not found and recognizes a known shipment, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('depot'))).mockResolvedValueOnce(moved(searchPage(ABSENT)))
      .mockResolvedValueOnce(moved(searchPage(ABSENT)));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DEPOT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-08T19:03:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a technical-error redirect, other redirects, empty pages and oversized replies apart from missing shipments', async () => {
    for (const response of [() => moved(searchPage(ABSENT, 'tracking_error=1')), () => moved('https://www.zeleris.com/', 301),
      () => new Response(null, { status: 302 }), () => reply(''), () => reply('  ')]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DEPOT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('depot')));
    await expect(carrier(flaky).track({ number: DEPOT })).resolves.toMatchObject({ status: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('depot')));
    await expect(carrier(immediate).track({ number: DEPOT }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DEPOT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DEPOT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a Zeleris code to the adapter, which detection claims outright', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'zeleris', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)).toEqual([]);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'zeleris', source: 'zeleris', result: { current_stage: 'delivered', canonical_tracking_number: PRINTED } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${ZELERIS_ENDPOINT}?`))).toBe(true);
  });
});

describe('Zeleris status vocabulary', () => {
  it('records every sentence and rail step the maps know with the stage they give', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      const rail = 'note' in entry && Boolean(entry.note?.startsWith('A step of the progress rail'));
      expect(rail ? zelerisRailStage(entry.wording) : zelerisScanStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('es-ES')), entry.wording).toBe(rail ? undefined : stage);
    }
    expect(zelerisScanStage('  Tu envío ESTÁ en  reparto. ')).toBe('out_for_delivery');
    for (const wording of ['constructor', 'toString', 'Tu envío', 'en reparto', 'Tu envío está en reparto']) {
      expect(zelerisScanStage(wording), wording).toBeUndefined();
    }
    expect(zelerisRailStage('Tu envío está en reparto.')).toBeUndefined();
    expect(statusMap.stage('7', 'tu envío está en reparto.')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'zeleris', description: 'No hemos podido entregarte el envío.' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'zeleris', description: 'Te hemos enviado un SMS al número de teléfono registrado en el pedido.' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
