import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { universalCarrierHints } from '../../providers/shared/hints.js';
import type { CarrierResult } from '../../core/result/index.js';
import { adapter, MAILAMERICAS_API, MailamericasTracker } from './adapter.js';
import { mailamericasWording, normalizeMailamericasNumber, parseMailamericas } from './parser.js';
import { mailamericasStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'MLAR000000002EX';
const IN_TRANSIT = 'MLCO000000001R';
const UNKNOWN = 'MLPE000000000R';
const MEXICO = 'MMXQP000000003R';
// After every fixture's scans.
const READ_AT = new Date('2026-09-01T00:00:00Z');

type Row = Record<string, unknown>;
type Shipment = Row & { events: Row[] };
type Reply = Row & { data: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
// Each scan's instant, or its wall clock where it has none, with its code.
const clocks = (result: CarrierResult) => result.events!.map((event) => [event.time ?? event.local_time, event.provider_code]);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page AWS's load balancer serves when it turns a client away.
const BALANCER = '<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n</body>\r\n</html>\r\n';

describe('MailAmericas HTTP adapter', () => {
  it('posts the whole number in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MailamericasTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' mlco 0000-00001r ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(MAILAMERICAS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ trackingNumber: IN_TRANSIT, language: 'en' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mailamericas', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the scans whose leg names their clock and stages each by its code', () => {
    const result = parseMailamericas(fixture('in-transit'), IN_TRANSIT, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Destination customs: Received by Destination Customs', last_update: '2026-05-21T09:15:00-05:00',
      expected_delivery: '2026-06-02', service_name: 'Priority', destination_country: 'CO' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      // Customs in Colombia keeps Bogotá's clock.
      ['2026-05-21T09:15:00-05:00', 'AD-1', 'customs', null],
      // The arrival, the flight and the hub keep their wall clocks.
      ['2026-05-20T23:05:00', 'AR-1', 'in_transit', null],
      ['2026-05-19T03:20:00', 'TD-4', 'in_transit', 'SMP'],
      ['2026-05-18T17:45:00', 'TD-1', 'in_transit', 'Sample City'],
      ['2026-05-18T08:30:00', 'HB-4', 'in_transit', null],
      // The origin warehouse keeps China's clock. Its repeated scan is kept once.
      ['2026-05-17T21:10:00+08:00', 'WH-3', 'in_transit', 'Sample City'],
      // A duty recorded as paid moves nothing and keeps its wall clock.
      ['2026-05-17T06:02:00', 'AD-4', null, null],
      ['2026-05-16T19:44:00+08:00', 'WH-2', 'in_transit', 'Sample City'],
      ['2026-05-16T11:30:00+08:00', 'WH-1', 'accepted', 'Sample City'],
      ['2026-05-15T14:12:00', 'SM-4', null, null],
      ['2026-05-15T14:12:00', 'OC-1', 'registered', null],
    ]);
    expect(result.events!.every((event) => (event.time === undefined) !== (event.local_time === undefined))).toBe(true);
    expect(result.events!.at(-1)).toMatchObject({ description: 'Order created: Label generated', stage_source: 'carrier_map' });
  });

  it('keeps the delivery without the buyer, the tax ID, the proof of delivery or the repeated scan', () => {
    const result = parseMailamericas(fixture('delivered'), DELIVERED, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Finished: Delivered', last_update: '2026-03-24T16:47:00-03:00', delivered_at: '2026-03-24T16:47:00-03:00',
      expected_delivery: null, service_name: 'Registered', destination_country: 'AR' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events).toHaveLength(28);
    expect(result.events!.filter((event) => !event.time).map((event) => event.provider_code))
      .toEqual(['AV-1', 'SM-4', 'AR-1', 'TD-4', 'TD-1', 'HB-3', 'HB-2', 'HB-1', 'SM-1', 'SM-2', 'OC-1']);
    expect(result.events!.at(-4)).toMatchObject({ provider_code: 'WH-1', time: '2026-03-04T11:26:00+08:00' });
    expect(result.events!.slice(0, 4).map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['PF-1', 'delivered', 'Finished: Delivered'],
      ['LM-2', 'out_for_delivery', 'Delivery office: In distribution with postman'],
      ['LM-7', 'failed_attempt', 'Delivery office: Recipient Absent'],
      ['LM-2', 'out_for_delivery', 'Delivery office: In distribution with postman'],
    ]);
    expect(result.events!.filter((event) => event.stage === undefined).map((event) => event.provider_code)).toEqual(['AV-1', 'SM-4', 'SM-1', 'SM-2']);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Buyer|Courier|Marketplace|Province)|0000000000|PR0001|SMPL02AR|Argentina|China|lastMile/);
  });

  it('takes the summary’s word for a return, a claim or a parcel held back', () => {
    const returned = parseMailamericas(changed('delivered', (data) => {
      data.status = 'returned';
      Object.assign(data.events[0]!, { code: 'PF-2', eventStep: 8, description: 'Delivered to return address' });
    }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Finished: Delivered to return address', expected_delivery: null });
    const claim = parseMailamericas(changed('in-transit', (data) => { data.status = 'claim'; }), IN_TRANSIT);
    expect(claim).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    const held = parseMailamericas(changed('in-transit', (data) => { data.isRetainedAtOrigin = true; }), IN_TRANSIT);
    expect(held).toMatchObject({ current_stage: 'exception', expected_delivery: '2026-06-02' });
    // The summary's own word that agrees with the newest scan keeps the scan's source.
    expect(parseMailamericas(changed('in-transit', (data) => { data.status = 'IN-TRANSIT'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'customs' });
  });

  it('drops the reply’s placeholders for a missing estimate, service or destination', () => {
    const result = parseMailamericas(changed('in-transit', (data) => {
      data.estimatedDelivery = '1970-01-01';
      data.service = 'N/A';
      data.destination = 'No data';
    }), IN_TRANSIT);
    expect(result.expected_delivery).toBeNull();
    expect(result).not.toHaveProperty('service_name');
    expect(result).not.toHaveProperty('destination_country');
    expect(result).not.toHaveProperty('destination_country_name');
    const named = parseMailamericas(changed('in-transit', (data) => { data.destination = 'Sampleland'; }), IN_TRANSIT);
    expect(named).toMatchObject({ destination_country_name: 'Sampleland' });
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parseMailamericas(changed('in-transit', (data) => { data.events.reverse(); }), IN_TRANSIT, READ_AT);
    expect(result).toMatchObject({ last_update: '2026-05-21T09:15:00-05:00', current_stage: 'customs' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'OC-1' });
  });

  it('dates a Mexican scan only where the recipient’s state keeps Mexico City’s clock', () => {
    // Quintana Roo keeps Cancún's clock, an hour ahead of Mexico City's: only the warehouse in China is dated.
    const cancun = parseMailamericas(fixture('mexico'), MEXICO, READ_AT);
    expect(cancun).toMatchObject({ current_stage: 'out_for_delivery', last_update: null, last_update_local: '2026-08-04T09:12:00',
      destination_country: 'MX' });
    expect(cancun.events!.filter((event) => event.time).map((event) => event.time))
      .toEqual(['2026-07-27T20:15:00+08:00', '2026-07-27T19:58:00+08:00', '2026-07-27T11:42:00+08:00']);
    const central = parseMailamericas(changed('mexico', (data) => { data.state = 'Querétaro'; }), MEXICO, READ_AT);
    expect(central).toMatchObject({ last_update: '2026-08-04T09:12:00-06:00' });
    expect(clocks(central).slice(0, 8)).toEqual([
      ['2026-08-04T09:12:00-06:00', 'LM-2'], ['2026-08-03T18:40:00-06:00', 'LM-1'], ['2026-08-02T07:05:00-06:00', 'RC-3'],
      ['2026-08-01T23:10:00-06:00', 'RC-2'], ['2026-08-01T14:20:00-06:00', 'AD-7'], ['2026-08-01T14:10:00-06:00', 'AD-3'],
      ['2026-07-31T10:00:00-06:00', 'AD-1'], ['2026-07-30T21:35:00', 'AR-1'],
    ]);
    expect(central.events!.filter((event) => !event.time).map((event) => event.provider_code)).toEqual(['AR-1', 'AD-4', 'TD-4', 'TD-1', 'OC-1']);
    // Nuevo León's border towns keep the United States' summer time, and Mexico City's clock the rest of the year.
    const northeast = (data: Shipment) => { data.state = 'Nuevo León'; };
    expect(parseMailamericas(changed('mexico', northeast), MEXICO, READ_AT))
      .toMatchObject({ last_update: null, last_update_local: '2026-08-04T09:12:00' });
    const winter = changed('mexico', (data) => {
      northeast(data);
      for (const scan of data.events) scan.date = String(scan.date).replace(/^2026-07/, '2026-12').replace(/^2026-08/, '2027-01');
    });
    expect(parseMailamericas(winter, MEXICO, new Date('2027-02-01T00:00:00Z'))).toMatchObject({ last_update: '2027-01-04T09:12:00-06:00' });
    for (const state of [null, 'Sample Province', 'Q. Roo', 'XYZ.']) {
      expect(parseMailamericas(changed('mexico', (data) => { data.state = state; }), MEXICO, READ_AT), String(state))
        .toMatchObject({ last_update: null, last_update_local: '2026-08-04T09:12:00' });
    }
    // The reply can abbreviate the state.
    for (const state of ['JAL.', 'Qro.', 'Edo. Méx.']) {
      expect(parseMailamericas(changed('mexico', (data) => { data.state = state; }), MEXICO, READ_AT), state)
        .toMatchObject({ last_update: '2026-08-04T09:12:00-06:00' });
    }
  });

  it('dates a Chilean scan with Santiago’s summer time except where the region keeps another clock', () => {
    const chile = (state: string) => changed('in-transit', (data) => { data.destination = 'Chile'; data.state = state; });
    expect(parseMailamericas(chile('Región Metropolitana de Santiago'), IN_TRANSIT, READ_AT))
      .toMatchObject({ last_update: '2026-05-21T09:15:00-04:00' });
    // Valparaíso's region includes Easter Island, two hours behind.
    expect(parseMailamericas(chile('Valparaíso'), IN_TRANSIT, READ_AT))
      .toMatchObject({ last_update: null, last_update_local: '2026-05-21T09:15:00' });
  });

  it('keeps the wall clock of an hour that summer time skips or repeats', () => {
    const result = parseMailamericas(changed('in-transit', (data) => {
      Object.assign(data, { origin: 'Spain', destination: 'Chile', state: 'Metropolitana' });
      const scan = data.events[0]!;
      data.events = [['AD-3', '2026-04-04', '23:30'], ['AD-1', '2026-04-04', '22:30'], ['WH-2', '2026-03-29', '02:30'], ['WH-1', '2026-03-28', '10:00']]
        .map(([code, date, time]) => ({ ...scan, code, date, time }));
    }), IN_TRANSIT, READ_AT);
    expect(clocks(result)).toEqual([['2026-04-04T23:30:00', 'AD-3'], ['2026-04-04T22:30:00-03:00', 'AD-1'],
      ['2026-03-29T02:30:00', 'WH-2'], ['2026-03-28T10:00:00+01:00', 'WH-1']]);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-04-04T23:30:00' });
  });

  it('keeps the wall clocks of destinations the older tracker did not place, of a domestic warehouse and of a scan after the lookup', () => {
    for (const destination of ['Ecuador', 'El Salvador', 'Uruguay', 'Costa Rica', 'Brazil']) {
      expect(parseMailamericas(changed('in-transit', (data) => { data.destination = destination; }), IN_TRANSIT, READ_AT), destination)
        .toMatchObject({ last_update: null, last_update_local: '2026-05-21T09:15:00' });
    }
    const domestic = parseMailamericas(changed('in-transit', (data) => { data.origin = 'Colombia'; }), IN_TRANSIT, READ_AT);
    expect(domestic.events!.filter((event) => event.time).map((event) => event.provider_code)).toEqual(['AD-1']);
    const early = parseMailamericas(fixture('in-transit'), IN_TRANSIT, new Date('2026-05-21T13:00:00Z'));
    expect(early).toMatchObject({ last_update: null, last_update_local: '2026-05-21T09:15:00' });
    expect(early.events!.filter((event) => event.time).map((event) => event.provider_code)).toEqual(['WH-3', 'WH-2', 'WH-1']);
  });

  it('keeps the wall clock of a warehouse scan whose reading would follow a newer dated scan', () => {
    // Bogotá is two hours behind Buenos Aires.
    const result = parseMailamericas(changed('delivered', (data) => {
      data.origin = 'Colombia';
      const [warehouse, oldest] = ['WH-3', 'WH-1'].map((code) => data.events.find((scan) => scan.code === code)!);
      data.events = [data.events[0]!, { ...warehouse, date: '2026-03-24', time: '15:00' }, oldest!];
    }), DELIVERED, READ_AT);
    expect(clocks(result)).toEqual([['2026-03-24T16:47:00-03:00', 'PF-1'], ['2026-03-24T15:00:00', 'WH-3'], ['2026-03-04T11:26:00-05:00', 'WH-1']]);
  });

  it('takes people and phone numbers out of the wording', () => {
    expect(mailamericasWording('Finished', 'Delivered by Sample Person', 'PF-1')).toBe('Finished: Delivered');
    expect(mailamericasWording('Delivery office', 'Recibido por Sample Person, DNI 00000000', 'LM-1')).toBe('Delivery office: Recibido');
    expect(mailamericasWording('Finished', 'Entregue pelo carteiro a Sample Person', 'pf-1')).toBe('Finished: Entregue');
    // Other legs name organisations, not people.
    expect(mailamericasWording('Received in destination office', 'Received by Last Mile Provider', 'RC-1'))
      .toBe('Received in destination office: Received by Last Mile Provider');
    expect(mailamericasWording('Notification', 'Call +00 (0) 000 000 0000 or 000-000-0000.', 'AV-1')).toBe('Notification: Call or.');
    // A date stays, and a line that repeats its leg is not doubled.
    expect(mailamericasWording('Notification', 'New delivery date 2026-05-20', 'AV-1')).toBe('Notification: New delivery date 2026-05-20');
    expect(mailamericasWording('Delivered', 'Delivered', 'PF-1')).toBe('Delivered');
    expect(mailamericasWording('Order created', '', 'OC-1')).toBe('Order created');
    expect(mailamericasWording('', 'Label generated', 'OC-1')).toBe('Label generated');
  });

  it('reads an unknown number as not found, a failed lookup as inconclusive and a record without scans as no history', () => {
    expect(() => parseMailamericas(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMailamericas({ error: 'Error al consultar el tracking' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMailamericas({ data: null, error: 'Error al consultar el tracking' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMailamericas(changed('delivered', (data) => { data.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseMailamericas(changed('delivered', (data) => { delete (data as Row).events; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseMailamericas(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'MailAmericas answered for another shipment' }));
    // A record filed under AliExpress's reference names nothing else.
    expect(() => parseMailamericas(changed('mexico', (data) => { data.trackingNumber = 'LP00000000000003'; }), MEXICO))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'MailAmericas answered for another shipment' }));
    expect(parseMailamericas(changed('in-transit', (data) => { data.trackingNumber = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(11);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Shipment, body: Reply) => { delete (body as Row).data; },
      (_data: Shipment, body: Reply) => { body.data = 'shipment' as never; },
      (data: Shipment) => { delete data.trackingNumber; },
      (data: Shipment) => { data.events = 'events' as never; },
      (data: Shipment) => { data.events = Array.from({ length: 501 }, () => data.events[0]!); },
      (data: Shipment) => { data.events[0] = 'scan' as never; },
      (data: Shipment) => { data.events[0]!.date = '21/05/2026'; },
      (data: Shipment) => { data.events[0]!.time = '09:15:00'; },
      (data: Shipment) => { data.events[0]!.time = '24:00'; },
      (data: Shipment) => { data.events[0]!.date = '2026-02-30'; },
      (data: Shipment) => { delete data.events[0]!.time; },
      (data: Shipment) => { data.events[0]!.description = ['Received']; },
      (data: Shipment) => { data.events[0]!.status = ''; data.events[0]!.description = null; },
      (data: Shipment) => { data.status = 7; },
    ]) {
      expect(() => parseMailamericas(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://mailamericas.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The balancer turns an address away for a few minutes after a burst of lookups.
    await expect(lookup(BALANCER, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>', { status: 403 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>window.gokuProps = {}; AwsWafIntegration.getToken()</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>MailAmericas</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    // The service's own failure, which it also gives for numbers it knows.
    await expect(lookup({ error: 'Error al consultar el tracking' }, { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number MailAmericas does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // The delivery, on Argentina's clock, dates the parcel's last activity.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-24T19:47:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ML-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers MailAmericas does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ML00000', 'SAMPLETRACKING', `ML${'0'.repeat(39)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMailamericasNumber('mlar 000-000-002 ex')).toBe(DELIVERED);
  });

  it('gives its one read the whole budget and ends a hanging read inside it', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under MailAmericas, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'mailamericas' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'mailamericas', source: 'mailamericas', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'mailamericas', source: 'mailamericas' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === MAILAMERICAS_API)).toBe(true);
  });
});

describe('MailAmericas numbers', () => {
  it('claims its own layouts, whatever the destination country', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, 'MLUY000000003EX', 'MMXQP000000004R', 'MMXQP000000005E', 'MMXQP000000006N', 'DOMC000000007R']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'mailamericas', confidence: 'high' });
    }
    for (const number of ['MLAR000000002E', 'MLAR00000002EX', 'MMXQP000000004X', 'ML000000002MH', 'DOMC000000007EX', 'DOMC00000007R', 'DOMX000000007R']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('mailamericas');
    }
  });

  it('turns the name ParcelsApp reports beside Cainiao into MailAmericas', () => {
    expect(universalCarrierHints(['MailAmericas', 'Cainiao'], 'MLPE000000001R')).toMatchObject({ discovered_carrier: 'mailamericas' });
    expect(universalCarrierHints(['Mail Americas'], 'MMXQP000000004R')).toMatchObject({ discovered_carrier: 'mailamericas' });
  });
});

describe('MailAmericas status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(mailamericasStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'mailamericas', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(mailamericasStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'mailamericas', providerCode: 'LM-7', description: 'Delivery office: Recipient Absent' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'mailamericas', providerCode: 'ZZ-9', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(mailamericasStage('PF-9', 'Finished: Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(mailamericasStage('ZZ-9', 'Synthetic note')).toBeNull();
    expect(mailamericasStage('sm-9', 'Tax ID: Delivered')).toBeNull();
    expect(mailamericasStage('pf-1', 'Finished: Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
