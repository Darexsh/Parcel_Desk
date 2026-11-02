import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NORSK_GLOBAL_API, NORSK_GLOBAL_PAGE, NORSK_GLOBAL_TOKEN, NorskGlobalTracker } from './adapter.js';
import { GO_DADDY_SECURE_CA_G2 } from './certificate.js';
import { normalizeNorskGlobalNumber, norskGlobalWording, parseNorskGlobal } from './parser.js';
import { norskGlobalScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const trusting = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('../../core/transport/https.js', () => ({ fetchTrusting: vi.fn(() => trusting) }));

const DELIVERED = 'PKG000000000001';
const IN_TRANSIT = 'NOR0000GB00000000001';
const UNKNOWN = 'PKG000000000000';
// The USPS package number inside the delivered fixture's routing barcode.
const PIC = '9210090000000012345679';
const LANDMARK = 'LTN000000001N1';
const TOKEN = 'SAMPLETOKEN00000';
const FRESH = 'FRESHTOKEN000000';
const LOOKUP = `${NORSK_GLOBAL_API}/${NORSK_GLOBAL_TOKEN}/tracking`;

type Row = Record<string, unknown>;
type Shipment = Row & { narrative: Row[]; destination: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment[];
const changed = (name: string, change: (shipment: Shipment, reply: Shipment[]) => void) => {
  const reply = fixture(name);
  change(reply[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const refused = () => new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } });
// The page's server components, with the settings of another site on the tracker before Norsk's own.
const page = (token: string) => new Response(['0:["$","$L1",null,{}]',
  `5:{"clients":[{"_key":"other","_id":"clients/other","clientToken1":"OTHERSITE0000000"},{"_key":"norsk","_id":"clients/norsk","siteName":"norsk","clientToken1":"${token}","color4":"#000"}]}`,
  ''].join('\n'), { headers: { 'Content-Type': 'text/x-component' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Norsk Global HTTP adapter', () => {
  it('posts the whole reference in capitals to the tracker’s lookup once, under the site’s client token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NorskGlobalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', token: TOKEN })
      .fetch(' nor0000-gb 00000000001 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${NORSK_GLOBAL_API}/${TOKEN}/tracking`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ reference: IN_TRANSIT, userToken: [] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'norsk-global', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    const delivered = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await carrier(delivered).track({ number: DELIVERED });
    expect(String(delivered.mock.calls[0]![0])).toBe(LOOKUP);
  });

  it('keeps a delivery and its hand-off to USPS without the recipient, the signatory or the repeated scan', () => {
    const result = parseNorskGlobal(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-05-19T14:02:00', expected_delivery: null,
      delivery_carrier: 'usps', delivery_tracking_number: PIC, destination_country: 'US' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-05-19T14:02:00', 'Delivered', 'SAMPLE CITY US', 'delivered'],
      ['2026-05-19T07:40:00', 'Out for delivery', 'SAMPLE CITY US', 'out_for_delivery'],
      ['2026-05-17T22:15:00', 'Arrived at USPS regional facility', 'SAMPLE HUB US', 'in_transit'],
      ['2026-05-15T03:30:00', 'Handed over to USPS', 'SAMPLE GATEWAY US', 'accepted'],
      ['2026-05-13T11:05:00', 'Customs cleared. Call with questions.', 'SAMPLE GATEWAY US', 'in_transit'],
      ['2026-05-12T18:20:00', 'Departed hub', 'SAMPLE HUB GB', 'in_transit'],
      ['2026-05-11T09:12:00', 'Received at hub.', 'SAMPLE HUB GB', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The routing barcode's ZIP code, the people, the depot's address and the phone number never come through.
    expect(JSON.stringify(result)).not.toMatch(/SIGNER|Recipient|example\.com|\+00|SAMPLE0001|United States|420000009/);
    expect(deliveryHandoff('norsk-global', DELIVERED, result)).toEqual({ carrier: 'usps', number: PIC, basis: 'partner' });
  });

  it('reads offsets as instants and turns an oldest-first history round', () => {
    const result = parseNorskGlobal(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In transit to bpost',
      last_update: '2026-06-02T09:10:00+02:00', delivery_carrier: 'landmark-global', delivery_tracking_number: LANDMARK,
      destination_country: 'BE' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.stage])).toEqual([
      ['2026-06-02T09:10:00+02:00', 'SAMPLE TOWN BE', 'in_transit'],
      ['2026-06-02T06:30:00+02:00', 'SAMPLE TOWN BE', 'in_transit'],
      ['2026-06-01T17:45:00+01:00', 'SAMPLE HUB GB', 'accepted'],
      ['2026-06-01T10:00:00Z', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
  });

  it('takes the shipment’s proof of delivery over its newest scan, and only a delivery or a return from its wording', () => {
    const pod = parseNorskGlobal(changed('delivered', (shipment) => { shipment.narrative.shift(); }), DELIVERED);
    expect(pod).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Out for delivery' });
    const returned = parseNorskGlobal(changed('in-transit', (shipment) => { shipment.statusDescription = 'Returned to sender'; }), IN_TRANSIT);
    expect(returned).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map' });
    const worded = parseNorskGlobal(changed('delivered', (shipment) => { shipment.statusDescription = 'Out for delivery'; }), DELIVERED);
    expect(worded).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language' });
    const unstaged = parseNorskGlobal(changed('in-transit', (shipment) => {
      shipment.statusDescription = null;
      shipment.narrative = [{ timeStamp: '2026-06-01T10:00:00', message: 'Synthetic note', location: '' }];
    }), IN_TRANSIT);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note', last_update_local: '2026-06-01T10:00:00' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('reads the older tracker’s status changes, its code included', () => {
    const result = parseNorskGlobal(changed('delivered', (shipment) => {
      shipment.narrative = [
        { timeStamp: '2026-05-19T14:02:00', message: '2026-05-19 14:02:00 Status changed to: POD', location: '' },
        { timeStamp: '2026-05-17T22:15:00', message: '2026-05-17 22:15:00 Status changed to: Item in transit with Carrier', location: 'SAMPLE COUNTRY' },
        { timeStamp: '2026-05-11T09:12:00', message: '2026-05-11 09:12:00 Status changed to: Label created', location: '' },
      ];
    }), DELIVERED);
    expect(result.events!.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['Status changed to: POD', 'delivered', 'carrier_map'],
      ['Status changed to: Item in transit with Carrier', 'in_transit', 'wording:language'],
      ['Status changed to: Label created', 'registered', 'wording:language'],
    ]);
    expect(result).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map' });
  });

  it('names the partner as the page’s links do, and keeps only a partner number of its own', () => {
    const partner = (agentName: unknown, trackingNumber: unknown = LANDMARK) => {
      const result = parseNorskGlobal(changed('in-transit', (shipment) => Object.assign(shipment, { agentName, trackingNumber })), IN_TRANSIT);
      return [result.delivery_carrier ?? null, result.delivery_tracking_number ?? null];
    };
    expect(partner('DHL')).toEqual(['dhl-express', LANDMARK]);
    expect(partner('USPS')).toEqual(['usps', LANDMARK]);
    expect(partner('UK MAIL LIMITED')).toEqual(['dhl-ecommerce-uk', LANDMARK]);
    expect(partner('Evri')).toEqual(['evri-uk', LANDMARK]);
    expect(partner('Royal Mail')).toEqual(['royal-mail', LANDMARK]);
    // Norsk itself or a courier the catalog does not know names no partner.
    expect(partner('Norsk')).toEqual([null, LANDMARK]);
    expect(partner('Sample Local Courier')).toEqual([null, LANDMARK]);
    expect(partner(null, null)).toEqual([null, null]);
    // The page links only a partner number longer than nine characters, and the shipment's own is not a partner's.
    expect(partner('DHL', 'SHORT0001')).toEqual(['dhl-express', null]);
    expect(partner('DHL', IN_TRANSIT.toLowerCase())).toEqual(['dhl-express', null]);
    expect(partner('USPS', '420000009210090000000012345670')).toEqual(['usps', null]);
  });

  it('keeps the destination’s code or name only', () => {
    const where = (destination: unknown) => {
      const result = parseNorskGlobal(changed('in-transit', (shipment) => { shipment.destination = destination as Row; }), IN_TRANSIT);
      return [result.destination_country ?? null, result.destination_country_name ?? null];
    };
    expect(where({ isoName: 'us', country: 'Sampleland' })).toEqual(['US', null]);
    expect(where({ isoName: null, country: 'Sampleland' })).toEqual([null, 'Sampleland']);
    expect(where({ zipcode: '0000' })).toEqual([null, null]);
    expect(where(null)).toEqual([null, null]);
  });

  it('caps a long history and keeps one copy of a scan that repeats', () => {
    const scans = Array.from({ length: 101 }, (_, minute) => ({
      timeStamp: `2026-06-01T${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`,
      message: 'Departed hub', location: 'SAMPLE HUB GB',
    })).reverse();
    const long = parseNorskGlobal(changed('in-transit', (shipment) => { shipment.narrative = [...scans, scans[0]!]; }), IN_TRANSIT);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ history_truncated: true, last_update_local: '2026-06-01T11:40:00' });
  });

  it('takes the clock, people, e-mail addresses and phone numbers out of the wording', () => {
    expect(norskGlobalWording('2026-05-19 14:02:00 Delivered - Signed for by SAMPLE PERSON')).toBe('Delivered');
    expect(norskGlobalWording('19/05/2026 14:02:00 Delivered, received by SAMPLE PERSON at the door')).toBe('Delivered');
    expect(norskGlobalWording('Signed for by SAMPLE PERSON')).toBe('Delivered');
    expect(norskGlobalWording('POD')).toBe('POD');
    // Other scans name depots and partners, not people.
    expect(norskGlobalWording('Received by partner depot')).toBe('Received by partner depot');
    expect(norskGlobalWording('Held at depot. Please send it to holdcage@example.com.')).toBe('Held at depot.');
    expect(norskGlobalWording('Card left, call +00 (0) 000 000 0000')).toBe('Card left, call');
    // A date stays.
    expect(norskGlobalWording('New delivery date 2026-05-20')).toBe('New delivery date 2026-05-20');
    expect(norskGlobalWording('2026-05-19 14:02:00')).toBe('');
  });

  it('reads an empty reply as not found and a shipment without scans as no history', () => {
    expect(() => parseNorskGlobal(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNorskGlobal(changed('delivered', (shipment) => { shipment.narrative = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseNorskGlobal(changed('delivered', (shipment) => { delete (shipment as Row).narrative; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when its own reference is the one asked', () => {
    expect(() => parseNorskGlobal(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Norsk Global answered for another reference' }));
    // The tracker also finds a shipment by its partner's number, which is not Norsk's own.
    expect(() => parseNorskGlobal(fixture('in-transit'), LANDMARK))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Norsk Global found the shipment by its partner\'s number' }));
    expect(parseNorskGlobal(changed('in-transit', (shipment) => { shipment.hawb = ' nor0000gb 00000000001 '; }), IN_TRANSIT).events)
      .toHaveLength(4);
    const both = [...fixture('delivered'), ...fixture('in-transit')];
    expect(parseNorskGlobal(both, IN_TRANSIT)).toMatchObject({ delivery_carrier: 'landmark-global' });
    expect(parseNorskGlobal([...fixture('in-transit'), ...fixture('in-transit')], IN_TRANSIT).events).toHaveLength(4);
    expect(() => parseNorskGlobal([...fixture('in-transit'), ...changed('in-transit', (shipment) => { shipment.statusDescription = 'POD'; })],
      IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Shipment[]) => { body.length = 0; body.push('shipment' as never); },
      (_shipment: Shipment, body: Shipment[]) => { body.push(...Array.from({ length: 50 }, () => body[0]!)); },
      (shipment: Shipment) => { shipment.hawb = { id: IN_TRANSIT }; },
      (shipment: Shipment) => { shipment.narrative = 'scans' as never; },
      (shipment: Shipment) => { shipment.narrative = Array.from({ length: 501 }, () => shipment.narrative[0]!); },
      (shipment: Shipment) => { shipment.narrative[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.narrative[0]!.timeStamp = '01/06/2026 10:00'; },
      (shipment: Shipment) => { shipment.narrative[0]!.timeStamp = '2026-06-01T24:00:00Z'; },
      (shipment: Shipment) => { shipment.narrative[0]!.timeStamp = '2026-02-30T10:00:00'; },
      (shipment: Shipment) => { shipment.narrative[0]!.timeStamp = '0001-01-01T00:00:00'; },
      (shipment: Shipment) => { delete shipment.narrative[0]!.timeStamp; },
      (shipment: Shipment) => { shipment.narrative[0]!.message = ['Received']; },
      (shipment: Shipment) => { shipment.narrative[0]!.message = '2026-06-01 10:00:00'; },
      (shipment: Shipment) => { shipment.narrative[0]!.location = { name: 'SAMPLE HUB GB' }; },
      (shipment: Shipment) => { shipment.statusDescription = { code: 'POD' }; },
      (shipment: Shipment) => { shipment.agentName = ['DHL']; },
      (shipment: Shipment) => { shipment.destination = 'Belgium' as never; },
    ]) {
      expect(() => parseNorskGlobal(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [{}, 'shipments', null]) {
      expect(() => parseNorskGlobal(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker reads an unknown reference from an empty 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://portal.norsk-global.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Norsk Global</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads the client token the page gives now when the lookup refuses the one it has, and keeps it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockResolvedValueOnce(page(FRESH))
      .mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('in-transit')));
    const tracker = carrier(fetcher);
    await expect(tracker.track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(tracker.track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([LOOKUP, NORSK_GLOBAL_PAGE,
      `${NORSK_GLOBAL_API}/${FRESH}/tracking`, `${NORSK_GLOBAL_API}/${FRESH}/tracking`]);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'GET', redirect: 'manual', headers: { RSC: '1', Accept: 'text/x-component' } });
  });

  it('reads the page over the global fetch trusting the intermediate it leaves out, and a host’s own fetcher as given', async () => {
    const global = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockResolvedValueOnce(reply(fixture('delivered')));
    trusting.mockImplementation(async () => page(FRESH));
    vi.stubGlobal('fetch', global);
    try {
      await expect(new NorskGlobalTracker().fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(global.mock.calls.map(([url]) => String(url))).toEqual([LOOKUP, `${NORSK_GLOBAL_API}/${FRESH}/tracking`]);
    expect(trusting.mock.calls.map(([url]) => String(url))).toEqual([NORSK_GLOBAL_PAGE]);
    expect(fetchTrusting).toHaveBeenCalledWith([GO_DADDY_SECURE_CA_G2]);
    const own = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockResolvedValueOnce(page(FRESH))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(createTracker({ fetcher: own, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'norsk-global' }))
      .resolves.toMatchObject({ source: 'norsk-global' });
    expect(own).toHaveBeenCalledTimes(3);
    expect(trusting).toHaveBeenCalledTimes(1);
  });

  it('reports a token the lookup keeps refusing, or a page that no longer gives one, as a changed tracker', async () => {
    const track = (...responses: Response[]) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const response of responses) fetcher.mockResolvedValueOnce(response);
      return carrier(fetcher).track({ number: DELIVERED });
    };
    await expect(track(refused(), page(NORSK_GLOBAL_TOKEN))).rejects.toMatchObject({ kind: 'schema' });
    await expect(track(refused(), page(FRESH), refused())).rejects.toMatchObject({ kind: 'schema' });
    await expect(track(refused(), new Response('0:["$","html",null,{}]\n'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(track(refused(), new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(refused(), new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(track(refused(), new Response('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known reference and the unknown-reference answer, and asks nothing for one Norsk does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('in-transit'))).mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    // Local clocks date the parcel's last activity without an instant; offsets give one.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-19T14:02:00' });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-06-02T07:10:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(LANDMARK)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('PKG000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects references Norsk does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['PKG000000', 'SAMPLETRACKING', '0'.repeat(41), `PKG${' '.repeat(62)}000000000001`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeNorskGlobalNumber('pkg 000-000-000-001')).toBe(DELIVERED);
  });

  it('gives its read the whole budget and ends a hanging read inside it', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a reference filed under Norsk Global, or detected as one of its own, to the adapter', async () => {
    // Recognition asks a day after the delivery on Norsk Global's local clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z'));
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === LOOKUP
        ? reply(fixture('delivered')) : new Response('', { status: 404 }));
      const tracker = createTracker({ fetcher, providers: [], env: {} });
      await expect(tracker.track({ number: DELIVERED, carrier: 'norsk-global' }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'norsk-global', source: 'norsk-global', result: { current_stage: 'delivered' } });
      await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'norsk-global', source: 'norsk-global' });
      expect(fetcher.mock.calls.some(([url]) => String(url) === LOOKUP)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Norsk Global numbers', () => {
  it('suggests Norsk for its PKG references only', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['norsk-global'] });
    for (const number of ['PKG00000000001', 'PKG0000000000001', 'PKX000000000001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('norsk-global');
    }
  });
});

describe('Norsk Global status vocabulary', () => {
  it('records every code and wording it stages with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (entry.code) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
        continue;
      }
      expect(norskGlobalScanStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'norsk-global', providerCode: 'POD', description: 'Delivered - Signed by' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'norsk-global', description: 'Status changed to: POD' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'norsk-global', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(norskGlobalScanStage('Synthetic note')).toBeNull();
  });
});
