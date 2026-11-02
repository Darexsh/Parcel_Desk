import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JITSU_ENDPOINT, JitsuTracker, jitsuTrackingUrl } from './adapter.js';
import { isJitsuNotFound, normalizeJitsuNumber, parseJitsu } from './parser.js';
import { jitsuQuiet, jitsuScanStage, jitsuStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ00000000000001';
const REDELIVERY = 'ZZ00000000000002';
const LINEHAUL = 'ZZ00000000000003';
const ABSENT = 'ZZ00000000000009';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const notFound = (number: string) => ({ servlet: 'jersey', message: 'Not Found', url: `/delivery/${number}`, status: '404' });
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });
const moved = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseJitsu>) => result.events!.map((event) => [event.time, event.provider_code, event.stage, event.stage_source]);
/** An event shaped like the fixture's newest, with these fields. */
const event = (shipment: Reply, fields: Reply): Reply => ({ ...shipment.outbound_events[0], attributes: {}, remark: '', ...fields });

describe('Jitsu tracking adapter', () => {
  it('asks the recipient service once for the code through the supplied transport, without a token, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JitsuTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz00 0000 0000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.recipient.gojitsu.com/delivery/${DELIVERED}`);
    expect(jitsuTrackingUrl('zz00000000000001')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    const headers = new Headers(init!.headers);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jitsu', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first on the shipment’s clock, as the tracker lists it', () => {
    const result = parseJitsu(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your order was successfully delivered.', last_update: '2031-03-11T18:20:15-07:00',
      expected_delivery: null, delivered_at: '2031-03-11T18:20:15-07:00',
      events: [
        { time: '2031-03-11T18:20:15-07:00', description: 'Your order was successfully delivered.',
          provider_code: 'OUTBOUND.DROPOFF_SUCCEEDED', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2031-03-11T10:05:40-07:00', description: 'Your package is on its way to be delivered by 08:00 PM on Mar 11.',
          provider_code: 'OUTBOUND.PICKUP_SUCCEEDED', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2031-03-11T07:30:02-07:00', description: 'Your package has been scheduled to be delivered by 08:00 PM on Mar 11.',
          provider_code: 'OUTBOUND.PICKUP_SCHEDULED', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2031-03-10T21:10:05-07:00', description: 'Your package has been received at a Jitsu facility and will be delivered soon.',
          provider_code: 'INBOUND.RECEIVED_OK', location: 'Example City, CA', stage: 'in_transit', stage_source: 'carrier_map' },
        // Before the change to summer time.
        { time: '2031-03-08T11:45:00-08:00', description: 'A label has been created and we are waiting to receive your package at our warehouse for delivery.',
          provider_code: 'PLANNING.CREATED', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The address change, the first scan that repeats the receipt and the row without a clock are left out.
    // Contact details, the address, postcode and position, remarks, the merchant and the driver stay behind.
    const text = JSON.stringify(result);
    for (const value of ['UPDATE_DROPOFF', 'FIRST_SCAN', 'GEOCODED', 'Example Shop', '***-***-0000', 'e*****@example.com', 'Recipient Town',
      'EX*****01', '99999', 'Synthetic', 'blue door', 'Van', 'NEXT_DAY', 'EXA', '0.5']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('keeps an unknown clock zone in UTC, the reply’s order for equal clocks and each row once', () => {
    const utc = fixture('delivered');
    utc.shipment.timezone = 'Mars/Olympus';
    expect(parseJitsu(utc, DELIVERED)).toMatchObject({ last_update: '2031-03-12T01:20:15Z', delivered_at: '2031-03-12T01:20:15Z' });
    delete utc.shipment.timezone;
    expect(parseJitsu(utc, DELIVERED).events![0]!.time).toBe('2031-03-12T01:20:15Z');
    const tie = fixture('delivered');
    tie.outbound_events.unshift(event(tie, { ts: '2031-03-12T01:20:15.400Z', type: 'OUTBOUND', signal: 'DROPOFF_DELAY',
      description: 'Your delivery has been delayed.' }));
    expect(rows(parseJitsu(tie, DELIVERED)).slice(0, 2)).toEqual([
      ['2031-03-11T18:20:15-07:00', 'OUTBOUND.DROPOFF_DELAY', 'delivered', 'none'],
      ['2031-03-11T18:20:15-07:00', 'OUTBOUND.DROPOFF_SUCCEEDED', 'delivered', 'carrier_map'],
    ]);
    // A notice after the delivery moves nothing.
    expect(parseJitsu(tie, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Your delivery has been delayed.' });
    const twice = fixture('delivered');
    twice.outbound_events.push({ ...twice.outbound_events[0] });
    expect(parseJitsu(twice, DELIVERED).events).toHaveLength(5);
  });

  it('keeps a failed attempt, the return to Jitsu and a new plan in order, and moves a late round past a day off', () => {
    const result = parseJitsu(fixture('redelivery'), REDELIVERY);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Your package is running later than expected. It may still arrive this evening. If not, expect it tomorrow.',
      last_update: '2031-05-06T18:00:00-05:00',
      // The round of 6 May runs late; 7 May is off, so the tracker shows the same hours on 8 May.
      expected_delivery_from: '2031-05-08T09:00:00-05:00', expected_delivery: '2031-05-08T20:00:00-05:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(rows(result)).toEqual([
      ['2031-05-06T18:00:00-05:00', 'OUTBOUND.PICKUP_DELAY', 'in_transit', 'none'],
      ['2031-05-05T10:20:00-05:00', 'PLANNING.GEOCODED', 'in_transit', 'none'],
      ['2031-05-05T10:00:00-05:00', 'OUTBOUND.RETURN_SUCCEEDED', 'in_transit', 'carrier_map'],
      ['2031-05-04T19:30:00-05:00', 'OUTBOUND.DROPOFF_FAILED', 'failed_attempt', 'carrier_map'],
      ['2031-05-04T09:00:00-05:00', 'OUTBOUND.PICKUP_SUCCEEDED', 'out_for_delivery', 'carrier_map'],
      ['2031-05-04T01:00:00-05:00', 'INBOUND.RECEIVED_OK', 'in_transit', 'carrier_map'],
      ['2031-05-01T10:00:00-05:00', 'PLANNING.CREATED', 'registered', 'carrier_map'],
    ]);
    // The trailing space of the attempt's wording is gone, and the driver's note is never read.
    expect(result.events![3]!.description).toBe("Our delivery attempt was unsuccessful. Please click on 'Manage Delivery' to update any necessary information.");
    expect(JSON.stringify(result)).not.toContain('Synthetic driver note');
    // Without the day off the window moves one day; a later shipment window stands.
    const workday = fixture('redelivery');
    workday.no_service_dates[0].off = false;
    expect(parseJitsu(workday, REDELIVERY)).toMatchObject({
      expected_delivery_from: '2031-05-07T09:00:00-05:00', expected_delivery: '2031-05-07T20:00:00-05:00' });
    const later = fixture('redelivery');
    Object.assign(later.shipment, { dropoff_earliest_ts: '2031-05-12T14:00:00.000Z', dropoff_latest_ts: '2031-05-13T01:00:00.000Z' });
    expect(parseJitsu(later, REDELIVERY)).toMatchObject({
      expected_delivery_from: '2031-05-12T09:00:00-05:00', expected_delivery: '2031-05-12T20:00:00-05:00' });
    // Without a late round the shipment's window stands.
    const onTime = fixture('redelivery');
    onTime.outbound_events.shift();
    expect(parseJitsu(onTime, REDELIVERY)).toMatchObject({ last_status_text: expect.stringContaining('confirmed'),
      expected_delivery_from: '2031-05-06T09:00:00-05:00', expected_delivery: '2031-05-06T20:00:00-05:00' });
    // A late round on a clock the tracker does not know leaves the window as it is.
    const unknownZone = fixture('redelivery');
    unknownZone.shipment.timezone = 'Mars/Olympus';
    expect(parseJitsu(unknownZone, REDELIVERY)).toMatchObject({
      expected_delivery_from: '2031-05-06T14:00:00Z', expected_delivery: '2031-05-07T01:00:00Z' });
    // Five days off in a row leave the shipment's window.
    const closed = fixture('redelivery');
    closed.no_service_dates = ['07', '08', '09', '10', '11'].map((day) => ({ key: 'X', name: 'Off', date: `2031-05-${day}`, off: true }));
    expect(parseJitsu(closed, REDELIVERY).expected_delivery).toBe('2031-05-06T20:00:00-05:00');
  });

  it('shows the window only while the parcel is on its way, before its end, and unless the shipper hides it early', () => {
    const linehaul = parseJitsu(fixture('linehaul'), LINEHAUL);
    expect(linehaul).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Package delayed beyond expected transit time', last_update: '2031-07-08T01:32:42-04:00', expected_delivery: null });
    expect(linehaul).not.toHaveProperty('expected_delivery_from');
    // A partner carrier's scans carry the town and state the tracker prints; the postcode and its ids stay behind.
    expect(linehaul.events!.map((row) => row.location ?? null)).toEqual([null, 'Sample City, OK', 'Example Town, OH', null]);
    for (const value of ['99999', 'synthetic-', 'flexport', 'Carrier.TrackingUpdated']) expect(JSON.stringify(linehaul), value).not.toContain(value);
    const future = (shipment: Reply) => Object.assign(shipment.shipment, { dropoff_earliest_ts: '2031-07-09T12:00:00Z', dropoff_latest_ts: '2031-07-10T00:00:00Z' });
    // Hidden while the parcel is with the partner carrier.
    const hidden = fixture('linehaul');
    future(hidden);
    expect(parseJitsu(hidden, LINEHAUL).expected_delivery).toBeNull();
    // Shown once Jitsu has the parcel, or when the shipper does not hide it.
    const received = fixture('linehaul');
    future(received);
    received.outbound_events.unshift(event(received, { ts: '2031-07-08T09:00:00Z', type: 'INBOUND', signal: 'RECEIVED_OK', milestone: 'In Transit',
      description: 'Your package has been received at a Jitsu facility and will be delivered soon.' }));
    expect(parseJitsu(received, LINEHAUL)).toMatchObject({ expected_delivery_from: '2031-07-09T08:00:00-04:00', expected_delivery: '2031-07-09T20:00:00-04:00' });
    const shown = fixture('linehaul');
    future(shown);
    shown.settings.hide_delivery_datetime = 'false';
    expect(parseJitsu(shown, LINEHAUL).expected_delivery).toBe('2031-07-09T20:00:00-04:00');
    // A window that ended before the newest scan, or runs backwards, is gone.
    const stale = fixture('linehaul');
    stale.settings.hide_delivery_datetime = 'false';
    expect(parseJitsu(stale, LINEHAUL).expected_delivery).toBeNull();
    const backwards = fixture('linehaul');
    backwards.settings.hide_delivery_datetime = 'false';
    Object.assign(backwards.shipment, { dropoff_earliest_ts: '2031-07-10T12:00:00Z', dropoff_latest_ts: '2031-07-09T00:00:00Z' });
    expect(parseJitsu(backwards, LINEHAUL).expected_delivery).toBeNull();
    // No window for a problem.
    const problem = fixture('redelivery');
    problem.outbound_events.unshift(event(problem, { ts: '2031-05-07T06:00:00Z', type: 'OUTBOUND', signal: 'DISPOSABLE', category: 'FAILED',
      milestone: 'Exception', description: 'We have encountered an issue with your package and will not be able to complete your delivery.' }));
    expect(parseJitsu(problem, REDELIVERY)).toMatchObject({ status: 'exception', current_stage: 'exception', expected_delivery: null });
  });

  it('stages a new plan and a failed round pickup by the scans before them', () => {
    // The first plan is the label.
    const planned = fixture('delivered');
    planned.outbound_events = [event(planned, { ts: '2031-03-08T19:45:00Z', type: 'PLANNING', signal: 'GEOCODED', description: 'Your order has been confirmed.' })];
    expect(parseJitsu(planned, DELIVERED)).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map' });
    // A round that left without a parcel the facility has: nothing moves.
    const missed = fixture('redelivery');
    missed.outbound_events.unshift(event(missed, { ts: '2031-05-07T15:00:00Z', type: 'OUTBOUND', signal: 'PICKUP_FAILED', description: 'Synthetic missed round' }));
    expect(rows(parseJitsu(missed, REDELIVERY))[0]).toEqual(['2031-05-07T10:00:00-05:00', 'OUTBOUND.PICKUP_FAILED', 'in_transit', 'none']);
    // Before the facility has it, the parcel is missing.
    const lost = fixture('linehaul');
    lost.outbound_events.unshift(event(lost, { ts: '2031-07-09T15:00:00Z', type: 'OUTBOUND', signal: 'PICKUP_FAILED', description: 'Synthetic missed round' }));
    expect(parseJitsu(lost, LINEHAUL)).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    // A notice before any movement keeps the label.
    const waiting = fixture('linehaul');
    waiting.outbound_events = [
      event(waiting, { ts: '2031-07-02T15:00:00Z', type: 'INBOUND', signal: 'MISSING', description: 'We are still waiting to receive your package at our warehouse for delivery.' }),
      waiting.outbound_events.at(-1),
    ];
    expect(parseJitsu(waiting, LINEHAUL)).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'We are still waiting to receive your package at our warehouse for delivery.' });
    // A code nobody mapped goes to the shared wording rules, or stays without a stage.
    const odd = fixture('delivered');
    odd.outbound_events.unshift(event(odd, { ts: '2031-03-13T01:00:00Z', type: 'OUTBOUND', signal: 'SYNTHETIC', description: 'Synthetic note', milestone: '' }));
    expect(parseJitsu(odd, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Synthetic note' });
    expect(parseJitsu(odd, DELIVERED).events![0]).not.toHaveProperty('stage');
    // A row without wording takes its milestone, and one without either is left out.
    const bare = fixture('delivered');
    bare.outbound_events.unshift(event(bare, { ts: '2031-03-13T01:00:00Z', type: 'OUTBOUND', signal: 'SYNTHETIC', description: '', milestone: '' }));
    bare.outbound_events.unshift(event(bare, { ts: '2031-03-13T02:00:00Z', type: 'OUTBOUND', signal: 'SYNTHETIC', description: null, milestone: 'Delivered' }));
    expect(parseJitsu(bare, DELIVERED).events!.map((row) => row.description).slice(0, 2)).toEqual(['Delivered', 'Your order was successfully delivered.']);
  });

  it('keeps only the shipment the code names, in any case, and rejects replies it cannot read', () => {
    const lower = fixture('delivered');
    expect(lower.shipment.tracking_code).toBe(DELIVERED.toLowerCase());
    expect(parseJitsu(lower, DELIVERED).status).toBe('delivered');
    expect(() => parseJitsu(fixture('delivered'), REDELIVERY)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture('delivered');
    empty.outbound_events = [];
    expect(() => parseJitsu(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const broken: Array<(shipment: Reply) => void> = [
      (shipment) => { shipment.shipment = null; },
      (shipment) => { shipment.shipment.tracking_code = null; },
      (shipment) => { shipment.shipment.tracking_code = 12345; },
      (shipment) => { shipment.outbound_events = {}; },
      (shipment) => { shipment.outbound_events = Array.from({ length: 501 }, () => shipment.outbound_events[0]); },
      (shipment) => { shipment.outbound_events[0] = 'scan'; },
      (shipment) => { shipment.outbound_events[0].signal = null; },
      (shipment) => { shipment.outbound_events[0].type = ['OUTBOUND']; },
      (shipment) => { shipment.outbound_events[0].ts = '2031-03-12T01:20:15'; },
      (shipment) => { shipment.outbound_events[0].ts = '12/03/2031'; },
      (shipment) => { shipment.outbound_events[0].ts = 1931000000000; },
      (shipment) => { shipment.outbound_events[0].description = { text: 'Delivered' }; },
      (shipment) => { shipment.outbound_events[4].attributes = ['Example City']; },
      (shipment) => { shipment.outbound_events[5].attributes.city = { name: 'Example City' }; },
    ];
    for (const [index, change] of broken.entries()) {
      const shipment = fixture('delivered');
      change(shipment);
      expect(() => parseJitsu(shipment, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], 'Not Found', { outbound_events: [] }]) {
      expect(() => parseJitsu(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes codes of four to forty letters and digits only, without a request', async () => {
    expect(normalizeJitsuNumber(' zz00-0000.0000 0001 ')).toBe(DELIVERED);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ab', 'ZZ0', 'ZZ00/0001', 'ZZ00?0001', 'ZZ00#0001', 'ZZ00_0001', 'ÄZ000001', 'Z'.repeat(41), ` ${'9'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the service’s own not-found answer as unknown and recognizes a known code, from plain HTTP', async () => {
    expect(isJitsuNotFound(notFound(ABSENT), ABSENT)).toBe(true);
    expect(isJitsuNotFound({ ...notFound(ABSENT), status: 404 }, ABSENT)).toBe(true);
    expect(isJitsuNotFound(notFound(DELIVERED), ABSENT)).toBe(false);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('redelivery')))
      .mockResolvedValueOnce(reply(notFound(ABSENT), 404)).mockResolvedValueOnce(reply(notFound(ABSENT), 404));
    await expect(carrier(fetcher).recognize!(REDELIVERY)).resolves.toEqual({ known: true, lastActivityAt: '2031-05-06T23:00:00.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Another shipment is no answer either way.
    const other = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(carrier(other).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps any other 404, and a 410, apart from a missing shipment', async () => {
    const gone = vi.fn<typeof fetch>().mockImplementation(async () => reply(notFound(ABSENT), 410));
    await expect(carrier(gone).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '{"code":404,"message":"HTTP 404 Not Found"}', '<html><body>Not Found</body></html>',
      JSON.stringify(notFound(DELIVERED)), JSON.stringify({ ...notFound(ABSENT), servlet: 'other' })]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, 404));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'transport' });
      await expect(carrier(fetcher).recognize!(ABSENT), body).rejects.toMatchObject({ kind: 'transport' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [410, 'transport'], [400, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps redirects, challenges, pages and oversized replies apart from missing shipments', async () => {
    for (const response of [() => moved('https://recipient.gojitsu.com/'), () => moved('/404', 301), () => new Response(null, { status: 307 })]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const challenge = vi.fn<typeof fetch>().mockImplementation(async () =>
      reply('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'));
    await expect(carrier(challenge).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['', '<html><head><title>Jitsu Tracking</title></head><body><div id="root"></div></body></html>', '{"shipment":']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
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

  it('routes a code to the adapter when the caller names Jitsu, which detection never offers', async () => {
    for (const number of [DELIVERED, 'ZZ0000000001', 'SCD0000Z00000000001']) {
      expect(detectCarrierMatch(number)?.carrier).not.toBe('jitsu');
      expect(recognitionAskedCarriers(number)).not.toContain('jitsu');
    }
    for (const link of [`https://recipient.gojitsu.com/${DELIVERED}`, `https://recipient.gojitsu.com/noredirect/${DELIVERED}`,
      `https://tracking.gojitsu.com/${DELIVERED.toLowerCase()}/`, `https://tracking.axlehire.com/${DELIVERED}`, `https://recipient.axlehire.com/${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: expect.stringMatching(new RegExp(`^${DELIVERED}$`, 'i')), carrier: 'jitsu', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'jitsu' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'jitsu', source: 'jitsu', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${JITSU_ENDPOINT}${DELIVERED}`)).toBe(true);
  });
});

describe('Jitsu status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    const recorded = new Set<string>();
    for (const entry of statuses.entries) {
      recorded.add(entry.code);
      const stage = 'stage' in entry ? entry.stage : undefined;
      const wording = normalizeStatusWording('wording' in entry ? entry.wording! : 'synthetic wording');
      expect(statusMap.stage(entry.code, wording), entry.code).toBe(stage);
      expect(statusMapAnswer({ carrier: 'jitsu', providerCode: entry.code, description: wording }), entry.code)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
      if (!stage) expect(jitsuQuiet(entry.code) || ['PLANNING.GEOCODED', 'OUTBOUND.PICKUP_FAILED'].includes(entry.code), entry.code).toBe(true);
    }
    for (const { code } of statusMap.gaps) expect(recorded.has(code!), code).toBe(true);
    expect(jitsuScanStage('PLANNING.GEOCODED')).toBe('registered');
    expect(jitsuStage('PLANNING.GEOCODED', 'Synthetic', { moved: true, received: true })).toBe('quiet');
    for (const code of ['constructor', 'toString', 'OUTBOUND', 'OUTBOUND.', 'outbound.dropoff_succeeded']) {
      expect(jitsuScanStage(code), code).toBeUndefined();
      expect(jitsuQuiet(code), code).toBe(false);
    }
    expect(statusMapAnswer({ carrier: 'jitsu', providerCode: null, description: 'your order was successfully delivered.' })).toEqual({ kind: 'unknown' });
  });
});
