import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { accepted } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { recognitionAskedCarriers, recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SAIA_API, SAIA_API_KEY, SAIA_CIPHER_KEY, saiaEncryptedPro, SaiaTracker } from './adapter.js';
import { isSaiaNotFound, normalizeSaiaNumber, normalizeSaiaRecognitionNumber, parseSaia, saiaPro, saiaTrackingUrl } from './parser.js';
import { saiaShipmentStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = '99900000010';
const DELIVERED = '99900000020';
const INTERLINE = '99900000030';
const ABSENT = '99999999990';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const notFound = (pro: string) => ({ error: `The Shipment was not found for PRO Number: ${pro}` });
const SESSION = [['Set-Cookie', '_trackingCSRF=synthetic-csrf; Path=/; HttpOnly'], ['Set-Cookie', 'tracking-xsrf-token=synthetic-xsrf; Path=/'],
  ['Set-Cookie', 'TS0000test=synthetic-f5; Path=/'], ['Set-Cookie', '__cf_bm=synthetic-edge; path=/; HttpOnly; Secure']] as const;
const surf = (cookies: readonly (readonly [string, string])[] = SESSION) => new Response('', { status: 200, headers: [...cookies] as [string, string][] });
const reply = (body: unknown, status = 200, type = 'application/json; charset=utf-8') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const BLOCK_PAGE = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';
/** A transport answering the session read, then each details read with the next reply. */
const service = (...details: Array<() => Response>) => {
  let index = 0;
  return vi.fn<typeof fetch>(async (input) => {
    if (String(input).endsWith('/surf')) return surf();
    const next = details[Math.min(index, details.length - 1)]!;
    index += 1;
    return next();
  });
};
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
/** The PRO a details request carries, decrypted as Saia's service reads it. */
function sentPro(url: string): string {
  const value = new URL(url).searchParams.get('proNumber')!;
  const [sealed, iv] = Buffer.from(value, 'base64').toString('latin1').split(':').map((part) => Buffer.from(decodeURIComponent(part), 'base64'));
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(SAIA_CIPHER_KEY, 'utf8'), iv!);
  return Buffer.concat([decipher.update(sealed!), decipher.final()]).toString('utf8');
}

describe('Saia tracking adapter', () => {
  it('opens a tracking session, then asks for the encrypted PRO with its XSRF token, cookies and the tracker’s key', async () => {
    const fetcher = service(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SaiaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 999-0000-0010 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[session, sessionInit], [details, detailsInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(session).toBe(`${SAIA_API}/surf`);
    expect(sessionInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(sessionInit.headers).get('user-agent')).toBe('SyntheticHost/1.0');
    expect(new Headers(sessionInit.headers).has('cookie')).toBe(false);
    expect(details.startsWith(`${SAIA_API}/find-full-details?proNumber=`)).toBe(true);
    expect(details).not.toContain(IN_TRANSIT);
    expect(sentPro(details)).toBe(IN_TRANSIT);
    expect(detailsInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(detailsInit.body).toBeUndefined();
    const headers = new Headers(detailsInit.headers);
    expect(Object.fromEntries(headers)).toMatchObject({ 'user-agent': 'SyntheticHost/1.0', 'content-type': 'application/json',
      'xsrf-token': 'synthetic-xsrf', 'x-api-key': SAIA_API_KEY,
      cookie: '_trackingCSRF=synthetic-csrf; tracking-xsrf-token=synthetic-xsrf; TS0000test=synthetic-f5; __cf_bm=synthetic-edge' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'saia', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    // A fresh IV each time, so the same PRO never repeats a value.
    expect(saiaEncryptedPro(IN_TRANSIT)).not.toBe(saiaEncryptedPro(IN_TRANSIT));
    expect(saiaEncryptedPro('00000000000', new Uint8Array(16))).toBe(saiaEncryptedPro('00000000000', new Uint8Array(16)));
  });

  it('reads the history newest first on each terminal’s own clock, with the terminals’ cities and the estimate’s window', () => {
    expect(parseSaia(fixture('in-transit'), IN_TRANSIT)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at Destination Terminal', last_update: null, last_update_local: '2031-04-16T23:07:00',
      expected_delivery: '2031-04-17 09:30–13:45', weight_kg: 544.311,
      events: [
        { local_time: '2031-04-16T23:07:00', description: 'Arrived at Destination Terminal', provider_code: 'Arrived at Destination Terminal',
          location: 'Example City, OH', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2031-04-16T12:52:00', description: 'Departed from Terminal', provider_code: 'Departed from Terminal',
          location: 'Sample Hub, TN', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2031-04-15T03:18:00', description: 'Arrived at Breakbulk Terminal', provider_code: 'Arrived at Breakbulk Terminal',
          location: 'Sample Hub, TN', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2031-04-14T21:41:00', description: 'Departed from Terminal', provider_code: 'Departed from Terminal',
          location: 'Origin Town, GA', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2031-04-14T18:26:00', description: 'Arrived at Origin Terminal', provider_code: 'Arrived at Origin Terminal',
          location: 'Origin Town, GA', stage: 'in_transit', stage_source: 'carrier_map' },
        // The shipper's own town stays behind.
        { local_time: '2031-04-14T16:59:00', description: 'Depart from Customer Location', provider_code: 'Depart from Customer Location',
          stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2031-04-14T12:13:00', description: 'Pickup from Customer', provider_code: 'Pickup from Customer',
          stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
  });

  it('takes the delivery from the shipment’s status and reads nothing about the parties, references or signature', () => {
    const result = parseSaia(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      // The history ends with the delivery run; the status the page shows is newer.
      last_status_text: 'Delivered', last_update_local: '2031-11-04T07:48:00', expected_delivery: null, weight_kg: 206.611 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![0]).toMatchObject({ provider_code: 'Dispatched for Delivery', location: 'Example City, TX', stage: 'out_for_delivery' });
    for (const name of ['in-transit', 'delivered', 'interline']) {
      const text = JSON.stringify(parseSaia(fixture(name), fixture(name).proNumber));
      for (const value of ['Example Shipper', 'Example Consignee', 'Sample Road', 'Sample Avenue', 'Sample Street', 'Shipper Town',
        'Consignee Town', 'Dock', 'Suite', 'SYNTH', 'Synthetic goods', 'SIGNER', 'Manager', 'City Terminal', 'Town Terminal', 'Way', '555', '800000', '0000',
        'Example Partner', 'PPD', '990', 'EXA', 'SMP', '13:22']) {
        expect(text, `${name}: ${value}`).not.toContain(value);
      }
    }
  });

  it('keeps a partner’s pickup and Canadian terminals in the service’s order, once each, without rows the page hides', () => {
    const result = parseSaia(fixture('interline'), INTERLINE);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departed from Terminal',
      last_update_local: '2031-02-20T14:14:00', expected_delivery: null, weight_kg: 353.802 });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.location ?? null, event.stage])).toEqual([
      ['2031-02-20T14:14:00', 'Departed from Terminal', 'Border Town, NY', 'in_transit'],
      ['2031-02-19T05:02:00', 'Arrived at Breakbulk Terminal', 'Example Ville, ON', 'in_transit'],
      ['2031-02-18T23:39:00', 'Departed from Terminal', 'Example Ville, ON', 'in_transit'],
      // Not resorted: an earlier clock in another terminal's zone keeps its place.
      ['2031-02-18T21:57:00', 'Arrived at Breakbulk Terminal', 'Sample Ville, PQ', 'in_transit'],
      ['2031-02-17T18:21:00', 'Departed from Terminal', 'Sample Ville, PQ', 'in_transit'],
      ['2031-02-17T12:00:00', 'Pickup Complete', null, 'accepted'],
    ]);
  });

  it('shows the estimate the page shows until the freight is delivered or returned, while it is not stale', () => {
    const shipment = (status: string, date: unknown, window: unknown = { from: '09:30', to: '13:45' }) => {
      const reply = fixture('in-transit');
      Object.assign(reply.shipmentInformation, { status });
      Object.assign(reply.deliveryInformation, { expectedDeliveryDate: date, expectedDeliveryTime: window });
      return parseSaia(reply, IN_TRANSIT).expected_delivery;
    };
    expect(shipment('Out for Delivery', '2031-04-17')).toBe('2031-04-17 09:30–13:45');
    expect(shipment('In Transit', '2031-04-16')).toBe('2031-04-16 09:30–13:45');
    expect(shipment('In Transit', '2031-04-17', { from: '09:30', to: '' })).toBe('2031-04-17 09:30');
    expect(shipment('In Transit', '2031-04-17', { from: '13:45', to: '09:30' })).toBe('2031-04-17 13:45');
    for (const window of ['', { from: 'All Day Appointment', to: '' }, { from: '24:00', to: '' }, null]) {
      expect(shipment('In Transit', '2031-04-17', window), JSON.stringify(window)).toBe('2031-04-17');
    }
    // A day before the newest scan, the customer-service notice and anything but a date leave none.
    for (const date of ['2031-04-15', 'Contact Customer Service 800-765-7242', 'For Appointments Call: 1 (800) 456-7296', 'N/A', '2031-02-30', '', null]) {
      expect(shipment('In Transit', date), String(date)).toBeNull();
    }
    expect(shipment('Delivered', '2031-04-17')).toBeNull();
    expect(shipment('Returned to Shipper', '2031-04-17')).toBeNull();
  });

  it('stages by the shipment’s status, else by the newest scan the map or the wording rules know', () => {
    const staged = (status: string, rows?: (history: Reply[]) => Reply[]) => {
      const reply = fixture('in-transit');
      reply.shipmentInformation.status = status;
      if (rows) reply.history = rows(reply.history);
      return parseSaia(reply, IN_TRANSIT);
    };
    expect(staged('Returned to Shipper')).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to Shipper' });
    expect(staged('Contact Customer Service 800-765-7242')).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Contact Customer Service 800-765-7242' });
    expect(staged('Appointment Set')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Arrived at Destination Terminal' });
    expect(staged('Reconsigned')).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at Destination Terminal' });
    expect(staged('', (history) => history.slice(5))).toMatchObject({ status: 'in_transit', current_stage: 'accepted',
      last_status_text: 'Depart from Customer Location' });
    // An activity nobody mapped goes to the shared wording rules, or stays without a stage.
    const odd = staged('', (history) => [{ ...history[0], activity: 'Synthetic note', city: 'Nowhere' }, ...history]);
    expect(odd).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
    expect(odd.events![0]).toEqual({ local_time: '2031-04-16T23:07:00', description: 'Synthetic note', provider_code: 'Synthetic note' });
    const worded = staged('', (history) => [{ ...history[0], activity: 'Delivered' }, ...history]);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/),
      expected_delivery: null });
    expect(worded.events![0]).not.toHaveProperty('location');
    expect(staged('Synthetic status', () => [{ activity: 'Synthetic note', date: '2031-04-16', time: '', city: '', state: '' }]))
      .toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note', last_update_local: '2031-04-16' });
    // A status without history is a summary; neither is no history.
    expect(staged('In Transit', () => [])).toMatchObject({ status: 'in_transit', summary_only: true, last_status_text: 'In Transit',
      last_update_local: null, events: [] });
    expect(() => staged('', () => [])).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => staged('Synthetic status', () => [{ activity: '' }])).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the page’s twelve-hour clocks and keeps a row the service could not date', () => {
    const clock = (time: string, date = '2031-04-16') => {
      const reply = fixture('in-transit');
      Object.assign(reply.history[0], { time, date });
      return parseSaia(reply, IN_TRANSIT).events![0]!.local_time;
    };
    expect(clock('12:01 am')).toBe('2031-04-16T00:01:00');
    expect(clock('12:30 PM')).toBe('2031-04-16T12:30:00');
    expect(clock('01:05pm')).toBe('2031-04-16T13:05:00');
    expect(clock('')).toBe('2031-04-16');
    expect(clock('11:00 pm', 'Invalid date')).toBeUndefined();
    for (const [time, date] of [['00:30 am', '2031-04-16'], ['13:00 pm', '2031-04-16'], ['23:00', '2031-04-16'], ['9:00 am', '2031-04-16'],
      ['11:00 pm', '2031-02-30'], ['11:00 pm', '04/16/2031']]) {
      expect(() => clock(time!, date), `${date} ${time}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps only the shipment the PRO names and rejects replies it cannot read', () => {
    expect(() => parseSaia(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const broken: Array<(reply: Reply) => void> = [
      (reply) => { delete reply.proNumber; },
      (reply) => { reply.proNumber = 99900000010; },
      (reply) => { reply.shipmentInformation = null; },
      (reply) => { reply.deliveryInformation = 'N/A'; },
      (reply) => { reply.shipmentInformation.status = { text: 'In Transit' }; },
      (reply) => { reply.history = {}; },
      (reply) => { reply.history = Array.from({ length: 501 }, () => reply.history[0]); },
      (reply) => { reply.history[0] = 'scan'; },
      (reply) => { reply.history[0].activity = ['Departed from Terminal']; },
      (reply) => { reply.history[0].city = { name: 'Example City' }; },
      (reply) => { reply.history[0].time = 1107; },
      (reply) => { reply.deliveryInformation.expectedDeliveryDate = 20310417; },
    ];
    for (const [index, change] of broken.entries()) {
      const reply = fixture('in-transit');
      change(reply);
      expect(() => parseSaia(reply, IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], 'Not Found', notFound(IN_TRANSIT)]) {
      expect(() => parseSaia(payload, IN_TRANSIT), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // An unreadable weight is left out.
    for (const weight of ['', '0', 'N/A', '-5']) {
      const reply = fixture('in-transit');
      reply.shipmentInformation.totalWeight = weight;
      expect(parseSaia(reply, IN_TRANSIT), weight).not.toHaveProperty('weight_kg');
    }
    // A long history keeps its newest hundred rows.
    const long = fixture('in-transit');
    long.history = Array.from({ length: 120 }, (_, index) => ({ ...long.history[1], time: `${String(Math.floor(index / 60) + 1).padStart(2, '0')}:${String(index % 60).padStart(2, '0')} pm` }));
    expect(parseSaia(long, IN_TRANSIT)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseSaia(long, IN_TRANSIT).events).toHaveLength(100);
  });

  it('takes eleven or twelve digits and looks up the first eleven, as the tracker does', async () => {
    expect(normalizeSaiaNumber(' 999 0000 0010 ')).toBe(IN_TRANSIT);
    expect(saiaPro(`${IN_TRANSIT}4`)).toBe(IN_TRANSIT);
    expect(saiaTrackingUrl(`${IN_TRANSIT}4`)).toBe(`https://www.saia.com/track/details;pro=${IN_TRANSIT}`);
    const fetcher = service(() => reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: `${IN_TRANSIT}4` }))
      .resolves.toMatchObject({ current_stage: 'in_transit', canonical_tracking_number: IN_TRANSIT });
    expect(sentPro(String(fetcher.mock.calls[1]![0]))).toBe(IN_TRANSIT);
    expect(parseSaia(fixture('in-transit'), IN_TRANSIT)).not.toHaveProperty('canonical_tracking_number');
    // Recognition takes the eleven digits a reply binds as a whole.
    await expect(carrier(fetcher).recognize!(`${IN_TRANSIT}4`)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const idle = vi.fn<typeof fetch>();
    for (const number of ['', '9990000001', '9990000001000', 'S9900000010', '99900000010A', '999/00000010', ` ${'9'.repeat(70)}`]) {
      await expect(carrier(idle).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(idle).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(idle).not.toHaveBeenCalled();
  });

  it('reads the service’s own notice for this PRO as not found and recognizes a known PRO', async () => {
    expect(isSaiaNotFound(notFound(ABSENT), ABSENT)).toBe(true);
    expect(isSaiaNotFound(notFound(IN_TRANSIT), ABSENT)).toBe(false);
    expect(isSaiaNotFound({ ...notFound(ABSENT), status: 422 }, ABSENT)).toBe(false);
    const fetcher = service(() => reply(fixture('interline')), () => reply(notFound(ABSENT), 422), () => reply(notFound(ABSENT), 422));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(INTERLINE)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2031-02-20T14:14:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(6);
    // Another PRO's notice, another 422 and another shipment are no answer either way.
    for (const body of [notFound(IN_TRANSIT), { error: 'Something went wrong' }, { errors: { query: { msg: 'Invalid Request.' } } }]) {
      const other = service(() => reply(body, 422));
      await expect(carrier(other).track({ number: ABSENT }), JSON.stringify(body)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const another = service(() => reply(fixture('delivered')));
    await expect(carrier(another).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps the firewall’s block, challenges, a refused session and other failures apart from a missing shipment', async () => {
    const cases: Array<[() => Response, string]> = [
      [() => reply(BLOCK_PAGE, 403, 'text/html'), 'challenge'],
      [() => reply('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>', 200, 'text/html'), 'challenge'],
      [() => reply(BLOCK_PAGE, 422, 'text/html'), 'challenge'],
      [() => reply('{"error":"Unauthorized Access Detected"}', 401), 'indeterminate'],
      [() => reply('{"errors":{"query":{"msg":"Invalid Request."}}}', 400), 'transport'],
      [() => reply('', 429), 'rate_limited'],
      [() => reply('', 500), 'indeterminate'],
      [() => reply('', 503), 'maintenance'],
      [() => new Response(null, { status: 302, headers: { Location: 'https://www.saia.com/' } }), 'indeterminate'],
      [() => reply('<html><body>Saia</body></html>', 200, 'text/html'), 'schema'],
      [() => reply('{"proNumber":'), 'schema'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = service(response);
      const error = await carrier(fetcher).track({ number: ABSENT }).catch((caught: unknown) => caught);
      expect(error, `${kind} ${response().status}`).toMatchObject({ kind });
      // The session's cookies and token stay out of the failure.
      expect((error as { request?: unknown }).request, kind).toBeUndefined();
      expect(JSON.stringify(error), kind).not.toContain('synthetic-xsrf');
      expect(fetcher, kind).toHaveBeenCalledTimes(2);
    }
    // A session read without its XSRF cookie, or refused, opens no lookup.
    for (const response of [() => surf([]), () => reply(BLOCK_PAGE, 403, 'text/html'), () => reply('', 500)]) {
      const fetcher = vi.fn<typeof fetch>(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:indeterminate|challenge)$/) });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const large = service(() => new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: IN_TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more in a new session when Saia cannot be reached, inside the caller’s budget', async () => {
    // Cloudflare's origin DNS error: the request never reached Saia.
    const unreachable = () => reply('{"title":"Error 1016: Origin DNS error","status":530}', 530);
    const recovered = service(unreachable, () => reply(fixture('delivered')));
    await expect(carrier(recovered).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(recovered.mock.calls.map(([url]) => String(url).split('?')[0]!.split('/').pop())).toEqual(['surf', 'find-full-details', 'surf', 'find-full-details']);
    const down = vi.fn<typeof fetch>(async () => unreachable());
    await expect(carrier(down).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    expect(down).toHaveBeenCalledTimes(2);
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(async (input) =>
      String(input).endsWith('/surf') ? surf() : reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(3);
    const immediate = service(() => reply(fixture('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('suggests Saia for a checked twelve-digit PRO without asking recognition, which answers only eleven digits', async () => {
    // The first ten digits leave 2 when divided by seven.
    const checked = `${IN_TRANSIT}2`;
    expect(detectCarrierMatch(checked)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['saia']) });
    for (const number of [IN_TRANSIT, `${IN_TRANSIT}4`]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('saia');
    }
    for (const number of [IN_TRANSIT, `${IN_TRANSIT}4`, checked]) {
      expect(recognitionAskedCarriers(number), number).not.toContain('saia');
      expect(recognitionCandidates(number, { hint: 'saia' }).map(({ carrier }) => carrier), number).not.toContain('saia');
    }
    // The catalog asks recognition about exactly the numbers it accepts.
    const pattern = new RegExp(CARRIER_DEFINITIONS.saia.tracking.recognitionPattern!);
    const idle = vi.fn<typeof fetch>();
    for (const number of [IN_TRANSIT, ABSENT, `${IN_TRANSIT}4`, checked, '9990000001', '999000000102 3']) {
      expect(pattern.test(normalizeTrackingNumber(number)), number).toBe(accepted(() => normalizeSaiaRecognitionNumber(number)));
    }
    await expect(carrier(idle).recognize!(checked)).resolves.toEqual({ known: false });
    expect(idle).not.toHaveBeenCalled();
  });

  it('routes a PRO to the adapter when the caller names Saia and reads the tracker’s links', async () => {
    for (const link of [`https://www.saia.com/track/details;pro=${IN_TRANSIT}`, `https://saia.com/track/details?pro=${IN_TRANSIT}`,
      `https://www.saia.com/track?pro=${IN_TRANSIT}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'saia', source: 'link' });
    }
    const fetcher = service(() => reply(fixture('in-transit')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'saia' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'saia', source: 'saia', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${SAIA_API}/`))).toBe(true);
  });
});

describe('Saia status vocabulary', () => {
  it('records every activity and shipment status the maps know with the stage they give', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      if (entry.code) {
        const wording = normalizeStatusWording(entry.wording);
        expect(statusMap.stage(entry.code, wording), entry.code).toBe(stage);
        expect(statusMapAnswer({ carrier: 'saia', providerCode: entry.code, description: wording }), entry.code).toEqual({ kind: 'mapped', stage });
      } else {
        expect(saiaShipmentStage(entry.wording), entry.wording).toBe(stage);
      }
    }
    for (const code of ['constructor', 'toString', 'Departed', 'Arrived at Terminal']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage('departed from  TERMINAL', '')).toBe('in_transit');
    expect(statusMap.gaps).toEqual([]);
  });
});
