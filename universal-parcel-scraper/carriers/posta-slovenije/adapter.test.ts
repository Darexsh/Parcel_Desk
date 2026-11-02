import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTA_SLOVENIJE_ENDPOINT, PostaSlovenijeTracker } from './adapter.js';
import { parsePostaSlovenije } from './parser.js';
import { postaSlovenijeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'CF900000019SI';
const RETURNED = 'CF900000022SI';
const WAITING = 'CF900000036SI';
const ABROAD = 'RR900000040LT';
const ABSENT = 'ZZ999999995SI';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
const reply = (body: string, status = 200, headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }) =>
  new Response(body, { status, headers });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null,
  userAgent: 'SyntheticHost/1.0' });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

type Row = Record<string, unknown> & { code: string; statusDateTime: string; unitType: number };
type Reply = { result: { parcel: Record<string, unknown>; statuses: Row[] } };
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name) as Reply;
  change(payload);
  return payload;
};
const delivery = (time: string): Row => ({ ...(fixture('delivered') as Reply).result.statuses.at(-1)!, postalId: '9004',
  postalName: 'Poskusno', statusDateTime: time });
const rows = (result: ReturnType<typeof parsePostaSlovenije>) =>
  result.events!.map(event => [event.time, event.provider_code, event.description, event.location, event.stage]);

describe('Pošta Slovenije tracking adapter', () => {
  it('asks the app’s guest lookup once for the whole number, as the app, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostaSlovenijeTracker({ fetcher, recorder }).fetch(' cf 900 000 019 si ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://moja.posta.si/api/v1/parcels/track/?TrackingNumber=${DELIVERED}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal) });
    const headers = new Headers(init!.headers);
    expect(headers.get('user-agent')).toBe('MojaPosta/2.5.0 (android)');
    expect(headers.get('accept')).toBe('application/json');
    // A Content-Type on this GET makes the service answer 400; no token or cookie is sent.
    for (const name of ['content-type', 'x-recaptcharesponse', 'cookie', 'authorization']) expect(headers.has(name), name).toBe(false);
    expect(init!.method ?? 'GET').toBe('GET');
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'posta-slovenije', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered item newest first, on UTC clocks, with post offices and without people or postcodes', () => {
    const result = parsePostaSlovenije(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The item was delivered to the mailbox / P.O. box. The item was delivered to the doorstep',
      last_update: '2026-03-04T08:15:20Z', delivered_at: '2026-03-04T08:15:20Z', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-03-04T08:15:20Z', 'VL', 'The item was delivered to the mailbox / P.O. box. The item was delivered to the doorstep', 'Primerno',
        'delivered'],
      ['2026-03-04T05:10:42.083Z', 'N', 'The item is expected to be delivered today. The item is out for doorstep delivery', 'Primerno',
        'out_for_delivery'],
      ['2026-03-03T15:40:05.117Z', 'S', 'The item has arrived at Pošta Slovenije', 'Vzorčni Center', 'accepted'],
      ['2026-03-02T12:00:10.250Z', 'NAJ',
        'The item information has been received in the Pošta Slovenije system. The sender has not yet handed over the item to Pošta Slovenije',
        undefined, 'registered'],
    ]);
    expect(result.pickup_point).toBeUndefined();
    expect(result.events!.every(event => event.local_time === undefined)).toBe(true);
    for (const [name, number] of [['delivered', DELIVERED], ['returned', RETURNED], ['waiting', WAITING]] as const) {
      const serialized = JSON.stringify(parsePostaSlovenije(fixture(name), number));
      for (const hidden of ['Vzorec', 'Primerni"', 'V. Primerni', '1BOX2', 'cesta', 'ulica', 'Paketomat', 'PM900', '"900']) {
        expect(serialized, `${name} ${hidden}`).not.toContain(hidden);
      }
    }
  });

  it('reads a foreign post’s relayed events on that post’s clock, and Pošta Slovenije’s own scans as UTC instants', () => {
    const result = parsePostaSlovenije(fixture('abroad'), ABROAD);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-03-06T08:15:20Z', delivered_at: '2026-03-06T08:15:20Z' });
    // The service labels Lithuania's wall clock with Ljubljana's offset: 14:48 in Vilnius reads 13:48Z.
    expect(rows(result).map(row => [row[0], row[1]])).toEqual([['2026-03-06T08:15:20Z', 'VL'], ['2026-03-06T05:10:42.083Z', 'N'],
      ['2026-03-05T17:21:30Z', 'EMF'], ['2026-03-05T17:20:56Z', 'EMD'], ['2026-03-04T14:48:00+02:00', 'EMC'],
      ['2026-03-04T00:44:00+02:00', 'EMB'], ['2026-03-02T17:07:00+02:00', 'EMA']]);
    expect(result.events!.every(event => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('99001');

    // A country with several zones keeps the wall clock, and the newest one stands in for the last update.
    const american = edited('abroad', payload => {
      payload.result.parcel.trackingNumber = 'RR900000053US';
      payload.result.statuses = payload.result.statuses.slice(0, 3);
      for (const row of payload.result.statuses.slice(1)) row.postalId = 'USSMPA';
    });
    const far = parsePostaSlovenije(american, 'RR900000053US');
    expect(far).toMatchObject({ last_update: null, last_update_local: '2026-03-04T14:48:00' });
    expect(far.events!.map(event => [event.time, event.local_time])).toEqual([[undefined, '2026-03-04T14:48:00'],
      [undefined, '2026-03-04T00:44:00'], [undefined, '2026-03-02T17:07:00']]);

    // Before any office of exchange, the S10 code names the origin of a posting abroad.
    const posted = parsePostaSlovenije(edited('abroad', payload => { payload.result.statuses = payload.result.statuses.slice(0, 1); }), ABROAD);
    expect(posted).toMatchObject({ last_update: '2026-03-02T17:07:00+02:00' });

    // A Slovenian item abroad: events past the inward office are the destination's, on its clock.
    const outbound = edited('abroad', payload => {
      payload.result.parcel.trackingNumber = 'CF900000053SI';
      const [posting, , departure, arrival] = payload.result.statuses;
      Object.assign(posting!, { postalId: '9001', postalName: 'Primerno', statusDateTime: '2026-03-02T09:12:31Z' });
      Object.assign(departure!, { postalId: 'SISMPA', statusDateTime: '2026-03-03T14:05:12Z' });
      Object.assign(arrival!, { postalId: 'HRSMPA', statusDateTime: '2026-03-04T07:30:00Z' });
      const delivered = { ...arrival!, code: 'EMI', codeDescriptionEN: 'Final delivery', postalId: '99002', statusDateTime: '2026-03-05T09:00:00Z' };
      payload.result.statuses = [posting!, departure!, arrival!, delivered];
    });
    expect(rows(parsePostaSlovenije(outbound, 'CF900000053SI')).map(row => [row[0], row[1]])).toEqual([
      ['2026-03-05T10:00:00+01:00', 'EMI'], ['2026-03-04T08:30:00+01:00', 'EMD'], ['2026-03-03T14:05:12Z', 'EMC'],
      ['2026-03-02T09:12:31Z', 'EMA']]);

    // Sent back: inward offices in two countries leave a delivery at a bare postcode on its wall clock.
    const back = edited('abroad', payload => {
      const arrival = { ...payload.result.statuses[3]!, postalId: 'LTSMPA', statusDateTime: '2026-03-20T08:00:00Z' };
      const delivered = { ...arrival, code: 'EMI', codeDescriptionEN: 'Final delivery', postalId: '99001', statusDateTime: '2026-03-21T09:00:00Z' };
      payload.result.statuses.push(arrival, delivered);
    });
    expect(rows(parsePostaSlovenije(back, ABROAD)).slice(0, 2).map(row => row[1])).toEqual(['EMI', 'EMD']);
    expect(parsePostaSlovenije(back, ABROAD).events!.slice(0, 2).map(event => [event.time, event.local_time])).toEqual([
      [undefined, '2026-03-21T10:00:00'], ['2026-03-20T09:00:00+02:00', undefined]]);
  });

  it('reads an item sent back after a missed locker pickup as an exception, and its later delivery as a return', () => {
    const result = parsePostaSlovenije(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Unsuccessful delivery attempt. Item is being returned to the sender', last_update: '2026-02-20T09:30:21.687Z' });
    expect(result.pickup_point).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result).map(row => [row[1], row[4]])).toEqual([['V', 'exception'], ['IZR', 'ready_for_pickup'], ['V', 'failed_attempt'],
      ['POTPKTM', 'failed_attempt'], ['VLPAKP', 'out_for_delivery'], ['N', 'out_for_delivery'], ['NAJ', 'registered']]);
    expect(rows(result)[2]![2]).toBe('Unsuccessful delivery attempt. Unsuccessful delivery attempt at parcel locker. '
      + 'The item is ready for pickup at the post office');
    const back = parsePostaSlovenije(edited('returned', payload => { payload.result.statuses.push(delivery('2026-02-24T10:00:00Z')); }),
      RETURNED);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned', last_update: '2026-02-24T10:00:00Z' });
    expect(back.delivered_at).toBeUndefined();
    expect(back.pickup_point).toBeUndefined();
  });

  it('names the post office an item waits at, and the one it was collected from', () => {
    const waiting = parsePostaSlovenije(fixture('waiting'), WAITING);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'Poskusno',
      last_status_text: 'The item is ready for pickup at the post office' });
    expect(rows(waiting)[1]).toEqual(['2026-03-10T05:58:59Z', 'VDO',
      'Unsuccessful delivery attempt. The item will be redirected to the post office', 'Poskusno', 'failed_attempt']);
    const collected = parsePostaSlovenije(edited('waiting', payload => { payload.result.statuses.push(delivery('2026-03-12T11:00:00Z')); }),
      WAITING);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', pickup_point: 'Poskusno',
      delivered_at: '2026-03-12T11:00:00Z' });
    // A wait that is not at a post office, or a delivery to the door, names no pickup point.
    const locker = parsePostaSlovenije(edited('waiting', payload => { payload.result.statuses.at(-1)!.unitType = 8; }), WAITING);
    expect(locker).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(locker.pickup_point).toBeUndefined();
    expect(parsePostaSlovenije(fixture('delivered'), DELIVERED).pickup_point).toBeUndefined();
  });

  it('orders scans by clock, keeps equal clocks in the service’s order and drops repeated rows', () => {
    const result = parsePostaSlovenije(fixture('waiting'), WAITING);
    const shuffled = edited('waiting', payload => { payload.result.statuses.reverse(); });
    // Reversed, the scans keep their clocks; only ties would follow the reply's order.
    expect(parsePostaSlovenije(shuffled, WAITING).events).toEqual(result.events);
    const repeated = edited('waiting', payload => { payload.result.statuses.push({ ...payload.result.statuses[2]! }); });
    expect(parsePostaSlovenije(repeated, WAITING).events).toEqual(result.events);
    const tied = edited('waiting', payload => {
      const last = payload.result.statuses.at(-1)!;
      payload.result.statuses.at(-2)!.statusDateTime = last.statusDateTime;
    });
    expect(parsePostaSlovenije(tied, WAITING).events!.slice(0, 2).map(event => event.provider_code)).toEqual(['PVI', 'VDO']);
  });

  it('stages new codes through the shared rules for their wording and keeps the rest visible without a stage', () => {
    const worded = parsePostaSlovenije(edited('delivered', payload => { payload.result.statuses.at(-1)!.code = 'XDOST'; }), DELIVERED);
    expect(worded).toMatchObject({ current_stage: 'delivered', current_stage_source: expect.not.stringMatching(/^carrier_map$/) });
    const unknown = parsePostaSlovenije(edited('delivered', payload => {
      Object.assign(payload.result.statuses.at(-1)!, { code: 'TEHT', codeDescriptionEN: 'Weighed', codeDetailedDescriptionEN: '' });
    }), DELIVERED);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Weighed' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.delivered_at).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-03-04T08:15:20Z', description: 'Weighed', provider_code: 'TEHT', location: 'Primerno' });
    // Slovenian wording stands in when the English heading is missing.
    const slovenian = parsePostaSlovenije(edited('delivered', payload => {
      Object.assign(payload.result.statuses.at(-1)!, { codeDescriptionEN: null, codeDetailedDescriptionEN: null });
    }), DELIVERED);
    expect(slovenian.last_status_text).toBe('Pošiljka je bila vložena v hišni predalčnik ali poštni predal');
  });

  it('reads a parcel without scans from its own heading', () => {
    const summary = parsePostaSlovenije(edited('waiting', payload => { payload.result.statuses = []; }), WAITING);
    expect(summary).toMatchObject({ summary_only: true, current_stage: 'ready_for_pickup', last_update: '2026-03-10T13:59:10.520Z',
      last_status_text: 'The item is ready for pickup at the post office', events: [] });
    const silent = edited('waiting', payload => {
      payload.result.statuses = [];
      Object.assign(payload.result.parcel, { codeDescriptionEN: null, codeDescriptionSI: null });
    });
    expect(() => parsePostaSlovenije(silent, WAITING)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the reply to the whole requested number and rejects malformed histories', () => {
    expect(() => parsePostaSlovenije(fixture('delivered'), RETURNED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const many = Array.from({ length: 501 }, () => ({ ...(fixture('delivered') as Reply).result.statuses[1]! }));
    for (const payload of [null, [], {}, fixture('not-found'), { result: { parcel: null } },
      edited('delivered', reply => { delete reply.result.parcel.trackingNumber; }),
      edited('delivered', reply => { reply.result.parcel.trackingNumber = `${DELIVERED} ${RETURNED}`; }),
      edited('delivered', reply => { (reply.result as { statuses: unknown }).statuses = {}; }),
      edited('delivered', reply => { reply.result.statuses = many; }),
      edited('delivered', reply => { reply.result.statuses[1]!.statusDateTime = '2026-03-03T15:40:05'; }),
      edited('delivered', reply => { reply.result.statuses[1]!.statusDateTime = '03.03.2026 15:40'; }),
      edited('delivered', reply => { reply.result.statuses[1]!.code = ''; }),
      edited('delivered', reply => { reply.result.statuses[1]!.code = 'S<b>'; }),
      edited('delivered', reply => { (reply.result.statuses as unknown[])[1] = 'scan'; })]) {
      expect(() => parsePostaSlovenije(payload, DELIVERED), JSON.stringify(payload)?.slice(0, 80))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the service’s notice for the requested number as a missing item', async () => {
    const absent = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), 404));
    await expect(carrier(absent).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(absent).recognize!(ABSENT)).resolves.toEqual({ known: false });
    for (const body of [text('not-found').replace(ABSENT, 'ZZ000000014SI'), '{"result":null,"errorCode":"error.route","errorMessage":null}',
      '<html><body>Not Found</body></html>', '']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, 404));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'transport' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the service’s refusal, block pages and malformed replies apart from missing items', async () => {
    for (const [body, status, kind] of [
      [text('refused'), 403, 'challenge'], ['<html><head><title>403 Forbidden</title></head></html>', 403, 'challenge'],
      ['<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>', 200, 'challenge'],
      ['<html><body>Vzdrževalna dela</body></html>', 200, 'schema'], ['{"result":{"items":[]}}', 200, 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status, { 'Content-Type': 'text/html' }));
      await expect(carrier(fetcher).track({ number: DELIVERED }), body).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED), body).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it.each([[400, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"result":null,"errorCode":"error.bad.request"}', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('takes S10 codes with a valid check digit, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CF900000018SI', 'CF90000001SI', 'CF9000000190SI', '3SDFCE123456', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    // Items other posts send to Slovenia carry their own country code.
    const inbound = vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found').replace(ABSENT, 'RR000000014DE'), 404));
    await expect(carrier(inbound).track({ number: 'RR000000014DE' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('recognizes a known parcel and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found'), 404));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-03-04T08:15:20.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under Pošta Slovenije to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'posta-slovenije' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'posta-slovenije', source: 'posta-slovenije', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(POSTA_SLOVENIJE_ENDPOINT))).toBe(true);
  });

  it('is named for its own items and asked about its other Slovenian S10 codes', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'posta-slovenije', confidence: 'high' });
    expect(detectCarrierMatch('UA123456785SI')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers('UA123456785SI')).toContain('posta-slovenije');
    expect(recognitionAskedCarriers('CF900000018SI')).not.toContain('posta-slovenije');
    expect(recognitionAskedCarriers('RR000000014DE')).not.toContain('posta-slovenije');
  });
});

describe('Pošta Slovenije status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(postaSlovenijeStage(entry.code, entry.wording)?.stage, `${entry.code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    }
    for (const code of ['constructor', 'toString', 'NPIS', 'VRPIS']) expect(statusMap.stage(code, 'synthetic wording'), code).toBeUndefined();
    expect(statusMap.stage(null, 'the item has arrived at pošta slovenije')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'posta-slovenije', providerCode: 'PVI', description: 'The item is ready for pickup at the post office' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
