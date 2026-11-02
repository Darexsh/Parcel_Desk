import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FourPxTracker, parse } from './adapter.js';
import { statusMap } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '4PX0000000000001CN';
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
// A partner's pickup-shop record as 4PX relays it in place of a scan's wording.
const SHOP_RECORD = 'Shop;xx00001;example shop;xx;;exampletown;;example street 1;;;;0000_store_type;pudo_id;pudo_name;country_code;province;city;district;street;property_number;address_line_2;address_line_3;postcode';
/** The delivered fixture whose newest scans went to a pickup shop after a missed delivery, as DPD relays them. */
function atShop() {
  const payload = fixture();
  const tracks = payload.data[0].tracks;
  payload.data[0].tracks = [
    { ...tracks[0], tkCode: 'FPX_D_SASPS', tkDesc: 'Takeover by pickup parcel shop_shop' },
    { ...tracks[0], tkCode: 'FPX_D_SASPS', tkDesc: 'Parcel was handed over to pickup parcel shop_shop', tkDateStr: '2026-03-28 14:27:03' },
    { ...tracks[0], tkCode: '', tkDesc: SHOP_RECORD, tkDateStr: '2026-03-28 13:25:03' },
    { ...tracks[0], tkCode: 'FPX_D_DDRH', tkDesc: 'Unfortunately, consignee not present. notification was left._nabn', tkDateStr: '2026-03-28 13:25:03' },
    ...tracks.slice(1),
  ];
  return payload;
}

describe('4PX result projection', () => {
  it('confirms an LP reference only through matching shipment scans', async () => {
    const number = 'LP0000000000001CN';
    const value = fixture(); value.data[0].queryCode = number;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(number, { budgetMs: 1000 })).resolves.toEqual({ known: true, lastActivityAt: '2026-03-28T18:30:03.000Z' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).queryCodes).toEqual([number]);
    await expect(instance.recognize!('INVALID')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps wrong-identity recognition replies distinct from the explicit missing result', async () => {
    const number = 'LP0000000000001CN';
    const missing = fixture('not-found'); missing.data[0].queryCode = number;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(missing)))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(number, { budgetMs: 1000 })).resolves.toEqual({ known: false });
    await expect(instance.recognize!(number, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'schema' });
  });
  it('binds the parcel and uses the displayed clock with its per-scan offset', () => {
    const result = normalizeCarrierResult(parse(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-03-28T14:30:03-04:00',
      delivered_at: '2026-03-28T14:30:03-04:00', destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: '9400100000000000000006' });
    expect(result.events).toHaveLength(26);
    expect(result.events?.[1]!.stage).toBe('out_for_delivery');
    expect(result.events?.at(-1)).toMatchObject({ stage: 'registered', time: '2026-03-03T14:30:03+08:00' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.timezone).toBeUndefined();
  });

  it('retains clock uncertainty and provider order when an offset is absent', () => {
    const payload = fixture();
    payload.data[0].tracks[0].tkTimezone = null;
    const result = parse(payload, NUMBER);
    expect(result.last_update).toBeNull();
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-03-28T14:30:03' });
    expect(result.events?.[0]!.time).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads the order data sent to a partner on the facility\'s clock, not the partner\'s zone it is labelled with', () => {
    const payload = fixture();
    const tracks = payload.data[0].tracks;
    const transmitted = { ...tracks.at(-5), tkCode: 'FPX_O_IR', tkDesc: 'Order information has been transmitted to dpd.',
      tkDateStr: '2026-03-08 14:30:06', tkTimezone: 'UTC+02:00' };
    payload.data[0].tracks = [...tracks.slice(0, -5), transmitted, ...tracks.slice(-5)];
    const events = parse(payload, NUMBER).events!;
    expect(events.find((event) => event.description?.startsWith('Order information'))?.time).toBe('2026-03-08T14:30:06+08:00');
    // A partner's own label keeps its zone, and without a facility scan so does the transmission.
    expect(events.find((event) => event.provider_code === 'FPX_O_IRI')?.time).toBe('2026-03-04T14:30:03-04:00');
    payload.data[0].tracks = payload.data[0].tracks.filter((raw: { tkCode: string }) => !raw.tkCode.startsWith('FPX_C_'));
    expect(parse(payload, NUMBER).events!.find((event) => event.description?.startsWith('Order information'))?.time)
      .toBe('2026-03-08T14:30:06+02:00');
  });

  it("reads 4PX's copies of La Poste's arrival and transit in France as UTC, not on the Paris offset they are labelled with", () => {
    const payload = fixture();
    payload.data[0].ctEndCode = 'FR';
    const tracks = payload.data[0].tracks;
    const copy = (tkCode: string, tkDesc: string, tkDateStr: string) => ({ ...tracks.at(-5), tkCode, tkDesc, tkDateStr, tkTimezone: 'UTC+02:00' });
    payload.data[0].tracks = [
      copy('FPX_D_SD', 'Out for delivery', '2026-03-23 08:23:40'),
      copy('FPX_D_HQ', 'Transport to delivery centre', '2026-03-22 08:16:04'),
      copy('FPX_D_HQ', 'Transport to delivery centre', '2026-03-21 23:40:00'),
      copy('FPX_M_IT', 'Handled by local carrier', '2026-03-21 21:40:13'),
      copy('FPX_O_RR', 'Arrived at destination', '2026-03-21 13:49:55'),
      ...tracks.slice(-5),
    ];
    const times = () => parse(payload, NUMBER).events!.slice(0, 5).map((event) => event.time);
    // La Poste's copies keep its seconds; 4PX's own row to the minute and the round's copy show Paris's clock.
    expect(times()).toEqual(['2026-03-23T08:23:40+02:00', '2026-03-22T08:16:04Z', '2026-03-21T23:40:00+02:00',
      '2026-03-21T21:40:13Z', '2026-03-21T13:49:55Z']);
    payload.data[0].ctEndCode = 'DE';
    expect(times()[1]).toBe('2026-03-22T08:16:04+02:00');
  });

  it("reads Asendia Hong Kong's label and manifest as UTC, not on the destination's offset they are labelled with", () => {
    const payload = fixture();
    const tracks = payload.data[0].tracks;
    const asendia = (tkDesc: string, tkDateStr: string) => ({ ...tracks.at(-5), tkCode: 'FPX_O_IR', tkDesc, tkDateStr,
      tkTimezone: 'UTC+02:00', tkLocation: 'Asendia Hong Kong' });
    payload.data[0].tracks = [...tracks.slice(0, -7), asendia('Manifest created', '2026-03-09 08:55:20'), ...tracks.slice(-7, -5),
      asendia('Label creation', '2026-03-08 06:30:03'), ...tracks.slice(-5)];
    const events = parse(payload, NUMBER).events!;
    // The label is made as the facility measures the parcel, at 14:30:03 +08:00.
    expect(events.filter((event) => event.location === 'Asendia Hong Kong').map((event) => event.time))
      .toEqual(['2026-03-09T08:55:20Z', '2026-03-08T06:30:03Z']);
    expect(events.find((event) => event.description === 'Label creation')?.stage).toBe('registered');
  });

  it("leaves out a partner's scan listed again with UTC digits under the same offset", () => {
    const payload = fixture();
    const tracks = payload.data[0].tracks;
    // A partner's order made as the facility measures the parcel at 14:30:03 +08:00, on its clock and in UTC digits.
    const order = (tkDateStr: string) => ({ ...tracks.at(-6), tkCode: '', tkDesc: 'Order creation, order submitted, pending to receive.',
      tkDateStr, tkTimezone: 'UTC+11:00', tkLocation: '' });
    payload.data[0].tracks = [...tracks.slice(0, 20), order('2026-03-08 17:30:04'), ...tracks.slice(20, 23), order('2026-03-08 06:30:04'),
      ...tracks.slice(23)];
    const orders = () => parse(payload, NUMBER).events!.filter((event) => event.description?.startsWith('Order creation'))
      .map((event) => event.time);
    expect(orders()).toEqual(['2026-03-08T17:30:04+11:00']);
    // Without its twin, a scan keeps the offset it is labelled with.
    payload.data[0].tracks.splice(20, 1);
    expect(orders()).toEqual(['2026-03-08T06:30:04+11:00']);
  });

  it('reads a scan whose zone is named rather than offset', () => {
    const payload = fixture();
    payload.data[0].tracks[0].tkTimezone = 'UTCAmerica/Vancouver';
    expect(parse(payload, NUMBER)).toMatchObject({ last_update: '2026-03-28T14:30:03-07:00', delivered_at: '2026-03-28T14:30:03-07:00' });
    payload.data[0].tracks[0].tkTimezone = 'UTCExample/Nowhere';
    const result = parse(payload, NUMBER);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-03-28T14:30:03' });
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
    payload.data[0].tracks[0].tkTimezone = 'UTC 08:00';
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires an exact unique identity rather than trusting the first parcel', () => {
    const payload = fixture();
    payload.data[0].queryCode = '4PX0000000000002CN';
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    payload.data[0].queryCode = NUMBER;
    payload.data.push(payload.data[0]);
    expect(() => parse(payload, NUMBER)).toThrow('ambiguous');
  });

  it('recognizes only the explicit missing-item signature', () => {
    expect(() => parse(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const payload = fixture();
    payload.data[0].tracks = [];
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    payload.data[0].status = 7;
    payload.data[0].tracks = null;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ result: 0, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects multi-package summaries and invalid scans rather than promoting an older event', () => {
    const payload = fixture();
    payload.data[0].mutiPackage = true;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    payload.data[0].mutiPackage = false;
    payload.data[0].tracks[0].tkDateStr = '2026-02-30 10:00:00';
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    payload.data[0].tracks[0].tkDateStr = '2026-03-01 10:00:00';
    payload.data[0].tracks[0].tkDesc = '';
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('leaves new event codes unmapped and deduplicates repeated scans', () => {
    const payload = fixture();
    payload.data[0].tracks[0].tkCode = 'FPX_NEW';
    payload.data[0].tracks.push(payload.data[0].tracks[0]);
    const result = parse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', events: expect.any(Array) });
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]!.stage).toBeUndefined();
    expect(result.events).toHaveLength(26);
  });

  it('keeps the package number of a routing barcode without the ZIP code before it', () => {
    const payload = fixture();
    const result = (value: unknown) => normalizeCarrierResult(parse(value, NUMBER));
    expect(JSON.stringify(result(payload))).not.toContain('42000001');
    payload.data[0].serverCode = '4200000000000000000000000000000001';
    expect(result(payload)).toMatchObject({ delivery_carrier: 'usps' });
    expect(result(payload).delivery_tracking_number).toBeUndefined();
    payload.data[0].serverCode = 'ZZ000000005GB';
    expect(result(payload).delivery_tracking_number).toBe('ZZ000000005GB');
  });

  it('names a last-mile provider only when the catalog knows it and its website agrees', () => {
    const payload = fixture(); const card = payload.data[0].channelContact;
    card.contact = '【服务商】Royal Mail\n【联系方式】\nPRIVATE_CONTACT'; card.website = 'http://www.royalmail.com/';
    expect(parse(payload, NUMBER).delivery_carrier).toBe('royal-mail');
    card.website = 'www.royalmail.com';
    expect(parse(payload, NUMBER).delivery_carrier).toBe('royal-mail');
    for (const [contact, website] of [['【服务商】Royal Mail', 'https://www.usps.com/'], ['【服务商】Example Parcels', 'https://example.invalid/'],
      ['PRIVATE_CONTACT', 'https://www.usps.com/']]) {
      card.contact = contact; card.website = website;
      expect(parse(payload, NUMBER).delivery_carrier).toBeUndefined();
    }
    payload.data[0].channelContact = null;
    expect(parse(payload, NUMBER).delivery_carrier).toBeUndefined();
  });

  it('names Emile as the provider of a Canadian parcel', () => {
    const payload = fixture(); const card = payload.data[0].channelContact;
    card.contact = '【服务商】Emile\n【联系方式】\nPRIVATE_CONTACT'; card.website = 'https://www.emileps.com/';
    payload.data[0].serverCode = 'EM000000000001CA';
    expect(parse(payload, NUMBER)).toMatchObject({ delivery_carrier: 'emile', delivery_tracking_number: 'EM000000000001CA' });
  });

  it.each([
    ['FPX_D_FD', 'Delivery attempt unsuccessful', 'exception', 'failed_attempt', 'carrier_map'],
    ['FPX_D_FDIA', 'Delivery attempt (incorrect address)', 'exception', 'failed_attempt', 'carrier_map'],
    ['FPX_M_PRTS', 'Returned (incorrect address)', 'exception', 'exception', 'carrier_map'],
    ['FPX_F_ST', 'Shipment in transit', 'in_transit', 'in_transit', 'carrier_map'],
    ['FPX_D_AOPC', 'Arrive in transit center', 'in_transit', 'in_transit', 'carrier_map'],
    ['FPX_M_PT', 'Pending transportation', 'in_transit', 'in_transit', 'carrier_map'],
    ['FPX_D_DFD', 'Out from national sorting center', 'in_transit', 'in_transit', 'carrier_map'],
    ['FPX_C_SPQS', '4px received shipment.', 'in_transit', 'accepted', 'carrier_map'],
    ['FPX_O_IR', 'Waybill generated', 'pending', 'registered', 'carrier_map'],
    ['FPX_O_IR', 'Waybill generated for EM000000000001CA', 'pending', 'registered', 'carrier_map'],
    ['FPX_O_IR', 'The shipment item has arrived at the country of destination.', 'in_transit', 'in_transit', 'wording:language'],
    ['FPX_O_IRI', 'Picked up by shipping partner, usps awaiting item', 'in_transit', 'accepted', 'wording:language'],
    ['FPX_O_IR', 'Order data transmitted', 'pending', 'registered', 'carrier_map'],
    ['FPX_I_CP', 'Customs clearance in progress.', 'in_transit', 'customs', 'carrier_map'],
    ['FPX_D_SASPS', 'Parcel was handed over to pickup parcel shop_shop', 'out_for_delivery', 'ready_for_pickup', 'carrier_map'],
    ['FPX_D_SD', 'In transit', 'in_transit', 'in_transit', 'carrier_map'],
    ['FPX_D_SD', 'Scheduled for delivery', 'out_for_delivery', 'out_for_delivery', 'carrier_map'],
  ])('reads %s "%s" as %s', (code, description, status, stage, source) => {
    const payload = fixture(); Object.assign(payload.data[0].tracks[0], { tkCode: code, tkDesc: description });
    const result = parse(payload, NUMBER);
    expect(result).toMatchObject({ status, current_stage: stage, current_stage_source: source });
    expect(result.events?.[0]).toMatchObject({ stage, stage_source: source });
  });

  it('drops a partner\'s qualifier from its wording and reads its pickup-shop record as the pickup point', () => {
    const result = parse(atShop(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Takeover by pickup parcel shop',
      pickup_point: 'example shop, exampletown' });
    expect(result.events?.slice(0, 3).map((event) => [event.description, event.stage])).toEqual([
      ['Takeover by pickup parcel shop', 'ready_for_pickup'],
      ['Parcel was handed over to pickup parcel shop', 'ready_for_pickup'],
      ['Unfortunately, consignee not present. notification was left.', 'failed_attempt'],
    ]);
    expect(result.events?.some((event) => event.description?.includes(';'))).toBe(false);
  });

  it('never shows a pickup-shop record as a scan, even as the newest uncoded one', () => {
    const newest = (tkDesc: string) => {
      const payload = fixture();
      const tracks = payload.data[0].tracks;
      payload.data[0].tracks = [{ ...tracks[0], tkCode: '', tkDesc, tkLocation: '', tkDateStr: '2026-03-29 09:00:00' }, ...tracks];
      return parse(payload, NUMBER);
    };
    const latest = parse(fixture(), NUMBER);
    for (const [record, point] of [
      [SHOP_RECORD.replace(/^Shop;/, 'shop;'), 'example shop, exampletown'],
      // The field names in capitals; and a record without a shop name, which names no pickup point either.
      ['shop;xx00001;example shop;xx;;exampletown;;;;;;0000_STORE_TYPE;PUDO_ID;PUDO_NAME;COUNTRY_CODE;PROVINCE;CITY', 'example shop, exampletown'],
      ['shop;xx00001;xx;;exampletown_store_type;pudo_id;country_code;province;city', undefined],
    ] as const) {
      const result = newest(record);
      expect(result.events, record).toEqual(latest.events);
      expect(result.last_status_text, record).toBe(latest.last_status_text);
      expect(result.pickup_point, record).toBe(point);
      expect(JSON.stringify(result), record).not.toMatch(/store_type|pudo_|xx00001/i);
    }
  });

  it('leaves a relayed step unstaged when its wording says nothing', () => {
    const payload = fixture(); Object.assign(payload.data[0].tracks[0], { tkCode: 'FPX_O_IR', tkDesc: 'Task assigned' });
    const result = parse(payload, NUMBER);
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined(); expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('stages the transit scans a partner relays without a code, and only those', () => {
    for (const [tkDesc, expected] of [['Your shipment has arrived at the transit destination', 'in_transit'],
      ['Your shipment has departed from the transit origin', 'in_transit'], ['Order creation, order submitted, pending to receive.', 'registered'],
      ['Task assigned', undefined]] as const) {
      const payload = fixture(); Object.assign(payload.data[0].tracks[0], { tkCode: '', tkDesc });
      expect(parse(payload, NUMBER).events?.[0]?.stage, tkDesc).toBe(expected);
    }
    expect(statusMap.stage(null, 'your shipment has arrived at the transit destination')).toBe('in_transit');
    expect(statusMap.stage('FPX_NEW', 'your shipment has arrived at the transit destination')).toBeUndefined();
    expect(statusMap.stage('FPX_S_OK', 'delivered, in/at mailbox')).toBe('delivered');
    expect(statusMap.stage('FPX_O_IR', 'waybill generated')).toBe('registered');
    expect(statusMap.stage('FPX_O_IR', 'waybill generated for em000000000001ca')).toBe('registered');
    expect(statusMap.stage('FPX_O_IR', 'waybill generated for the sender, picked up')).toBeUndefined();
    expect(statusMap.stage('FPX_O_IR', 'label creation')).toBe('registered');
    expect(statusMap.stage('FPX_O_IR', 'manifest created')).toBe('in_transit');
    expect(statusMap.stage('FPX_O_IR', 'parcel arrival notified')).toBe('registered');
    expect(statusMap.stage('FPX_NEW', 'manifest created')).toBeUndefined();
  });

  it('proves the declared capabilities using the synthetic response', () => {
    const result = parse(fixture(), NUMBER);
    const checks: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.some((event) => event.location)), delivered_at: Boolean(result.delivered_at),
      provider_code: Boolean(result.events?.every((event) => event.provider_code)), delivery_partner: Boolean(result.delivery_carrier),
      delivery_tracking_number: Boolean(result.delivery_tracking_number), pickup_point: Boolean(parse(atShop(), NUMBER).pickup_point) };
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    for (const capability of metadata.capabilities) expect(checks[capability], capability).toBe(true);
  });
});

describe('4PX retrieval', () => {
  it('makes one fresh anonymous bounded request and records the direct step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(fixture())));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder });
    await instance.track({ number: '4px 0000000000001 cn' });
    await instance.track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://track.4px.com/track/v2/front/listTrackV3');
    expect(JSON.parse(String(init?.body))).toEqual({ queryCodes: [NUMBER], language: 'en-us', translateLanguage: '' });
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'four-px', step: 'direct', outcome: 'ok' }));
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])('classifies HTTP %s separately from a missing parcel', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status: Number(status) }));
    await expect(new FourPxTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('enforces size and budget limits and propagates cancellation', async () => {
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new FourPxTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted();
      return new Response('{}');
    });
    await expect(new FourPxTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 10.5 })).rejects.toMatchObject({ kind: 'transport' });
    const unused = vi.fn<typeof fetch>();
    await expect(new FourPxTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(new FourPxTracker({ fetcher: unused }).fetch('bad&query=number')).rejects.toThrow(InvalidInputError);
    // The adapter refuses it before its lookup starts, so an ended signal does not hide it.
    await expect(adapter({ fetcher: unused, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER })
      .track({ number: 'bad&query=number' }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(unused).not.toHaveBeenCalled();
  });
});
