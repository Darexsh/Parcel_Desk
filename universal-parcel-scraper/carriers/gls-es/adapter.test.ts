import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, GLS_SPAIN_ENDPOINT, GLS_SPAIN_SIGNING_SECRET, GLSSpainTracker, glsSpainLookupBody, glsSpainSignature } from './adapter.js';
import { normalizeGLSSpainNumber, normalizeGLSSpainPostcode, parseGLSSpain, parseGLSSpainReply } from './parser.js';
import { glsSpainStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '1000000001';
const POSTCODE = '99999';
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
type Found = Record<string, unknown> & { tracking: Record<string, unknown>[]; state: Record<string, unknown> };
/** The fixture's shipment, changed by `change`. */
const shipment = (change: (found: Found) => void = () => {}) => {
  const value = fixture();
  change(value.found);
  return value;
};
const reply = (body: unknown = fixture(), status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null,
  userAgent: 'HostAgent/1.0', recorder: { step() {}, lookup() {} } });

describe('GLS Spain direct tracking', () => {
  it('reads the scans newest first as instants, with their codes, the weight and the point, and nothing private', () => {
    const result = normalizeCarrierResult(parseGLSSpain(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-06T10:21:00Z', delivered_at: '2026-03-06T10:21:00Z',
      expected_delivery: null, pickup_point: 'Example Point Shop', weight_kg: 1.2 });
    // The repeated scan is kept once.
    expect(result.events).toHaveLength(8);
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['delivered', 'delivered'], ['receivedOnParcel', 'ready_for_pickup'], ['incidence', 'in_transit'], ['incidence', 'failed_attempt'],
      ['onDelivery', 'out_for_delivery'], ['onTransit', 'in_transit'], ['picked', 'accepted'], ['dataReceived', 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2026-03-06T10:21:00Z', description: 'Delivered', provider_code: 'delivered',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => /Z$/.test(event.time ?? '') && !('location' in event))).toBe(true);
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SAMPLE|Sample|99997|99998|000000000|Mon to Fri/);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'gls-es', steps: ['direct', 'retry'],
      requirements: [expect.objectContaining({ field: 'postcode', validator: 'internationalPostcode' })] });
    expect(metadata.tracking).not.toHaveProperty('recognition');
    expect(metadata.tracking).not.toHaveProperty('localClocks');
  });

  it('names the point only while the parcel waits there or once collected from it, and only when its scan names it too', () => {
    const waiting = parseGLSSpain(shipment((found) => {
      found.tracking.shift();
      found.state = { code: 'receivedOnParcel', description: 'Received in GLS Point', parcelShop: { codeQr: 'PRIVATE', pin: 'PRIVATE' } };
    }), NUMBER);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Received in Example Point Shop',
      pickup_point: 'Example Point Shop' });
    expect(waiting).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(waiting)).not.toMatch(/PRIVATE/);
    const otherPoint = parseGLSSpain(shipment((found) => { (found.parcelShop as Record<string, unknown>).name = 'Another Shop'; }), NUMBER);
    expect(otherPoint).not.toHaveProperty('pickup_point');
    // Before the parcel reaches a point, the reply's point is the destination depot.
    const early = parseGLSSpain(shipment((found) => {
      found.tracking.splice(0, 4);
      found.state = { code: 'onDelivery', description: 'Out for delivery' };
    }), NUMBER);
    expect(early).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(early).not.toHaveProperty('pickup_point');
    const toDoor = parseGLSSpain(shipment((found) => { found.tracking.splice(1, 3); }), NUMBER);
    expect(toDoor).toMatchObject({ status: 'delivered' });
    expect(toDoor).not.toHaveProperty('pickup_point');
  });

  it('reads incidences by their sentence and takes the current stage from the shipment state', () => {
    const absent = parseGLSSpain(shipment((found) => {
      found.tracking.splice(0, 3);
      found.state = { code: 'incidence', description: 'Incidence' };
    }), NUMBER);
    expect(absent).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map', last_status_text: 'Absent' });
    expect(glsSpainStage('incidence', 'Refused by the consignee')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(glsSpainStage('incidence', 'Something new')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(glsSpainStage('pickupIncidence', 'Absent')).toEqual({ stage: 'exception', source: 'carrier_map' });
    // A state the scans do not reach yet heads the page.
    const returning = parseGLSSpain(shipment((found) => { found.state = { code: 'onReturn', description: 'Return delivery process' }; }), NUMBER);
    expect(returning).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Delivered' });
    // A code the map does not hold goes to the shared wording rules, and a sentence they cannot read leaves no stage.
    const unread = parseGLSSpain(shipment((found) => {
      found.tracking.unshift({ code: 'somethingNew', description: 'Zxq', at: '2026-03-07T10:00:00Z' });
      found.state = { code: 'somethingNew', description: 'Zxq' };
    }), NUMBER);
    expect(unread).toMatchObject({ status: 'unknown', last_status_text: 'Zxq', last_update: '2026-03-07T10:00:00Z' });
    expect(unread).not.toHaveProperty('current_stage');
    expect(unread).not.toHaveProperty('delivered_at');
    expect(unread.events![0]).toEqual({ time: '2026-03-07T10:00:00Z', description: 'Zxq', provider_code: 'somethingNew' });
    const stored = parseGLSSpain(shipment((found) => {
      found.tracking.unshift({ code: 'stored', description: 'Out for delivery', at: '2026-03-07T10:00:00Z' });
      found.state = { code: 'stored', description: 'Stored' };
    }), NUMBER);
    expect(stored).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: expect.stringMatching(/^wording:/) });
  });

  it('keeps the estimated delivery day of a parcel still on its way', () => {
    const onItsWay = (estimatedDeliveryDate: unknown) => parseGLSSpain(shipment((found) => {
      found.tracking.splice(0, 4);
      found.state = { code: 'onDelivery', description: 'Out for delivery', estimatedDeliveryDate };
    }), NUMBER);
    expect(onItsWay('2026-03-03').expected_delivery).toBe('2026-03-03');
    // An instant is the day in Spain.
    expect(onItsWay('2026-03-02T23:00:00Z').expected_delivery).toBe('2026-03-03');
    for (const value of ['03/03/2026', '2026-02-30', '2026-03-03T10:00:00', null]) {
      expect(onItsWay(value).expected_delivery, String(value)).toBeNull();
    }
    expect(parseGLSSpain(shipment((found) => { found.state.estimatedDeliveryDate = '2026-03-06'; }), NUMBER).expected_delivery).toBeNull();
  });

  it('names the shipment number when the lookup used a barcode or reference', () => {
    expect(parseGLSSpain(fixture(), 'privateref001')).toMatchObject({ canonical_tracking_number: NUMBER });
    expect(parseGLSSpain(shipment((found) => { found.expeditionCode = '1000000001'; }), NUMBER)).not.toHaveProperty('canonical_tracking_number');
  });

  it('keeps the weight only when the reply gives one', () => {
    for (const weight of [0, -1, '1.2', null, Number.MAX_VALUE]) {
      expect(parseGLSSpain(shipment((found) => { (found.attributes as Record<string, unknown>).weight = weight; }), NUMBER), String(weight))
        .not.toHaveProperty('weight_kg');
    }
    expect(parseGLSSpain(shipment((found) => { delete found.attributes; }), NUMBER)).not.toHaveProperty('weight_kg');
  });

  it('answers a shipment without scans from its state alone', () => {
    for (const tracking of [[], null, undefined]) {
      const result = parseGLSSpain(shipment((found) => {
        found.tracking = tracking as unknown as Found['tracking'];
        found.state = { code: 'dataReceived', description: 'Data received' };
      }), NUMBER);
      expect(result, String(tracking)).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Data received',
        last_update: null, provider_code: 'dataReceived', summary_only: true, events: [] });
    }
  });

  it('maps every recorded state, and the status map answers as the parser stages', () => {
    for (const entry of statuses.entries) {
      const description = 'wording' in entry ? entry.wording!.replace('<point>', 'Example Point Shop') : 'Any wording';
      const expected = 'stage' in entry ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: expect.any(String) };
      expect(statusMapAnswer({ carrier: 'gls-es', providerCode: entry.code, description }), `${entry.code} ${description}`).toEqual(expected);
      if ('stage' in entry) expect(glsSpainStage(entry.code, description)).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'gls-es', providerCode: 'incidence', description: '  ABSENT ' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    for (const code of ['constructor', 'toString', 'Delivered', null]) {
      expect(statusMapAnswer({ carrier: 'gls-es', providerCode: code, description: 'Delivered' }), String(code)).toEqual({ kind: 'unknown' });
    }
  });

  it('validates the reply and its scans', () => {
    for (const value of [null, [], {}, { found: [] }, { found: 'x' }]) {
      expect(() => parseGLSSpain(value, NUMBER), JSON.stringify(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const broken: [string, (found: Found) => void][] = [
      ['no shipment number', (found) => { delete found.expeditionCode; }],
      ['a shipment number with letters', (found) => { found.expeditionCode = 'GLS1'; }],
      ['a shipment number as an object', (found) => { found.expeditionCode = { value: 1 }; }],
      ['no state', (found) => { delete (found as Record<string, unknown>).state; }],
      ['a state without its code', (found) => { delete found.state.code; }],
      ['a scan list that is not one', (found) => { found.tracking = 'x' as unknown as Found['tracking']; }],
      ['too many scans', (found) => { found.tracking = Array.from({ length: 501 }, () => found.tracking[0]!); }],
      ['a scan that is not an object', (found) => { found.tracking.unshift('Delivered' as unknown as Record<string, unknown>); }],
      ['a scan without wording', (found) => { found.tracking[0]!.description = ' '; }],
      ['a scan without a code', (found) => { delete found.tracking[0]!.code; }],
      ['a clock without an offset', (found) => { found.tracking[0]!.at = '2026-03-06T10:21:00'; }],
      ['an impossible clock', (found) => { found.tracking[0]!.at = '2026-02-30T10:21:00Z'; }],
      ['a clock as a number', (found) => { found.tracking[0]!.at = 1772792460000; }],
      ['no wording at all', (found) => { found.tracking = []; found.state.description = ''; }],
    ];
    for (const [name, change] of broken) {
      expect(() => parseGLSSpain(shipment(change), NUMBER), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A scan without a clock keeps its place without one.
    const undated = parseGLSSpain(shipment((found) => { found.tracking[1]!.at = null; }), NUMBER);
    expect(undated.events![1]).toEqual({ description: 'Received in Example Point Shop', provider_code: 'receivedOnParcel',
      stage: 'ready_for_pickup', stage_source: 'carrier_map' });
  });

  it('knows a missing shipment only from the 404 with its not-found error', () => {
    expect(() => parseGLSSpainReply(404, fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [
      { error: { status: 404, name: 'NotFoundError', message: 'Not found', details: 'routeNotFound' } },
      { error: { status: 404, name: 'Error', details: 'notFound' } },
      { ...fixture('not-found'), found: fixture().found }, {}, null, 'Not Found',
    ]) {
      expect(() => parseGLSSpainReply(404, payload, NUMBER), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // An error with a success status is not an answer either.
    expect(() => parseGLSSpainReply(200, fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseGLSSpainReply(200, fixture(), NUMBER)).toMatchObject({ status: 'delivered' });
  });

  it('accepts numbers and references of letters and digits, with a delivery postcode', () => {
    expect(normalizeGLSSpainNumber(' 1000-000 001 ')).toBe(NUMBER);
    expect(normalizeGLSSpainNumber('privateref001')).toBe('PRIVATEREF001');
    for (const number of ['1234', 'REF_1', 'REF/1', '1'.repeat(41), `${'1'.repeat(70)}`]) {
      expect(() => normalizeGLSSpainNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(normalizeGLSSpainPostcode(' 99999 ')).toBe(POSTCODE);
    expect(normalizeGLSSpainPostcode('9999-999')).toBe('9999-999');
    expect(normalizeGLSSpainPostcode('ad 999')).toBe('AD 999');
    for (const postcode of ['', '  ', null, undefined]) {
      expect(() => normalizeGLSSpainPostcode(postcode), String(postcode)).toThrow(expect.objectContaining({ kind: 'input_required', field: 'postcode' }));
    }
    for (const postcode of ['ABCDE', '99', '99999/1']) {
      expect(() => normalizeGLSSpainPostcode(postcode), postcode).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(glsSpainLookupBody(NUMBER, POSTCODE)).toBe('{"find":{"reference":"1000000001","destination":{"address":{"postalCode":"99999"}}}}');
  });

  it('reads GLS Spain links', () => {
    for (const link of [`https://mygls.gls-spain.es/e/?codigo=${NUMBER}`, `https://mygls.gls-spain.es/e/${NUMBER}/${POSTCODE}`,
      `https://mygls.gls-spain.es/e/${NUMBER}/9999-999/es`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'gls-es', source: 'link' });
    }
  });

  it('takes GLS Portugal\'s shipments, links and name, which the same service answers', () => {
    for (const link of [`https://mygls.gls-portugal.pt/e/${NUMBER}/9999-999/pt`, `https://mygls.gls-portugal.pt/e/?codigo=${NUMBER}`,
      `https://gls-group.com/PT/pt/receber-envios/seguir-envio/?match=${NUMBER}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'gls-es', source: 'link' });
    }
    expect(carrierIdFromName('GLS Portugal')).toBe('gls-es');
  });

  it('signs one lookup with the number and postcode, the host agent and no session', async () => {
    const now = new Date('2026-03-06T12:00:00.000Z');
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(String(url)).toBe(GLS_SPAIN_ENDPOINT);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(glsSpainLookupBody(NUMBER, POSTCODE));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(Object.fromEntries(headers)).toEqual({
        accept: 'application/json', 'accept-language': 'en_US', 'content-type': 'application/json; charset=utf-8', 'mygls-agent': 'pwa',
        'user-agent': 'HostAgent/1.0', 'x-timestamp': '2026-03-06T12:00:00.000Z',
        'x-signature': glsSpainSignature('2026-03-06T12:00:00.000Z', GLS_SPAIN_SIGNING_SECRET),
      });
      return reply();
    });
    const tracker = new GLSSpainTracker({ fetcher, userAgent: 'HostAgent/1.0', now: () => now });
    expect(await tracker.fetch('1000 000 001', ' 99999 ')).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(glsSpainSignature('2026-03-06T12:00:00.000Z', 'synthetic'))
      .toBe('43e4df0f7810e72038dd37836f8bf77c5a76b6150b270c1de46950ad3217ce65');
    const instance = adapter(environment(fetcher));
    expect(instance).not.toHaveProperty('recognize');
    await expect(instance.track({ number: '1234', postcode: POSTCODE })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure taxonomy, retries a failed connection once with a new signature and bounds bodies', async () => {
    for (const [body, status, kind] of [
      [{ error: { status: 500, name: 'InternalError' } }, 500, 'indeterminate'],
      [{ error: { status: 403, name: 'ForbiddenError', message: 'Invalid signature' } }, 403, 'challenge'],
      [{ error: { status: 401, name: 'InvalidCredentialsError', message: 'Invalid timestamp' } }, 401, 'challenge'],
      ['', 429, 'rate_limited'], ['', 503, 'maintenance'], ['', 400, 'transport'],
      ['<html><title>Just a moment...</title></html>', 200, 'challenge'],
      ['<!doctype html><html><body>Maintenance</body></html>', 200, 'indeterminate'],
      ['<html><body><div class="cf-turnstile"></div></body></html>', 404, 'challenge'],
      ['{"found":', 200, 'schema'],
    ] as const) {
      const fetcher = vi.fn(async () => reply(body, status)) as unknown as typeof fetch;
      await expect(new GLSSpainTracker({ fetcher }).fetch(NUMBER, POSTCODE), `${status} ${JSON.stringify(body).slice(0, 30)}`)
        .rejects.toMatchObject({ kind });
    }
    const stamps: string[] = [];
    let clock = Date.parse('2026-03-06T12:00:00.000Z');
    const flaky = vi.fn<typeof fetch>(async (_url, init) => {
      stamps.push(new Headers(init?.headers).get('x-timestamp')!);
      if (stamps.length === 1) throw new TypeError('fetch failed');
      return reply();
    });
    const tracker = new GLSSpainTracker({ fetcher: flaky, now: () => new Date(clock += 1_000) });
    expect(await tracker.fetch(NUMBER, POSTCODE)).toMatchObject({ status: 'delivered' });
    expect(stamps).toEqual(['2026-03-06T12:00:01.000Z', '2026-03-06T12:00:02.000Z']);
    const absentOnce = vi.fn(async () => reply(fixture('not-found'), 404));
    await expect(new GLSSpainTracker({ fetcher: absentOnce as unknown as typeof fetch }).fetch(NUMBER, POSTCODE))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(absentOnce).toHaveBeenCalledTimes(1);
    const large = vi.fn(async () => new Response(new Uint8Array(600_000))) as unknown as typeof fetch;
    await expect(new GLSSpainTracker({ fetcher: large }).fetch(NUMBER, POSTCODE)).rejects.toThrow('unexpectedly large');
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new GLSSpainTracker({ fetcher: immediate }).fetch(NUMBER, POSTCODE, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new GLSSpainTracker({ fetcher: immediate }).fetch(NUMBER, POSTCODE, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    // A request that hangs ends with the budget, retried at most once.
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new GLSSpainTracker({ fetcher: slow }).fetch(NUMBER, POSTCODE, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
