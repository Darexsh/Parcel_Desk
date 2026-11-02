import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/index.js';
import { adapter, CneTracker } from './adapter.js';
import { normalizeCneNumber, parseCne } from './parser.js';

const NUMBER = '3A5V000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/returned.json', import.meta.url), 'utf8'));
const HANDOFF_NUMBER = '3A5V000000002';
const handoffFixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered-handoff.json', import.meta.url), 'utf8'));
afterEach(() => vi.restoreAllMocks());

describe('CNE response projection', () => {
  it('binds the shipment and reverses oldest-first history, keeping zone-less clocks as wall clocks', () => {
    const result = parseCne(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      destination_country: 'SA', last_update: null, last_update_local: '2026-01-04T14:32:41' });
    expect(result.events?.map(event => event.stage)).toEqual(['returned', 'exception', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-01-04T14:32:41', location: 'CN.Example Sort Facility' });
    expect(result.events?.map(event => event.local_time)).toEqual(['2026-01-04T14:32:41', '2026-01-03T01:02:08',
      '2026-01-02T19:47:49', '2026-01-02T12:47:13', '2026-01-01T10:21:12']);
    expect(result.events?.every(event => event.time === undefined && event.provider_time_text === undefined)).toBe(true);
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
    expect(carrierDefinition('cne').tracking).toMatchObject({ localClocks: true });
  });

  it.each(['different', 'missing', 'conflicting'])('rejects %s source identity', mode => {
    const payload = fixture();
    if (mode === 'different') payload.Response_Info.trackingNbr = '3A5V999999999';
    if (mode === 'missing') delete payload.Response_Info.trackingNbr;
    if (mode === 'conflicting') payload.Response_Info.Number_t = '3A5V999999999';
    expect(() => parseCne(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('distinguishes the exact absent-order reply from rejections and contradictory negatives', () => {
    expect(() => parseCne({ ReturnValue: 0, cMess: '订单不存在' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [{ ReturnValue: -5555, cMess: '' }, { ReturnValue: 0, cMess: 'busy' },
      { ReturnValue: 0, cMess: '订单不存在', Response_Info: fixture().Response_Info }]) {
      expect(() => parseCne(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseCne({ ReturnValue: '1' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires a nonempty bounded history and rejects malformed rows', () => {
    const payload = fixture(); payload.trackingEventList = [];
    expect(() => parseCne(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const row of [null, {}, { details: [] }]) {
      const malformed = fixture(); malformed.trackingEventList.unshift(row);
      expect(() => parseCne(malformed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    payload.trackingEventList = Array.from({ length: 1001 }, () => fixture().trackingEventList[0]);
    expect(() => parseCne(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['2026-01-04T14:32:41+99:00', '2026-01-04T14:32:41+02:99', '2026-01-04T14:32:41+14:01', '2026-02-30T14:32:41Z',
    '2026-02-30 14:32:41', '2026-01-04 24:00:00', '2026-01-04 14:32'])('keeps an invalid clock unresolved: %s', clock => {
    const payload = fixture(); payload.trackingEventList.at(-1).date = clock;
    const result = parseCne(payload, NUMBER);
    expect(result.last_update).toBeNull(); expect(result.last_update_local).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: clock });
    expect(result.events?.[0]?.time).toBeUndefined(); expect(result.events?.[0]?.local_time).toBeUndefined();
  });

  it('uses explicit instants without borrowing older clocks or changing source order', () => {
    const payload = fixture(); delete payload.Response_Info.status;
    payload.trackingEventList.at(-1).details = 'Delivered';
    payload.trackingEventList.at(-1).date = '2026-01-04T14:32:41+08:00';
    const placed = parseCne(payload, NUMBER);
    expect(placed).toMatchObject({ status: 'delivered', last_update: '2026-01-04T14:32:41+08:00', delivered_at: '2026-01-04T14:32:41+08:00' });
    expect(placed.last_update_local).toBeUndefined(); expect(placed.events?.[1]?.local_time).toBe('2026-01-03T01:02:08');
    payload.trackingEventList.at(-1).date = 'invalid';
    payload.trackingEventList[0].date = '2026-01-01T00:00:00Z';
    const result = parseCne(payload, NUMBER);
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
    expect(result.last_update_local).toBeUndefined();
    expect(result.events?.at(-1)?.time).toBe('2026-01-01T00:00:00Z');
  });

  it('follows a named last-mile supplier and its transfer number through to delivery', () => {
    const result = parseCne(handoffFixture(), HANDOFF_NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', destination_country: 'GB',
      delivery_carrier: 'royal-mail', delivery_tracking_number: 'ZZ000000005GB', last_status_text: 'Signature Obtained；Signature Obtained.' });
    expect(result.events?.map(event => [event.stage, event.stage_source])).toEqual([
      ['delivered', 'carrier_map'], ['in_transit', 'carrier_map'], ['in_transit', 'wording:language'], ['in_transit', 'carrier_map'],
      ['in_transit', 'carrier_map'], ['in_transit', 'carrier_map'], ['in_transit', 'carrier_map'], ['in_transit', 'carrier_map'],
      ['accepted', 'carrier_map'], ['registered', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-02-10T12:00:00' });
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads its own labels in any capitalisation, the arrival in the destination country and at its sorting centre as transit', () => {
    for (const details of ['Arrived at destination', 'Arrived At Destination', 'ARRIVED AT CNE FACILITY', 'your shipment has arrived at sorting center',
      'Your shipment is in process at sorting center', 'Handled by local carrier']) {
      const payload = handoffFixture();
      payload.trackingEventList.push({ date: '2026-02-11 09:00:00', details, place: 'Example City', state: '2' });
      expect(parseCne(payload, HANDOFF_NUMBER).events?.[0]).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
    }
  });

  it('reads its labels for the destination network’s arrival and hand-over on Beijing time, and leaves its other rows abroad on wall clocks', () => {
    const payload = handoffFixture();
    payload.Response_Info.status = '2'; payload.Response_Info.Destination = 'CH';
    payload.trackingEventList.splice(4);
    payload.trackingEventList.push(
      { date: '2026-02-05 08:05:00', place: 'Zurich Airport - Switzerland', details: 'Arrived at Import Airport', state: 2 },
      { date: '2026-02-06 03:44:00', place: 'EXAMPLELAND', details: 'Arrived at destination', state: 2 },
      { date: '2026-02-06 04:14:00', place: 'EXAMPLELAND', details: 'HANDLED BY LOCAL CARRIER；Example partner note.', state: 2 },
      { date: '2026-02-06 09:30:00', place: 'Zurich', details: 'Accepted, Hub Facility', state: 2 },
    );
    const result = parseCne(payload, HANDOFF_NUMBER);
    expect(result.events?.slice(0, 4).map(event => [event.description, event.time, event.local_time])).toEqual([
      // A partner's own wording keeps its wall clock, and so does the import airport's row.
      ['Accepted, Hub Facility', undefined, '2026-02-06T09:30:00'],
      ['HANDLED BY LOCAL CARRIER；Example partner note.', '2026-02-06T04:14:00+08:00', undefined],
      ['Arrived at destination', '2026-02-06T03:44:00+08:00', undefined],
      ['Arrived at Import Airport', undefined, '2026-02-05T08:05:00'],
    ]);
    // Places date the wall clocks; the rows CNE writes on Beijing time keep their instants.
    const dated = dateLocalClocks('cne', result);
    expect(dated.events?.slice(0, 4).map(event => [event.time, event.time_zone])).toEqual([
      ['2026-02-06T09:30:00+01:00', 'Europe/Zurich'],
      ['2026-02-06T04:14:00+08:00', undefined],
      ['2026-02-06T03:44:00+08:00', undefined],
      ['2026-02-05T08:05:00+01:00', 'Europe/Zurich'],
    ]);
    payload.trackingEventList.pop();
    expect(parseCne(payload, HANDOFF_NUMBER)).toMatchObject({ last_update: '2026-02-06T04:14:00+08:00' });
    expect(parseCne(payload, HANDOFF_NUMBER)).not.toHaveProperty('last_update_local');
  });

  it('names a supplier only with the transfer number it tracks', () => {
    const payload = handoffFixture(); payload.Response_Info.Number_t = HANDOFF_NUMBER; delete payload.Response_Info.transNbr;
    const result = parseCne(payload, HANDOFF_NUMBER);
    expect(result.delivery_carrier).toBeUndefined(); expect(result.delivery_tracking_number).toBeUndefined();
    expect(deliveryHandoff('cne', HANDOFF_NUMBER, result)).toBeNull();
  });

  it('names no carrier for a supplier outside the catalog and follows no unnamed transfer', () => {
    const payload = handoffFixture(); payload.lastMileSupplier = { enName: 'Example Courier', code: 'XX Example' };
    expect(parseCne(payload, HANDOFF_NUMBER)).toMatchObject({ delivery_tracking_number: 'ZZ000000005GB' });
    expect(parseCne(payload, HANDOFF_NUMBER).delivery_carrier).toBeUndefined();
    delete payload.lastMileSupplier;
    const result = parseCne(payload, HANDOFF_NUMBER);
    expect(result.delivery_tracking_number).toBeUndefined(); expect(result.delivery_carrier).toBeUndefined();
  });

  it('takes a delivered summary over a history that stops at the hand-off, without dating the delivery', () => {
    const payload = handoffFixture(); payload.trackingEventList.splice(6);
    payload.trackingEventList.at(-1).date = '2026-02-06T07:00:00+08:00';
    const result = parseCne(payload, HANDOFF_NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived At The Delivery Company', last_update: '2026-02-06T07:00:00+08:00' });
    expect(result.delivered_at).toBeUndefined();
    payload.Response_Info.status = '2';
    expect(parseCne(payload, HANDOFF_NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it.each([['5', 'customs'], ['7', 'exception'], ['8', 'returned']])('reads summary code %s as %s', (code, stage) => {
    const payload = handoffFixture(); payload.Response_Info.status = code;
    expect(parseCne(payload, HANDOFF_NUMBER)).toMatchObject({ current_stage: stage, current_stage_source: 'carrier_map' });
  });

  it('reads an unknown partner wording by its code and keeps a partner acceptance in transit', () => {
    const payload = handoffFixture(); const latest = payload.trackingEventList.at(-1);
    latest.details = 'Partner wording no rule knows'; latest.state = 2;
    expect(parseCne(payload, HANDOFF_NUMBER).events?.[0]).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map', provider_code: '2' });
    delete latest.state;
    expect(parseCne(payload, HANDOFF_NUMBER).events?.[0]?.stage).toBeUndefined();
    latest.details = 'Accepted, Hub Facility';
    expect(parseCne(payload, HANDOFF_NUMBER).events?.[0]).toMatchObject({ stage: 'accepted' });
    latest.state = 2;
    expect(parseCne(payload, HANDOFF_NUMBER).events?.[0]).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('does not infer a terminal stage from an unknown summary code', () => {
    const payload = fixture(); payload.Response_Info.status = '900'; payload.Response_Info.Destination = 'SA-invalid';
    payload.trackingEventList = [{ details: 'Unrecognized processing milestone', date: '2026-01-01 12:00:00' }];
    const result = parseCne(payload, NUMBER);
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined(); expect(result.destination_country).toBeUndefined();
  });
});

describe('CNE retrieval', () => {
  it('reproduces the official WASM signing vectors in one anonymous request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_791_158_437_184);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await instance.track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://wapi.cne.com/tracking/officialWebsite?t=1791158437184');
    // Vectors from the public WASM using synthetic inputs, including the
    // first twelve timestamp digits and the prefix's final space.
    expect(init).toMatchObject({ method: 'POST', headers: { signature: 'f5a73ee0b15b192604fb1f8bbba0f983' },
      body: JSON.stringify({ lan: 'en', logisticsNo: NUMBER, md5: 'ee2b274a2a722ee10a45a715cdc8cab7' }) });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(normalizeCneNumber('3a5v-000000001')).toBe(NUMBER);
  });

  it.each(['123', `${NUMBER},OTHER`, `${NUMBER}&no=OTHER`])('rejects invalid input %s before I/O', async number => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CneTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s separate from parcel absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new CneTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });

  it('honors cancellation and bounds streaming responses', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CneTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new CneTracker({ fetcher }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
