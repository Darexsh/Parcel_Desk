import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parcelTrackingLinks } from '../../core/catalog/parcel.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SLGTRAX_API, SlgtraxTracker } from './adapter.js';
import { normalizeSlgtraxNumber, parseSlgtrax, slgtraxReason } from './parser.js';
import { slgtraxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '10000000000001';
const IN_TRANSIT = '10000000000002';
const UNKNOWN = '10000000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { tracking_history: Row[] };
type Reply = Row & { details: Record<string, Shipment> };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(Object.values(reply.details)[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cZone:"sonic.pk"}</script></body></html>';

describe('SLGTrax HTTP adapter', () => {
  it('asks the tracking box’s lookup for the whole number, once, through the supplied transport', async () => {
    const fetcher = answering(() => reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SlgtraxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0000 0000 01 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SLGTRAX_API}?tracking_number=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'slgtrax', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first at its Karachi instants, once per scan, without the consignee or the order', () => {
    const result = parseSlgtrax(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment - Delivered', last_update: '2026-03-12T16:40:21+05:00', expected_delivery: null,
      delivered_at: '2026-03-12T16:40:21+05:00' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-03-12T16:40:21+05:00', 'Shipment - Delivered', 'delivered'],
      ['2026-03-12T10:05:09+05:00', 'Shipment - Out for Delivery', 'out_for_delivery'],
      ['2026-03-11T18:20:50+05:00', 'Shipment - Delivery Unsuccessful', 'failed_attempt'],
      ['2026-03-11T09:45:03+05:00', 'Shipment - Out for Delivery', 'out_for_delivery'],
      // The scan listed twice is kept once.
      ['2026-03-11T03:30:15+05:00', 'Shipment - Arrived at Destination', 'in_transit'],
      ['2026-03-10T08:00:00+05:00', 'Shipment - In Transit', 'in_transit'],
      ['2026-03-10T01:15:42+05:00', 'Shipment - Arrived at Origin', 'accepted'],
      ['2026-03-09T21:10:18+05:00', 'Shipment - Rider Picked', 'accepted'],
      ['2026-03-09T14:00:27+05:00', 'Shipment - Booked', 'registered'],
    ]);
    expect(result.events![2]).toMatchObject({ description: 'Shipment - Delivery Unsuccessful: Consignee Unavailable' });
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.location && !event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Store|Person|Street|Goods|item)|House 0|Other City|Sample City|SMPL|000000000000|900001/);
  });

  it('reads a parcel on its way, dropped at the origin office', async () => {
    await expect(carrier(answering(() => reply(fixture('in-transit')))).track({ number: IN_TRANSIT })).resolves.toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipment - Arrived at Destination',
      last_update: '2026-06-02T06:50:33+05:00', expected_delivery: null });
    const result = parseSlgtrax(fixture('in-transit'), IN_TRANSIT);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'accepted', 'registered']);
  });

  it('keeps the shown minute when the Unix seconds are missing or name another minute', () => {
    const result = parseSlgtrax(changed('in-transit', (shipment) => {
      shipment.tracking_history[0]!.timestamp = null;
      shipment.tracking_history[1]!.timestamp = 1;
      shipment.tracking_history[2]!.timestamp = '1780317302';
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.time)).toEqual([
      '2026-06-02T06:50:00+05:00', '2026-06-01T23:05:00+05:00', '2026-06-01T17:35:00+05:00', '2026-06-01T12:20:58+05:00']);
  });

  it('orders scans by their instants and keeps the carrier’s order within a second', () => {
    const result = parseSlgtrax(changed('in-transit', (shipment) => {
      shipment.tracking_history.reverse();
      shipment.tracking_history.push({ ...shipment.tracking_history.at(-1)!, status: 'Shipment - Out for Delivery' });
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['Shipment - Out for Delivery', 'Shipment - Arrived at Destination',
      'Shipment - In Transit', 'Shipment - Arrived at Origin', 'Shipment - Booked']);
  });

  it('stages a status the map does not know by its wording, else leaves it without a stage', () => {
    const result = parseSlgtrax(changed('in-transit', (shipment) => {
      shipment.tracking_history[0]!.status = 'Shipment - Return In Transit';
      shipment.tracking_history[1]!.status = 'Shipment - Returned to Shipper';
      shipment.tracking_history[2]!.status = 'Shipment - Synthetic Step';
      shipment.tracking_history[3]!.status = 'Payment Done';
    }), IN_TRANSIT);
    expect(result.events!.map((event) => [event.stage ?? null, event.stage_source ?? null])).toEqual([
      ['exception', 'carrier_map'], ['returned', 'wording:returned'], [null, null], [null, null]]);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Shipment - Return In Transit' });
  });

  it('takes phone numbers and amounts to collect out of a reason', () => {
    expect(slgtraxReason('Consignee asked to call 0300-0000000 before delivery')).toBe('Consignee asked to call before delivery');
    expect(slgtraxReason('Refused, Rs. 2,500 not ready, +92 300 000 0000')).toBe('Refused, not ready');
    expect(slgtraxReason('Consignee Unavailable')).toBe('Consignee Unavailable');
    const result = parseSlgtrax(changed('in-transit', (shipment) => {
      shipment.tracking_history[0]!.status_reason = '  0300-0000000 ';
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ description: 'Shipment - Arrived at Destination' });
  });

  it('reads Trax’s list of numbers it has no shipment under as not found, and another error as a refused lookup', async () => {
    expect(() => parseSlgtrax(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => reply(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // The reply to a lookup without a number, and one that lists another number.
    expect(() => parseSlgtrax({ status: 0, message: 'Error(s) in Input', errors: { tracking_number: ['Tracking Number is Required.'] } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSlgtrax(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSlgtrax({ status: 0, message: 'Error(s) in Input' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSlgtrax(changed('delivered', (shipment) => { shipment.tracking_history = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSlgtrax(changed('delivered', (shipment) => { delete (shipment as Row).tracking_history; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the whole number asked', () => {
    expect(() => parseSlgtrax(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SLGTrax answered for another shipment' }));
    const twice = fixture('delivered');
    twice.details['900003'] = structuredClone(twice.details['900001']!);
    expect(() => parseSlgtrax(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Another shipment beside the one asked about is left out.
    const both = fixture('delivered');
    both.details['900002'] = fixture('in-transit').details['900002']!;
    expect(parseSlgtrax(both, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(parseSlgtrax(changed('delivered', (shipment) => { shipment.tracking_number = Number(DELIVERED); }), DELIVERED).events).toHaveLength(9);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { body.status = '1'; },
      (_shipment: Shipment, body: Reply) => { delete (body as Row).details; },
      (_shipment: Shipment, body: Reply) => { body.details = [] as never; },
      (_shipment: Shipment, body: Reply) => { body.details = {}; },
      (_shipment: Shipment, body: Reply) => { body.details['900009'] = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.tracking_number; },
      (shipment: Shipment) => { shipment.tracking_history = 'history' as never; },
      (shipment: Shipment) => { shipment.tracking_history = Array.from({ length: 301 }, () => shipment.tracking_history[0]!); },
      (shipment: Shipment) => { shipment.tracking_history[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.tracking_history[0]!.status = ''; },
      (shipment: Shipment) => { shipment.tracking_history[0]!.status = ['Shipment - Delivered']; },
      (shipment: Shipment) => { shipment.tracking_history[0]!.status_reason = { reason: 'x' }; },
      (shipment: Shipment) => { shipment.tracking_history[0]!.date_time = '2026-03-12 16:40:21'; },
      (shipment: Shipment) => { shipment.tracking_history[0]!.date_time = '31/02/2026 04:40 PM'; },
      (shipment: Shipment) => { shipment.tracking_history[0]!.date_time = '12/03/2026 13:40 PM'; },
      (shipment: Shipment) => { delete shipment.tracking_history[0]!.date_time; },
    ]) {
      expect(() => parseSlgtrax(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSlgtrax('shipments', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => reply(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply({ message: 'Too Many Attempts.' }, { status: 429, headers: { 'Retry-After': '60' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    // The lookup reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(() => reply('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://sonic.pk/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><body>Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup(() => reply('<!DOCTYPE html><html><title>Tracking - Sonic | Trax</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks once more when sonic.pk cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new SlgtraxTracker({ fetcher: flaky, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
    // An answer is never asked for again.
    const refused = answering(() => reply('', { status: 429 }));
    await expect(carrier(refused).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects what is not a number Trax issues, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1234567', '1000000000000', '100000000000001', 'AB000000000001', '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSlgtraxNumber('1000-0000-0000-02')).toBe(IN_TRANSIT);
  });

  it('recognizes a known number and not an unknown one', async () => {
    await expect(carrier(answering(() => reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T11:40:21.000Z' });
    await expect(carrier(answering(() => reply(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('1234567')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(answering(() => reply(CLOUDFLARE))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers a number filed under SLGTrax or opened from one of its trackers’ addresses, and claims no bare number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(SLGTRAX_API)
      ? reply(fixture('delivered')) : reply('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'slgtrax' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'slgtrax', source: 'slgtrax', result: { current_stage: 'delivered' } });
    for (const link of [`https://sonic.pk/tracking?tracking_number=${DELIVERED}`, `https://sonic.pk/cod/tracking?tracking_number=${DELIVERED}`,
      `https://www.slgtrax.com/?tracking_number=${DELIVERED}`, `https://legacy.trax.pk/admin_cod/parcel_tracking.php?parcel_list=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'slgtrax' });
    }
    expect(parcelTrackingLinks({ carrier: 'slgtrax', trackingNumber: DELIVERED }, 'en')[0]).toMatchObject({
      url: `https://sonic.pk/tracking?tracking_number=${DELIVERED}` });
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('slgtrax');
  });
});

describe('SLGTrax status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, and leaves billing lines out on purpose', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      if (!entry.stage) {
        expect(slgtraxStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'slgtrax', description: entry.wording }), entry.wording).toMatchObject({ kind: 'intentional_gap' });
        expect(statusMapAnswer({ carrier: 'slgtrax', providerCode: `Shipment - ${entry.wording}`, description: `Shipment - ${entry.wording}` }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(slgtraxStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'slgtrax', providerCode: 'Shipment - Delivery Unsuccessful',
      description: 'Shipment - Delivery Unsuccessful: Consignee Unavailable' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'slgtrax', providerCode: 'Shipment - Return Marked', description: 'Shipment - Return Marked' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMapAnswer({ carrier: 'slgtrax', providerCode: 'Shipment - Xyzzy', description: 'Shipment - Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});
