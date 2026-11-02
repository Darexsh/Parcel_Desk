import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FASTDROP_CLIENT_VERSION, FASTDROP_CONFIG, FastdropTracker, fastdropTrackingUrl } from './adapter.js';
import { fastdropStopWording, normalizeFastdropNumber, parseFastdrop } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '0000000017';
const IN_TRANSIT = '0000000025';
const UNKNOWN = '0000000000';

type Row = Record<string, unknown>;
type Package = Row & { journey: Row[] };
type Reply = Row & { package: Package };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (pkg: Package, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.package, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const refusal = { error_code: 'unknown_tenant', description: 'Tenant could not be found based on sent X-Client-Version.' };
const config = (version: string) => ({ tenant: { name: 'Sample', url_key: 'sample', web_client_version: version } });

describe('Fastdrop HTTP adapter', () => {
  it('asks MotionTools for the whole number once, with the page’s client version, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FastdropTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000-000 0025 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.motiontools.io/api/hailing/packages/0000000025/tracking');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'X-Client-Version': FASTDROP_CLIENT_VERSION, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fastdrop', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the resolved stops as the page words them, with their instants and a failed stop’s reason', () => {
    const result = parseFastdrop(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-12T13:20:05Z', delivered_at: '2026-03-12T13:20:05Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-03-12T13:20:05Z', 'Delivered', 'delivered'],
      ['2026-03-12T07:41:10Z', 'Left the hub', 'in_transit'],
      ['2026-03-11T15:02:33Z', 'Arrived at the hub', 'in_transit'],
      ['2026-03-11T12:48:00Z', 'Delivery failed: Customer not at home', 'failed_attempt'],
      ['2026-03-11T07:35:51Z', 'Left the hub', 'in_transit'],
      ['2026-03-10T16:12:09Z', 'Arrived at the hub', 'in_transit'],
      ['2026-03-10T10:05:27Z', 'Picked up from the sender', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toMatch(/SMPL|35\.9|14\.5|lat|lng|driver/i);
  });

  it('orders the stops by their clocks, skips the one under way and keeps the estimate but not the driver', () => {
    const result = parseFastdrop(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Out for delivery', last_update: '2026-05-06T08:55:03+02:00', expected_delivery: '2026-05-06T11:30:00+02:00' });
    expect(result.events!.map((event) => event.description)).toEqual(['Left the hub', 'Arrived at the hub', 'Picked up from the sender']);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/35\.95|14\.37|stops_before/);
    // A delivery ends the estimate.
    expect(parseFastdrop(changed('in-transit', (pkg) => { pkg.status = 'delivered'; }), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('keeps stops of one instant in the order of a reply listed oldest first', () => {
    const result = parseFastdrop(changed('in-transit', (pkg) => { pkg.journey[2]!.resolved_at = pkg.journey[1]!.resolved_at; }), IN_TRANSIT);
    expect(result.events!.map((event) => event.description)).toEqual(['Left the hub', 'Arrived at the hub', 'Picked up from the sender']);
  });

  it('takes the package status for the stage, a missed stop’s stage when it failed, and moves a waiting package on after a stop', () => {
    const status = (value: string, change: (pkg: Package) => void = () => {}) =>
      parseFastdrop(changed('in-transit', (pkg) => { pkg.status = value; change(pkg); }), IN_TRANSIT);
    expect(status('at_hub')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'At hub' });
    expect(status('ready_for_collection')).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Ready for collection' });
    expect(status('at_customs')).toMatchObject({ current_stage: 'customs', last_status_text: 'At customs' });
    expect(status('cancelled')).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Cancelled' });
    // A collection at the hub is the end of the journey, though no stop records it.
    expect(status('collected')).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Collected' });
    expect(status('collected')).not.toHaveProperty('delivered_at');
    // Back on a tour after a hub: not registered again.
    expect(status('awaiting_pickup')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Awaiting pickup' });
    const failedDelivery = (pkg: Package) => {
      pkg.journey[3] = { ...pkg.journey[3], resolved_at: '2026-05-06T12:10:00.000+02:00', outcome: 'failure', failure_reason: { title: 'Address not found' } };
    };
    expect(status('failed', failedDelivery)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Failed' });
    expect(status('failed', failedDelivery).events![0]).toMatchObject({ description: 'Delivery failed: Address not found', stage: 'failed_attempt' });
    expect(status('failed', (pkg) => { pkg.journey.splice(1); pkg.journey[0]!.outcome = 'failure'; }))
      .toMatchObject({ current_stage: 'exception', last_status_text: 'Failed', events: [{ description: 'Pickup from the sender failed', stage: 'exception' }] });
    expect(status('failed')).toMatchObject({ current_stage: 'exception' });
    // A status the platform adds later takes the newest stop's stage and shows as it came.
    expect(status('synthetic_status')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'synthetic_status' });
  });

  it('answers a package with no resolved stop from its status alone', () => {
    const created = parseFastdrop(changed('in-transit', (pkg) => {
      pkg.status = 'created';
      pkg.eta = null;
      for (const stop of pkg.journey) Object.assign(stop, { outcome: 'none', resolved_at: null });
    }), IN_TRANSIT);
    expect(created).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map', last_status_text: 'Created',
      provider_code: 'created', summary_only: true, last_update: null, expected_delivery: null, events: [] });
    expect(parseFastdrop(changed('in-transit', (pkg) => { pkg.status = 'destination_needed'; pkg.journey = []; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'registered', last_status_text: 'Destination needed', summary_only: true, provider_code: 'destination_needed' });
  });

  it('words every kind of resolved stop as the page does', () => {
    expect(fastdropStopWording('pickup', true, false)).toBe('Picked up from the sender');
    expect(fastdropStopWording('pickup', false, false)).toBe('Pickup from the sender failed');
    expect(fastdropStopWording('pickup', true, true)).toBe('Left the hub');
    expect(fastdropStopWording('pickup', false, true)).toBe('Pickup at the hub failed');
    expect(fastdropStopWording('dropoff', true, true)).toBe('Arrived at the hub');
    expect(fastdropStopWording('dropoff', false, true)).toBe('Drop-off at the hub failed');
    expect(fastdropStopWording('dropoff', true, false)).toBe('Delivered');
    expect(fastdropStopWording('dropoff', false, false)).toBe('Delivery failed');
  });

  it('keeps a clock without an offset as a wall clock, and a repeated stop once', () => {
    const local = parseFastdrop(changed('delivered', (pkg) => {
      pkg.journey[0]!.resolved_at = '2026-03-12T14:20:05.123';
      pkg.journey.push({ ...pkg.journey[6]! });
    }), DELIVERED);
    expect(local.events![0]).toEqual({ local_time: '2026-03-12T14:20:05', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(local).toMatchObject({ last_update: null, last_update_local: '2026-03-12T14:20:05' });
    expect(local).not.toHaveProperty('delivered_at');
    expect(local.events).toHaveLength(7);
    // A reason's phone number is dropped.
    expect(parseFastdrop(changed('delivered', (pkg) => {
      pkg.journey[3]!.failure_reason = { title: 'Call back on +356 0000 0000' };
    }), DELIVERED).events![3]!.description).toBe('Delivery failed: Call back on');
  });

  it('counts a package only when it names the number asked', () => {
    expect(() => parseFastdrop(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Fastdrop answered for another package' }));
    // The platform documents the code as a string with a numeric example; a number keeps its leading zeros.
    expect(parseFastdrop(changed('in-transit', (pkg) => { pkg.tracking_code = 25; }), IN_TRANSIT)).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(() => parseFastdrop(changed('in-transit', (pkg) => { pkg.tracking_code = 250; }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_pkg: Package, body: Reply) => { delete (body as Row).package; },
      (_pkg: Package, body: Reply) => { body.package = 'package' as never; },
      (pkg: Package) => { delete pkg.tracking_code; },
      (pkg: Package) => { pkg.tracking_code = ['0000000025']; },
      (pkg: Package) => { pkg.tracking_code = 2.5; },
      (pkg: Package) => { delete pkg.status; },
      (pkg: Package) => { pkg.status = 'Out for delivery'; },
      (pkg: Package) => { delete (pkg as Row).journey; },
      (pkg: Package) => { pkg.journey = 'journey' as never; },
      (pkg: Package) => { pkg.journey[0] = 'stop' as never; },
      (pkg: Package) => { pkg.journey[0]!.type = 'handover'; },
      (pkg: Package) => { pkg.journey[0]!.outcome = 'partial'; },
      (pkg: Package) => { pkg.journey[0]!.resolved_at = null; },
      (pkg: Package) => { pkg.journey[0]!.resolved_at = '05/05/2026 15:40'; },
      (pkg: Package) => { pkg.journey[0]!.resolved_at = '2026-05-05T24:00:00'; },
      (pkg: Package) => { pkg.journey[0]!.resolved_at = '2026-02-30T15:40:12+02:00'; },
      (pkg: Package) => { pkg.journey[0]!.outcome = 'failure'; pkg.journey[0]!.failure_reason = 'Customer not at home'; },
      (pkg: Package) => { pkg.eta = 'soon'; },
      (pkg: Package) => { pkg.journey = Array.from({ length: 501 }, () => pkg.journey[0]!); },
    ]) {
      expect(() => parseFastdrop(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // A 404 without the API's answer, or a redirect, is a moved route.
    await expect(lookup('<html><body>Not Found</body></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://booking.fastdrop.mt/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ error_code: 'invalid_params', description: 'Synthetic' }, { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<p>Application error</p>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ error_code: 'maintenance', description: 'Synthetic' }, { status: 503 })).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      // MotionTools answers too many lookups with HTTP 429 and `Retry later`.
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(status === 429 ? 'Retry later' : '', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('reads the client version from the tenant settings when MotionTools refuses the one in use, and keeps it', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(refusal, { status: 400 }))
      .mockResolvedValueOnce(reply(config('Sample Web Dashboard/2.0.0')))
      .mockResolvedValueOnce(reply(fixture('in-transit')))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    const tracker = new FastdropTracker({ fetcher });
    await expect(tracker.fetch(IN_TRANSIT)).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get('X-Client-Version')])).toEqual([
      [fastdropTrackingUrl(IN_TRANSIT), FASTDROP_CLIENT_VERSION],
      [FASTDROP_CONFIG, null],
      [fastdropTrackingUrl(IN_TRANSIT), 'Sample Web Dashboard/2.0.0'],
      [fastdropTrackingUrl(DELIVERED), 'Sample Web Dashboard/2.0.0'],
    ]);
    expect(FASTDROP_CONFIG).toBe('https://api.motiontools.io/api/config?origin=https%3A%2F%2Fbooking.fastdrop.mt');
  });

  it('stops when the tenant settings name the refused version, or MotionTools refuses the new one too', async () => {
    const same = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({ error_code: 'client_version_gone' }, { status: 410 }))
      .mockResolvedValueOnce(reply(config(FASTDROP_CLIENT_VERSION)));
    await expect(carrier(same).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    expect(same).toHaveBeenCalledTimes(2);
    const again = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(refusal, { status: 400 }))
      .mockResolvedValueOnce(reply(config('Sample Web Dashboard/2.0.0'))).mockResolvedValueOnce(reply(refusal, { status: 400 }));
    await expect(carrier(again).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    for (const settings of [reply({ tenant: {} }), reply('<html></html>'), reply('', { status: 404 })]) {
      const broken = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(refusal, { status: 400 })).mockResolvedValueOnce(settings);
      await expect(carrier(broken).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:schema|transport)$/) });
    }
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Fastdrop does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T13:20:05.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('SMPL7QX')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Fastdrop does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000017', '00000000017', 'SMPL7QX', 'FD00000017', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFastdropNumber('000-000 0017')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the API once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Fastdrop to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'fastdrop' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'fastdrop', source: 'fastdrop', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === fastdropTrackingUrl(DELIVERED))).toBe(true);
  });
});

describe('Fastdrop status vocabulary', () => {
  it('records every status and wording with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'fastdrop', providerCode: null, description: 'Delivery failed: Customer not at home' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'fastdrop', providerCode: 'ready_for_collection', description: 'Ready for collection' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'fastdrop', providerCode: 'failed', description: 'Failed' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'fastdrop', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
