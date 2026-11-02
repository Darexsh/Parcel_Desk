import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GO_EXPRESS_ENDPOINT, goExpressRequestBody, GoExpressTracker } from './adapter.js';
import { parseGoExpress } from './parser.js';
import { goExpressScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900940000011';
const TRANSIT = '900950000022';
const ABSENT = '999999999999';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseGoExpress>) =>
  result.events!.map(event => [event.local_time, event.description, event.location, event.stage, event.stage_source]);
/** The waybill a request asked for, from its base64 JSON search. */
const asked = (init?: RequestInit) => (JSON.parse(atob(new URLSearchParams(String(init?.body)).get('q')!)) as { q: string }).q;
// The notice for an absent waybill, linking to the one a request asked for.
const absent = (init?: RequestInit) => reply(page('not-found').replace(ABSENT, asked(init)));

describe('GO! Express tracking adapter', () => {
  it('posts the page’s search for the whole waybill once through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GoExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${TRANSIT.slice(0, 6)} ${TRANSIT.slice(6)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.general-overnight.com/api/v2/tracking');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
    expect(JSON.parse(atob(new URLSearchParams(String(init!.body)).get('q')!))).toEqual({ q: TRANSIT, country: 'deu', language: 'en' });
    expect(init!.body).toBe(goExpressRequestBody(TRANSIT));
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'go-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first as wall clocks, once per scan', () => {
    const result = parseGoExpress(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'delivery consignee', last_update: null, last_update_local: '2026-03-04T12:07:00', expected_delivery: null });
    // The delivery the page lists twice appears once; noon is pm and midnight am.
    expect(rows(result)).toEqual([
      ['2026-03-04T12:07:00', 'delivery consignee', 'Exampletown', 'delivered', 'carrier_map'],
      ['2026-03-04T07:41:00', 'loading delivery trip', 'Exampletown', 'out_for_delivery', 'carrier_map'],
      ['2026-03-04T03:12:00', 'unloading hub line', 'Exampletown', 'in_transit', 'carrier_map'],
      ['2026-03-04T00:38:00', 'loading hub line', 'HUB Sampleford', 'in_transit', 'carrier_map'],
      ['2026-03-03T23:56:00', 'unloading hub line', 'HUB Sampleford', 'in_transit', 'carrier_map'],
      ['2026-03-03T18:19:00', 'loading hub line', undefined, 'in_transit', 'carrier_map'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
  });

  it('reads a shipment in transit without its station’s contact details or the postcode form', () => {
    const result = parseGoExpress(page('transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-09-09T01:47:00' });
    expect(rows(result)).toEqual([
      ['2026-09-09T01:47:00', 'unloading hub line', 'HUB Sampleford', 'in_transit', 'carrier_map'],
      ['2026-09-08T19:03:00', 'loading hub line', 'Westbury', 'in_transit', 'carrier_map'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Exampletown|0000|example\.invalid|postcode|CO₂/);
    // Rows the page lists out of order are sorted by clock.
    const swapped = page('transit').replaceAll('Sep 9, 2026', 'Sep 7, 2026');
    expect(parseGoExpress(swapped, TRANSIT).events!.map(event => event.local_time)).toEqual(['2026-09-08T19:03:00', '2026-09-07T01:47:00']);
  });

  it('stages new wording through the shared rules, an unknown error row as an exception, and keeps the rest visible', () => {
    const shared = parseGoExpress(page('transit').replace('>unloading hub line<', '>delivered to neighbour<'), TRANSIT);
    expect(shared).toMatchObject({ current_stage: 'delivered' });
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
    const flagged = parseGoExpress(page('transit').replace('>unloading hub line<', '>gate closed<')
      .replace('tracking-status--progress tooltip-ally', 'tracking-status--error tooltip-ally'), TRANSIT);
    expect(flagged).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', last_status_text: 'gate closed' });
    const unknown = parseGoExpress(page('transit').replace('>unloading hub line<', '>gate closed<'), TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'gate closed' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-09-09T01:47:00', description: 'gate closed', location: 'HUB Sampleford' });
    // German wording, the network's own, is mapped too.
    const german = parseGoExpress(page('transit').replace('>unloading hub line<', '>Abholung war nicht möglich.<'), TRANSIT);
    expect(german).toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map' });
  });

  it('binds the reply to the requested waybill and rejects replies it cannot read', () => {
    expect(() => parseGoExpress(page('transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const otherWaybill = page('transit').replace(`Waybill-No.: ${TRANSIT}`, `Waybill-No.: ${DELIVERED}`);
    expect(() => parseGoExpress(otherWaybill, TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema', message: expect.stringContaining('different') }));
    for (const html of ['', '<html><body>Maintenance</body></html>',
      page('transit').replace(/ data-link="[^"]*"/, ''),
      page('transit').replace(`reference=${TRANSIT}`, `reference=${TRANSIT}&amp;reference=${DELIVERED}`),
      page('transit').replace(`Waybill-No.: ${TRANSIT}`, `Tracking: ${TRANSIT}`),
      page('transit').replaceAll('1:47:00 am', '13:47:00 pm'),
      page('transit').replaceAll('1:47:00 am', '0:47:00 am'),
      page('transit').replaceAll('1:47:00 am', '01:47'),
      page('transit').replaceAll('Sep 9, 2026', 'Sep 31, 2026'),
      page('transit').replaceAll('Sep 9, 2026', 'Sepx 9, 2026'),
      page('transit').replaceAll('Sep 9, 2026', '09.09.2026'),
      page('transit').replace('<span class="tracking__history-title fw-bold">unloading hub line</span>', ''),
      page('transit').replace('<div class="tracking">', '<div class="tracking"></div><div class="tracking">'),
      page('transit').replace('</ul>', '</ul><ul class="tracking__history-list"></ul>')]) {
      expect(() => parseGoExpress(html, TRANSIT), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseGoExpress(page('transit').replaceAll('Sep 9, 2026', 'Sept 9, 2026'), TRANSIT).last_update_local).toBe('2026-09-09T01:47:00');
    const item = /<li class="tracking__history-list-item">.*?<\/li>/.exec(page('transit'))![0];
    const many = page('transit').replace('</ul>', `${Array.from({ length: 501 }, () => item).join('')}</ul>`);
    expect(() => parseGoExpress(many, TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A known shipment without a row is no history, not a missing one.
    const empty = page('transit').replace(/<li class="tracking__history-list-item">.*?<\/li>/g, '');
    expect(() => parseGoExpress(empty, TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads only the notice linked to the requested waybill as a missing shipment', () => {
    expect(() => parseGoExpress(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGoExpress(page('not-found'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGoExpress(page('not-found').replace(/ data-link="[^"]*"/, ''), ABSENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of [page('not-found').replace('We have not yet received the shipment', 'Something went wrong with the shipment'),
      page('not-found').replace('<div class="alert alert-warning" role="alert">', '<div class="alert alert-warning"><h2>Notice</h2></div><div class="alert alert-warning" role="alert">')]) {
      expect(() => parseGoExpress(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseGoExpress(page('not-found').replace(/<div class="alert[^>]*>.*?<\/p><\/div>/, ''), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>']) {
      expect(() => parseGoExpress(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes twelve-digit waybills, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['90094000001', '9009400000111', '90094000001X', 'ABC', 'JJD000390007']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => absent(init));
    for (const number of [ABSENT, '000000000000', '9009-4000-0011']) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('recognizes a known shipment and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('delivered'))).mockImplementationOnce(async (_url, init) => absent(init));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T12:07:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[302, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/deu_de/' } })
        : reply(status === 500 ? '<h1>500 Internal Server Error</h1>' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps empty and oversized replies apart from missing shipments', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"trackingItems":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(ABSENT), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('transit')));
    await expect(carrier(flaky).track({ number: TRANSIT })).resolves.toMatchObject({ status: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('transit')));
    await expect(carrier(immediate).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a waybill filed under GO! Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'go-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'go-express', source: 'go-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === GO_EXPRESS_ENDPOINT)).toBe(true);
  });

  it('is not asked about twelve-digit numbers, which no rule gives GO! Express', () => {
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('go-express');
  });
});

describe('GO! Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(goExpressScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(goExpressScanStage('  Loading   HUB line ')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'loading', 'delivery', 'Abholung']) {
      expect(goExpressScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('5', 'delivery consignee')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'go-express', description: 'loading delivery trip' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
