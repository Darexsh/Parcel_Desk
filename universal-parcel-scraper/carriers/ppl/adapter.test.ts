import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { CARRIER_DEFINITIONS, tracksAutomatically } from '../../core/catalog/index.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { universalCarrierHints } from '../../providers/shared/hints.js';
import { adapter, PplTracker } from './adapter.js';
import { parsePpl, parsePplRejection } from './parser.js';
import { pplStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '40000000001';
const API = `https://api.dhl.com/ecs/ppl/webapi/TrackAndTrace/${NUMBER}`;
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = JSON.parse(read('delivered.json'));
const notFound = read('not-found.json');
const payload = () => structuredClone(delivered);
type Row = { code: string; eventDate: string; eventText: string };
const row = (code: string, eventDate: string, eventText = 'Synthetic wording'): Row => ({ code, eventDate, eventText });
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });
const transport = (tracking: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => tracking());
const carrier = (fetcher: typeof fetch) =>
  adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PPL tracking through its tracking page’s service', () => {
  it('posts the page’s search with the included key through the supplied transport', async () => {
    const fetcher = transport(() => reply(delivered));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PplTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${NUMBER} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(API);
    expect(init).toMatchObject({ method: 'POST', body: '{}', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Accept-Language': 'en-US', 'Content-Type': 'application/json',
      'dhl-api-key': expect.stringMatching(/^\w{32}$/), 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ppl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the scans, their offsets and codes, the ParcelBox name, delivery and weight, and nothing about the people', () => {
    const result = normalizeCarrierResult(parsePpl(payload(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'We have delivered the shipment to the recipient', last_update: '2026-01-06T15:10:00+01:00',
      delivered_at: '2026-01-06T15:10:00+01:00', weight_kg: 1.25, pickup_point: 'PBOX Example Square', expected_delivery: null });
    expect(result.events?.map(event => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-01-06T15:10:00+01:00', 'Delivered', 'delivered'],
      ['2026-01-06T10:00:00+01:00', 'Delivered.Parcelshop', 'ready_for_pickup'],
      ['2026-01-06T06:05:00+01:00', 'LoadingForDelivery', 'out_for_delivery'],
      ['2026-01-06T06:00:00+01:00', 'PreparingForDelivery', 'in_transit'],
      ['2026-01-05T18:30:00+01:00', 'ShipmentInTransport', 'in_transit'],
      ['2026-01-05T14:00:00+01:00', 'ShipmentInTransport.TakeOverFromSender', 'accepted'],
      ['2026-01-05T08:15:30.120+01:00', 'WaitingForShipment', 'registered'],
    ]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map' && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC SENDER|SYNTHREF|Example Street|Example Town|00000|Parcelbox 001|Synthetic note|KM0/);
    const declared = JSON.parse(read('../carrier.json'));
    const ahead = payload();
    ahead.events = ahead.events.slice(0, 4);
    Object.assign(ahead, { showDeliveryDate: true, expectedDeliveryDate: '2026-01-07T00:00:00+01:00' });
    const evidence: Record<string, boolean> = { history: Boolean(result.events?.length), provider_code: Boolean(result.events?.[0]?.provider_code),
      weight: result.weight_kg === 1.25, delivered_at: Boolean(result.delivered_at), pickup_point: Boolean(result.pickup_point),
      eta: parsePpl(ahead, NUMBER).expected_delivery === '2026-01-07' };
    for (const capability of declared.capabilities) expect(evidence[capability], capability).toBe(true);
  });

  it('names the partner abroad and its number only when the partner link carries that number', () => {
    const plate = 'JJD000000000000000000001';
    const abroad = (fields: Record<string, unknown>) => {
      const body = payload();
      body.events = body.events.slice(0, 3);
      return parsePpl(Object.assign(body, fields), NUMBER);
    };
    const handed = abroad({ externalShipmentId: plate, partnerUrl: `https://www.poste.it/cerca/#/risultati-spedizioni/${plate}` });
    expect(handed).toMatchObject({ delivery_carrier: 'poste-italiane', delivery_tracking_number: plate });
    expect(deliveryHandoff('ppl', NUMBER, handed)).toEqual({ carrier: 'poste-italiane', number: plate, basis: 'partner' });
    for (const fields of [{ externalShipmentId: plate }, { externalShipmentId: plate, partnerUrl: 'https://www.poste.it/cerca/' },
      { externalShipmentId: plate, partnerUrl: `https://tracking.example.com/${plate}` },
      { externalShipmentId: NUMBER, partnerUrl: `https://www.poste.it/cerca/#/risultati-spedizioni/${NUMBER}` }]) {
      const result = abroad(fields);
      expect(result.delivery_carrier).toBeUndefined();
      expect(result.delivery_tracking_number).toBeUndefined();
    }
  });

  it('shows the expected day only while the portal would and the parcel is still on its way', () => {
    const ahead = (events: Row[], estimate: string, shown = true) => {
      const value = payload();
      Object.assign(value, { events, showDeliveryDate: shown, expectedDeliveryDate: estimate });
      return parsePpl(value, NUMBER).expected_delivery;
    };
    const moving = [row('ShipmentInTransport', '2026-01-05T18:30:00+01:00')];
    expect(ahead(moving, '2026-01-07T00:00:00+01:00')).toBe('2026-01-07');
    expect(ahead(moving, '2026-01-07T00:00:00+01:00', false)).toBeNull();
    expect(ahead(moving, '2026-01-04T00:00:00+01:00')).toBeNull();
    expect(ahead(moving, '2026-01-07')).toBeNull();
    expect(ahead([row('Delivered.Parcelshop', '2026-01-06T10:00:00+01:00')], '2026-01-07T00:00:00+01:00')).toBeNull();
  });

  it('names the pickup point only while the parcel waits there or once collected from it', () => {
    const point = (...events: Row[]) => {
      const value = payload();
      value.events = events;
      return parsePpl(value, NUMBER);
    };
    expect(point(row('Delivered.Parcelshop', '2026-01-06T10:00:00+01:00'))).toMatchObject({
      status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'PBOX Example Square' });
    // A parcel brought to the door has none, even when the reply names a point.
    const door = point(row('LoadingForDelivery', '2026-01-06T06:05:00+01:00'), row('Delivered', '2026-01-06T15:10:00+01:00'));
    expect(door).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-01-06T15:10:00+01:00' });
    expect(door).not.toHaveProperty('pickup_point');
    const outbound = point(row('ShipmentInTransport', '2026-01-05T18:30:00+01:00'));
    expect(outbound).toMatchObject({ current_stage: 'in_transit' });
    expect(outbound).not.toHaveProperty('pickup_point');
  });

  it('lets a payment step or an unknown code leave the last milestone in place, and reads a return to the end', () => {
    const value = payload();
    value.events.push(row('Cod.Completed', '2026-01-08T09:00:00+01:00', 'The cash on delivery amount has been credited to the sender’s account'),
      row('Synthetic.NewCode', '2026-01-09T09:00:00+01:00'));
    const paid = parsePpl(value, NUMBER);
    expect(paid).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-09T09:00:00+01:00',
      last_status_text: 'Synthetic wording', delivered_at: '2026-01-06T15:10:00+01:00' });
    expect(paid.events?.slice(0, 2).map(event => [event.provider_code, event.stage])).toEqual([['Synthetic.NewCode', undefined], ['Cod.Completed', undefined]]);
    const back = payload();
    back.events = [row('LoadingForDelivery', '2026-01-06T06:05:00+01:00'), row('BackToSender.Refused', '2026-01-06T11:00:00+01:00'),
      row('ShipmentInTransport', '2026-01-07T18:00:00+01:00'), row('Delivered', '2026-01-08T12:00:00+01:00')];
    const returned = parsePpl(back, NUMBER);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(returned).not.toHaveProperty('delivered_at');
    expect(returned.events?.[0]).toMatchObject({ provider_code: 'Delivered', stage: 'delivered' });
    const unknown = payload();
    unknown.events = [row('Synthetic.NewCode', '2026-01-06T06:05:00+01:00')];
    expect(parsePpl(unknown, NUMBER)).toMatchObject({ status: 'unknown', events: [{ provider_code: 'Synthetic.NewCode' }] });
  });

  it('keeps scans newest first by instant, and the service’s order when a clock lacks its offset', () => {
    const value = payload();
    value.events = [row('ShipmentInTransport', '2026-01-05T18:30:00+01:00'), row('ShipmentInTransport.TakeOverFromSender', '2026-01-05T14:00:00+01:00')];
    expect(parsePpl(value, NUMBER).events?.map(event => event.provider_code)).toEqual(['ShipmentInTransport', 'ShipmentInTransport.TakeOverFromSender']);
    value.events[1].eventDate = '2026-01-05T14:00:00';
    const unresolved = parsePpl(value, NUMBER);
    expect(unresolved.events?.map(event => event.provider_code)).toEqual(['ShipmentInTransport.TakeOverFromSender', 'ShipmentInTransport']);
    expect(unresolved).toMatchObject({ current_stage: 'accepted', last_update: null });
    expect(unresolved.events?.[0]).toMatchObject({ provider_time_text: '2026-01-05T14:00:00' });
    expect(unresolved.events?.[0]).not.toHaveProperty('time');
  });

  it('binds the reply to the whole number and keeps empty, malformed and other replies apart from absence', () => {
    for (const shipmentId of ['40000000002', '400000000011', 40000000001, null]) {
      expect(() => parsePpl({ ...payload(), shipmentId }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const events of [undefined, {}, [null], [{ code: 'Delivered', eventDate: '2026-01-06T15:10:00+01:00' }], [{ eventText: 'x' }]]) {
      expect(() => parsePpl({ ...payload(), events }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePpl({ ...payload(), events: [] }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePpl(null, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const problem = JSON.parse(notFound);
    expect(() => parsePplRejection(problem, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePplRejection({ ...problem, instance: undefined }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePplRejection({ ...problem, instance: '/TrackAndTrace/40000000002' }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePplRejection({ ...problem, detail: 'service.TrackAndTrace.Synthetic' }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePplRejection('Bad request', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('returns a confirmed absence as not found, and other HTTP 400 replies as inconclusive', async () => {
    await expect(carrier(transport(() => reply(notFound, 400))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(transport(() => reply({ status: 400, detail: 'service.Synthetic' }, 400))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [404, 'transport'], [410, 'transport']] as const)(
    'preserves HTTP %s from the tracking service as %s', async (status, kind) => {
      const fetcher = transport(() => reply({ status, title: 'Synthetic' }, status));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps a web page or broken JSON from the service apart from a missing parcel', async () => {
    for (const [body, kind] of [['<html><title>Request Rejected</title></html>', 'challenge'], ['{"shipmentId":', 'schema']] as const) {
      await expect(carrier(transport(() => reply(body))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    }
  });

  it('rejects numbers PPL does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['4000000000', '400000000012', 'JJD000000000000000001', '<script>']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a PPL lookup to the adapter without universal providers', async () => {
    expect(CARRIER_DEFINITIONS.ppl.tracking).toMatchObject({ adapter: 'ppl' });
    expect(tracksAutomatically('ppl')).toBe(true);
    const fetcher = transport(() => reply(delivered));
    const answer = await createTracker({ fetcher, providers: [] })
      .track({ number: NUMBER, carrier: 'ppl' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ppl', source: 'ppl', result: { current_stage: 'delivered', pickup_point: 'PBOX Example Square' } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([API]);
  });
});

describe('PPL recognition', () => {
  it('knows a parcel only from a history bound to the number', async () => {
    const fetcher = transport(() => reply(delivered));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([API]);
    await expect(carrier(transport(() => reply(notFound, 400))).recognize!(NUMBER)).resolves.toEqual({ known: false });
  });

  it('keeps every other reply inconclusive and sends nothing for numbers PPL does not issue', async () => {
    for (const [response, kind] of [[() => reply({ status: 400, detail: 'service.Synthetic' }, 400), 'indeterminate'],
      [() => reply('<html><title>Request Rejected</title></html>'), 'challenge'], [() => reply({ status: 429 }, 429), 'rate_limited'],
      [() => reply({ status: 404 }, 404), 'transport']] as const) {
      await expect(carrier(transport(response)).recognize!(NUMBER)).rejects.toMatchObject({ kind });
    }
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['4000000000', '400000000012', 'JJD000000000000000001']) {
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is suggested for eleven digits opening with a product digit and asked first for a Czech parcel or one a provider names PPL', () => {
    for (const number of ['40000000001', '20000000000', '70000000009']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['ppl']) });
      // The commoner eleven-digit carriers come first.
      expect(recognitionAskedCarriers(number).slice(0, 4)).toEqual(['gls-fr', 'gls-de', 'gls-ch', 'postlogistics']);
      expect(recognitionAskedCarriers(number, { countryHint: 'CZ' })[0]).toBe('ppl');
      expect(recognitionAskedCarriers(number, { hint: 'ppl' })[0]).toBe('ppl');
    }
    // A provider names PPL beside the DHL networks it hands over to; only PPL's rule fits.
    expect(universalCarrierHints(['PPL', 'DHL Express', 'DHL Parcel Netherlands'], NUMBER).discovered_carrier).toBe('ppl');
    // PPL is no DHL network: a bare DHL name keeps DHL eCommerce Poland, when its check digit holds.
    expect(universalCarrierHints(['DHL'], '40000000004').discovered_carrier).toBe('dhl-ecommerce-pl');
    expect(universalCarrierHints(['DHL'], NUMBER).discovered_carrier).toBeUndefined();
    for (const number of ['4000000000', '400000000012', 'PPL40000000001', '00000000001', '14000000001']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('ppl');
    }
  });
});

describe('PPL status vocabulary', () => {
  it('stages every recorded code by the code alone, and leaves payment steps out on purpose', () => {
    for (const entry of statuses.entries) {
      expect(pplStage(entry.code), entry.code).toBe(entry.stage);
      const answer = statusMapAnswer({ carrier: 'ppl', providerCode: entry.code, description: entry.wording ?? 'Any wording' });
      expect(answer, entry.code).toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: entry.note });
    }
    expect(statusMap.gaps.map(gap => gap.code)).toEqual(['Cod.AdviceSent', 'Cod.Completed']);
    // Wording alone and codes the map does not know stay open for review.
    expect(statusMapAnswer({ carrier: 'ppl', providerCode: null, description: 'We have delivered the shipment to the recipient' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'ppl', providerCode: 'Synthetic.NewCode', description: 'Delivered' })).toEqual({ kind: 'unknown' });
    expect(pplStage('toString')).toBeUndefined();
  });
});
