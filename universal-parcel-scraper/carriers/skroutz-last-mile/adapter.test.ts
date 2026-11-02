import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SKROUTZ_API, SkroutzTracker } from './adapter.js';
import { normalizeSkroutzNumber, parseSkroutz } from './parser.js';
import { skroutzStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'Z9SAMPLE0DLV1';
const IN_TRANSIT = 'Z9SAMPLE0TRN2';
const UNKNOWN = 'Z9SAMPLE0UNK0';

type Row = Record<string, unknown>;
type Reply = Row & { trackingDetails: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const notFound = () => new Response('Package not found', { status: 400 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Skroutz Last Mile HTTP adapter', () => {
  it('asks for the whole voucher in capitals in the path, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SkroutzTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' z9sample 0trn2 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    // The reply names no voucher; the service matches the whole one in its path, case included.
    expect(String(url)).toBe(`${SKROUTZ_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skroutz-last-mile', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history at Greece’s offset, newest first, without the delivery notes', () => {
    const result = parseSkroutz(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-12T16:42:05.520+03:00', delivered_at: '2026-05-12T16:42:05.520+03:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.description])).toEqual([
      // The delivery the reply lists twice is kept once.
      ['2026-05-12T16:42:05.520+03:00', 'DELIVERED', 'delivered', 'Delivered'],
      ['2026-05-12T16:30:00+03:00', 'ASSIGNED_TO_COURIER_FOR_DELIVERY', 'out_for_delivery', 'The shipment is approaching the delivery location'],
      // The state of the pickup from the shop also files the courier leaving the hub; the wording tells them apart.
      ['2026-05-12T08:40:00+03:00', 'PICKED_UP', 'out_for_delivery', 'The shipment is en route for delivery'],
      ['2026-05-12T08:30:00+03:00', 'AWAITING_PICKUP', 'in_transit', 'The delivery of the shipment has been scheduled'],
      ['2026-05-12T01:15:00+03:00', 'SCANNED', 'in_transit', 'The shipment is at SLM HUB Δοκιμή'],
      // The row without wording, which the page hides, is left out.
      ['2026-05-11T22:00:00+03:00', 'AWAITING_PICKUP', 'in_transit', 'The delivery of the shipment has been scheduled'],
      ['2026-05-11T13:20:30+03:00', 'SCANNED', 'in_transit', 'The shipment is at SLM HUB Δοκιμή'],
      ['2026-05-11T11:10:12.105+03:00', 'PICKED_UP', 'accepted', 'We have picked up the shipment from the sender'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined && event.location === undefined))
      .toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Recipient|10\.1234|20\.6543|Crew pickup|synthetic\.realtime|000000-0000001|SAMPLE_HIDDEN/);
  });

  it('reads a parcel on its way with the day planned for it, at a partner courier’s hub and then its own', () => {
    const result = parseSkroutz(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment is at SLM HUB Δείγμα', last_update: '2026-11-02T20:30:00+02:00', expected_delivery: '2026-11-03' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result.events!.map((event) => [event.stage, event.description])).toEqual([
      ['in_transit', 'The shipment is at SLM HUB Δείγμα'],
      ['in_transit', 'The shipment is at Hub ACS'],
      ['accepted', 'We have picked up the shipment from the sender'],
    ]);
  });

  it('reads the courier’s window over the planned day, and gives no estimate where the page shows none', () => {
    const windowed = parseSkroutz(changed('in-transit', (body) => {
      body.eta = { startTime: '2026-11-03T08:00:00.000Z', endTime: '2026-11-03T10:00:00.000Z' };
    }), IN_TRANSIT);
    expect(windowed).toMatchObject({ expected_delivery_from: '2026-11-03T10:00:00+02:00', expected_delivery: '2026-11-03T12:00:00+02:00' });
    // A window that is not two instants in order falls back to the planned day.
    for (const eta of [{ startTime: '2026-11-03 08:00', endTime: '2026-11-03T10:00:00.000Z' }, { startTime: '2026-11-03T10:00:00.000Z',
      endTime: '2026-11-03T08:00:00.000Z' }, 'soon']) {
      expect(parseSkroutz(changed('in-transit', (body) => { body.eta = eta; }), IN_TRANSIT)).toMatchObject({ expected_delivery: '2026-11-03' });
    }
    // Late in the day at Greece's offset is still that day.
    expect(parseSkroutz(changed('in-transit', (body) => { body.expectedDayOfDelivery = '2026-11-03T22:30:00.000Z'; }), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-11-04' });
    for (const change of [
      (body: Reply) => { body.thirdPartyCourier = 'sample courier'; body.thirdPartyTrackingUrl = 'https://courier.example/track'; },
      (body: Reply) => { body.isCompleteCancelled = true; },
      (body: Reply) => { body.status = 'lost_or_damaged'; },
      (body: Reply) => { body.expectedDayOfDelivery = null; },
      (body: Reply) => { body.expectedDayOfDelivery = 'tomorrow'; },
    ]) {
      const result = parseSkroutz(changed('in-transit', change), IN_TRANSIT);
      expect(result.expected_delivery).toBeNull();
      expect(result).not.toHaveProperty('expected_delivery_from');
    }
  });

  it('reads a parcel left in a Skroutz Point by its Greek wording when the English one is missing', () => {
    const result = parseSkroutz(changed('in-transit', (body) => {
      body.status = 'at_locker';
      body.trackingDetails.push({ id: 2000004, checkpoint: null, description: 'Shipment arrived at locker', notes: null,
        createdAt: '2026-11-03T09:28:00.000Z', updatedAt: '2026-11-03T09:28:00.000Z', latestEta: null,
        description_gr: 'Παράδοση σε Skroutz Point', description_en: null, trackingState: 'DELIVERED' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Παράδοση σε Skroutz Point',
      expected_delivery: null });
    expect(result.events![0]).toMatchObject({ provider_code: 'DELIVERED', stage: 'ready_for_pickup', stage_source: 'carrier_map' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('stages a wording it does not know by its state, else by the shared rules, and leaves the rest without a stage', () => {
    const result = parseSkroutz(changed('in-transit', (body) => {
      body.trackingDetails.push(
        { id: 2000005, createdAt: '2026-11-03T07:00:00.000Z', description_gr: '', description_en: 'Sample hub wording', trackingState: 'SCANNED' },
        { id: 2000006, createdAt: '2026-11-03T08:00:00.000Z', description_gr: '', description_en: 'The shipment was returned to the sender',
          trackingState: 'SAMPLE_RETURN' },
        { id: 2000007, createdAt: '2026-11-03T09:00:00.000Z', description_gr: '', description_en: 'Sample note', trackingState: null },
      );
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 3).map((event) => [event.provider_code, event.stage, event.stage_source?.replace(/:.*/, '')])).toEqual([
      [undefined, undefined, undefined],
      ['SAMPLE_RETURN', 'returned', 'wording'],
      ['SCANNED', 'in_transit', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Sample note', last_update: '2026-11-03T11:00:00+02:00' });
  });

  it('reads a voucher without scans as registered, as the page does', () => {
    for (const rows of [[], [{ id: 1, createdAt: '2026-11-02T07:00:00.000Z', description_gr: '', description_en: '', trackingState: 'SAMPLE' }]]) {
      const result = parseSkroutz(changed('in-transit', (body) => { body.trackingDetails = rows; body.status = 'pending'; }), IN_TRANSIT);
      expect(result).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
        last_status_text: 'In transit', last_update: null, expected_delivery: '2026-11-03', summary_only: true, events: [] });
    }
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.status; },
      (body: Reply) => { body.status = ''; },
      (body: Reply) => { body.status = 7; },
      (body: Reply) => { delete (body as Row).trackingDetails; },
      (body: Reply) => { body.trackingDetails = 'scans' as never; },
      (body: Reply) => { body.trackingDetails = Array.from({ length: 501 }, () => body.trackingDetails[0]!); },
      (body: Reply) => { body.trackingDetails[0] = 'scan' as never; },
      (body: Reply) => { delete body.trackingDetails[0]!.description_en; delete body.trackingDetails[0]!.description_gr; },
      (body: Reply) => { body.trackingDetails[0]!.description_en = ['We have picked up the shipment from the sender']; },
      (body: Reply) => { body.trackingDetails[0]!.description_gr = 7; },
      (body: Reply) => { body.trackingDetails[0]!.trackingState = { state: 'PICKED_UP' }; },
      (body: Reply) => { delete body.trackingDetails[0]!.createdAt; },
      (body: Reply) => { body.trackingDetails[0]!.createdAt = '2026-11-02 09:05:00'; },
      (body: Reply) => { body.trackingDetails[0]!.createdAt = '2026-11-02T11:05:00.000+02:00'; },
      (body: Reply) => { body.trackingDetails[0]!.createdAt = '2026-02-30T09:05:00.000Z'; },
    ]) {
      expect(() => parseSkroutz(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSkroutz([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown voucher, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(notFound())).rejects.toMatchObject({ kind: 'not_found' });
    // Only the service's own notice is a missing parcel.
    await expect(lookup(new Response('Bad request', { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('<html><title>Just a moment...</title></html>', { status: 400 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('Package not found', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 301, headers: { Location: 'https://www.skroutzlastmile.gr/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('<html><title>Access Denied</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><title>Skroutz Last Mile</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(reply(''))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply({ success: false, error_code: 401 }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[401, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known voucher and the unknown-voucher notice, and asks nothing for a number Skroutz Last Mile does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(notFound());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-12T13:42:05.520Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1234567890')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Skroutz Last Mile does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['Z9SAMPLE0DLV', 'Z9SAMPLE0DLV12', '1234567890', 'Z9SAMPLE_DLV1', 'Z9SAMPLE/DLV1', `Z9SAMPLE${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSkroutzNumber('z9sa-mple 0dlv1')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
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

  it('routes a voucher filed under Skroutz Last Mile to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'skroutz-last-mile' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'skroutz-last-mile', source: 'skroutz-last-mile', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${SKROUTZ_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Skroutz Last Mile status vocabulary', () => {
  it('stages every recorded wording with the stage its record gives', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string; language: string; confirmedBy: string }[];
    expect(entries.filter((entry) => entry.confirmedBy === 'live').length).toBeGreaterThan(11);
    for (const entry of entries) {
      const code = entry.code ?? '';
      expect(statusMap.stage(code || null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(skroutzStage(code, entry.language === 'en' ? entry.wording : '', entry.language === 'el' ? entry.wording : ''), entry.wording)
        .toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'skroutz-last-mile', providerCode: code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Another hub keeps the hub stage; a wording the map does not know falls to its state.
    expect(statusMap.stage('SCANNED', 'the shipment is at slm hub δείγμα')).toBe('in_transit');
    expect(statusMap.stage('SCANNED', 'sample wording')).toBe('in_transit');
    expect(statusMap.stage('PICKED_UP', 'sample wording')).toBeUndefined();
    expect(statusMap.stage(null, 'the shipment is at the sample point')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'skroutz-last-mile', providerCode: 'PICKED_UP', description: 'Sample wording' })).toEqual({ kind: 'unknown' });
  });
});
