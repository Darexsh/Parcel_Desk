import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HRVATSKA_POSTA_ENDPOINT, HrvatskaPostaTracker } from './adapter.js';
import { parseHrvatskaPosta } from './parser.js';
import { hrvatskaPostaScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const LOCKER = 'LW900000019HR';
const RETURNED = 'RR900000022HR';
const ABROAD = 'RR900000036HR';
const ABSENT = 'RR999999995HR';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseHrvatskaPosta>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.description, event.location, event.stage]);
// A desktop row of the page, found by its wording, for edited copies.
const rowOf = (wording: string) => new RegExp(String.raw`\s*<div class="d-none d-md-flex row[^"]*">(?:(?!<div class="d-none d-md-flex row)[\s\S])*?>${wording}</span>(?:\s*<span[^>]*>[^<]*</span>)?\s*</div>\s*</div>`);
const without = (html: string, wording: string) => html.replace(rowOf(wording), '');

describe('Hrvatska pošta tracking adapter', () => {
  it('asks the English tracking page once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('locker')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HrvatskaPostaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' lw 900 000 019 hr ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://posiljka.posta.hr/en/tracking/trackingdata?barcode=${LOCKER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hrvatska-posta', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel collected from a locker newest first, on Zagreb’s clock where an office scanned it, without the offices’ postcodes', () => {
    const result = parseHrvatskaPosta(page('locker'), LOCKER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item delivered', last_update: '2026-03-05T10:15:45+01:00', expected_delivery: null,
      pickup_point: 'Paketomat Primjer Trgovina', weight_kg: 1.25 });
    // Each scan once, although the page repeats it in a mobile row.
    expect(rows(result)).toEqual([
      ['2026-03-05T10:15:45+01:00', 'Item delivered', 'Paketomat Primjer Trgovina', 'delivered'],
      ['2026-03-04T13:21:50+01:00', 'The shipment has been handed over to the parcelstation', 'Paketomat Primjer Trgovina', 'ready_for_pickup'],
      ['2026-03-03T17:01:52', 'Delivery was redirected to the parcelstation', undefined, 'in_transit'],
      ['2026-03-03T16:28:12+01:00', 'Item received', 'PRIMJERGRAD', 'accepted'],
      ['2026-03-03T04:39:49', 'Item announced', undefined, 'registered'],
    ]);
    // A scan without an office keeps its wall clock.
    expect(result.events!.filter(event => !event.location).every(event => event.time === undefined && event.local_time)).toBe(true);
    expect(result.last_update_local).toBeUndefined();
    for (const name of ['locker', 'returned', 'abroad']) {
      const number = { locker: LOCKER, returned: RETURNED, abroad: ABROAD }[name]!;
      expect(JSON.stringify(parseHrvatskaPosta(page(name), number)), name).not.toMatch(/\b99\d{3}\b|69999/);
    }
  });

  it('names the locker a parcel waits in, and no point for a parcel brought to the door', () => {
    const waiting = parseHrvatskaPosta(without(page('locker'), 'Item delivered'), LOCKER);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Paketomat Primjer Trgovina',
      last_update: '2026-03-04T13:21:50+01:00' });
    const door = parseHrvatskaPosta(page('locker').replace(/>The shipment has been handed over to the parcelstation</g, '>Item is out for delivery<'), LOCKER);
    expect(door).toMatchObject({ current_stage: 'delivered' });
    expect(door.pickup_point).toBeUndefined();
  });

  it('orders scans grouped by milestone by their clocks and reads a return as such, not as a delivery or a pickup', () => {
    const result = parseHrvatskaPosta(page('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Item delivered to sender', weight_kg: 0.009 });
    expect(result.pickup_point).toBeUndefined();
    // The repeated office scan appears once.
    expect(rows(result)).toEqual([
      ['2026-03-18T06:49:48+01:00', 'Item delivered to sender', 'PRIMJERGRAD', 'returned'],
      ['2026-03-18T06:49:13+01:00', 'Item can be picked up at the Post Office', 'PRIMJERGRAD', 'ready_for_pickup'],
      ['2026-03-17T07:31:20+01:00', 'Item returned to sender', 'PRIMJERGRAD-ISTOK', 'returned'],
      ['2026-03-17T07:31:19+01:00', 'Item not delivered', 'PRIMJERGRAD-ISTOK', 'failed_attempt'],
      ['2026-03-10T07:34:28+01:00', 'Item can be picked up at the Post Office', 'PRIMJERGRAD-ISTOK', 'ready_for_pickup'],
      ['2026-03-09T09:40:22+01:00', 'Delivery attempt', 'PRIMJERGRAD', 'failed_attempt'],
      ['2026-03-09T07:53:52+01:00', 'Item is out for delivery', 'PRIMJERGRAD', 'out_for_delivery'],
      ['2026-03-06T13:12:49+01:00', 'Item received', 'PRIMJERGRAD', 'accepted'],
      ['2026-03-06T12:20:28', 'Item announced', undefined, 'registered'],
      ['2026-03-06T12:16:03+01:00', 'Item announced', 'PRIMJERGRAD', 'registered'],
    ]);
    // A delivery once the item is on its way back reaches its sender.
    const plain = parseHrvatskaPosta(page('returned').replace('>Item delivered to sender<', '>Item delivered<'), RETURNED);
    expect(plain).toMatchObject({ current_stage: 'returned', last_status_text: 'Item delivered' });
    expect(plain.pickup_point).toBeUndefined();
    const waiting = parseHrvatskaPosta(without(without(without(page('returned'), 'Item delivered to sender'),
      'Item can be picked up at the Post Office'), 'Item returned to sender'), RETURNED);
    expect(waiting).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Item not delivered' });
  });

  it('keeps a foreign facility as the page names it, on its own clock, and reads its acceptance as transit', () => {
    const result = parseHrvatskaPosta(page('abroad'), ABROAD);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-03-09T12:13:00', weight_kg: 0.012 });
    expect(rows(result)).toEqual([
      ['2026-03-09T12:13:00', 'Item delivered', undefined, 'delivered'],
      ['2026-03-05T00:39:00', 'Item received in destination country', 'ZZXMPA EXAMPLEVILLE AP', 'in_transit'],
      ['2026-03-05T00:34:00', 'Item received', 'ZZXMPA EXAMPLEVILLE AP', 'in_transit'],
      ['2026-03-03T02:12:21+01:00', 'Item sent', 'PRIMJERGRAD', 'in_transit'],
      ['2026-03-02T22:43:45+01:00', 'Item received at exchange office', 'PRIMJERGRAD', 'in_transit'],
      ['2026-03-01T13:25:35+01:00', 'Item received', 'ČUDNOVO SELO', 'accepted'],
    ]);
  });

  it('dates a foreign facility whose UPU office code names a country with one clock on that clock', () => {
    const abroad = (office: string, day = '05.03.2026') => rows(parseHrvatskaPosta(page('abroad')
      .replaceAll('ZZXMPA', office).replaceAll('05.03.2026', day), ABROAD)).filter(([, , place]) => String(place).endsWith('EXAMPLEVILLE AP'));
    expect(abroad('GBXMPA')).toEqual([
      ['2026-03-05T00:39:00+00:00', 'Item received in destination country', 'GBXMPA EXAMPLEVILLE AP', 'in_transit'],
      ['2026-03-05T00:34:00+00:00', 'Item received', 'GBXMPA EXAMPLEVILLE AP', 'in_transit'],
    ]);
    expect(abroad('DEXMPA', '05.07.2026').map(([time]) => time)).toEqual(['2026-07-05T00:39:00+02:00', '2026-07-05T00:34:00+02:00']);
    // A country with several clocks, islands on clocks of their own, and a name with no code keep the wall clock.
    for (const office of ['USXMPA', 'ESXMPA', 'PTXMPA', 'EXAMPLE']) {
      expect(abroad(office).map(([time]) => time), office).toEqual(['2026-03-05T00:39:00', '2026-03-05T00:34:00']);
    }
  });

  it('keeps a home scan the autumn change of clocks makes ambiguous as a local time', () => {
    const result = parseHrvatskaPosta(page('locker').replaceAll('05.03.2026', '25.10.2026').replaceAll('10:15:45', '02:30:00'), LOCKER);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-10-25T02:30:00' });
    expect(result.events![0]).toMatchObject({ local_time: '2026-10-25T02:30:00', description: 'Item delivered' });
    expect(result.events![0]!.time).toBeUndefined();
  });

  it('stages the destination\'s relayed customs scans by the map', () => {
    for (const [wording, stage] of [['Item sent to Customs', 'customs'], ['Item returned from Customs', 'in_transit']] as const) {
      const result = parseHrvatskaPosta(page('locker').replace('>Item delivered<', `>${wording}<`), LOCKER);
      expect(result, wording).toMatchObject({ current_stage: stage, current_stage_source: 'carrier_map' });
    }
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const shared = parseHrvatskaPosta(page('locker').replace('>Item delivered<', '>Item held by customs<'), LOCKER);
    expect(shared).toMatchObject({ current_stage: 'customs' });
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
    const unknown = parseHrvatskaPosta(page('locker').replace('>Item delivered<', '>Item weighed<'), LOCKER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Item weighed' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-03-05T10:15:45+01:00', description: 'Item weighed', location: 'Paketomat Primjer Trgovina' });
    // An item without a measured weight shows 0 g.
    expect(parseHrvatskaPosta(page('locker').replace('>1250 g<', '>0 g<'), LOCKER).weight_kg).toBeUndefined();
  });

  it('binds the page to the whole requested number and rejects pages it cannot read', () => {
    expect(() => parseHrvatskaPosta(page('locker'), RETURNED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHrvatskaPosta(page('not-found'), LOCKER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['', '<html><body>Održavanje</body></html>',
      page('locker').replace(`>${LOCKER}<`, `>${LOCKER} ${RETURNED}<`),
      // The Croatian page: its wording and notices are not the ones the adapter reads.
      page('locker').replace('Item number', 'Broj pošiljke'),
      page('locker').replace('<div class="track__n__trace">', '<div class="track__n__trace"></div><div class="track__n__trace">'),
      page('locker').replace('10:15:45', '25:61:00'),
      page('locker').replace('05.03.2026\n', '2026-03-05\n'),
      page('locker').replace('05.03.2026\n', '31.02.2026\n'),
      page('locker').replace('>Item delivered<', '><'),
      page('locker').replace(/<span class="mr-5 mb-2 Text-Style-20-md-6">/, '<p>')]) {
      expect(() => parseHrvatskaPosta(html, LOCKER), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('locker').replace(rowOf('Item delivered'), (row: string) => row.repeat(501));
    expect(() => parseHrvatskaPosta(many, LOCKER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the tracker’s no-data notice as a missing item', () => {
    expect(() => parseHrvatskaPosta(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHrvatskaPosta(page('invalid').replace('XYZ12', ABSENT), ABSENT)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    for (const html of [page('not-found').replace('Invalid barcode format', 'Service temporarily unavailable'),
      page('not-found').replace(/<h4[\s\S]*?<\/h4>/, ''), page('error')]) {
      expect(() => parseHrvatskaPosta(html, ABSENT), html.slice(-400)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const html of ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>']) {
      expect(() => parseHrvatskaPosta(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes the barcodes the tracking form accepts, with valid S10 and SSCC check digits, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['RR900000020HR', '00340000000000000001', '3S', 'BAT', 'J123', '99000000001', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(page('not-found').replace(ABSENT, new URL(String(url)).searchParams.get('barcode')!)));
    for (const number of [ABROAD, 'RR000000014DE', '3SABC123', '990000000001', '00340000000000000007', 'JJHR00000000000000001',
      'BAT123456']) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('recognizes a known parcel and the no-data notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('locker'))).mockResolvedValueOnce(reply(page('not-found')));
    await expect(carrier(fetcher).recognize!(LOCKER)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T09:15:45.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[302, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps the error page, empty pages and oversized replies apart from missing items', async () => {
    for (const [body, kind] of [[page('error'), 'indeterminate'], ['', 'indeterminate'], ['  ', 'indeterminate'],
      ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(ABSENT), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: LOCKER })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('locker')));
    await expect(carrier(flaky).track({ number: LOCKER })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('locker')));
    await expect(carrier(immediate).track({ number: LOCKER }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: LOCKER }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: LOCKER }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under Hrvatska pošta to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('locker')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: LOCKER, carrier: 'hrvatska-posta' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'hrvatska-posta', source: 'hrvatska-posta', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${HRVATSKA_POSTA_ENDPOINT}?`))).toBe(true);
  });

  it('is named for the items it issues and asked about the other Croatian S10 codes', () => {
    expect(detectCarrierMatch(LOCKER)).toMatchObject({ carrier: 'hrvatska-posta', confidence: 'high' });
    // A letter-post code stays with the postal fallback.
    expect(detectCarrierMatch('UA900000019HR')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers('UA900000019HR')[0]).toBe('hrvatska-posta');
    expect(recognitionAskedCarriers('RR900000020HR')).not.toContain('hrvatska-posta');
    expect(recognitionAskedCarriers('RR000000014DE')).not.toContain('hrvatska-posta');
  });
});

describe('Hrvatska pošta status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(hrvatskaPostaScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(hrvatskaPostaScanStage('  Item   delivered ')).toBe('delivered');
    for (const wording of ['constructor', 'toString', 'Item', 'Item delivered to', 'Isporuka u poštanskom uredu']) {
      expect(hrvatskaPostaScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'item delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'hrvatska-posta', description: 'Item can be picked up at the Post Office' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
