import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adapter, DelhiveryTracker } from './adapter.js';
import { parseDelhivery } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import { classifyDelhiveryStatus } from './status.js';
import { resolveResult } from '../../core/result/resolve.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const NUMBER = '0000000000001';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const payload = () => structuredClone(fixture);
const FREIGHT = '00000000000001';
const freightFixture = JSON.parse(readFileSync(new URL('./fixtures/freight.json', import.meta.url), 'utf8'));
const freight = () => structuredClone(freightFixture);
describe('Delhivery direct tracking', () => {
  it('recognizes shared numeric formats through matching HTTP shipment activity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(NUMBER, { budgetMs: 1000 })).resolves.toEqual({ known: true, lastActivityAt: '2026-01-03T08:30:00.000Z' });
    await expect(instance.recognize!('YT0000000000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('separates explicit missing waybills from malformed recognition replies', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusCode: 200, data: [], message: 'invalid AWB or very old package' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusCode: 200, data: [] })));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(NUMBER, { budgetMs: 1000 })).resolves.toEqual({ known: false });
    await expect(instance.recognize!(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'schema' });
  });
  it('uses the current timestamp once and excludes future rails and private fields', () => {
    const result = parseDelhivery(payload(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-01-03T14:00:00+05:30', delivered_at: '2026-01-03T14:00:00+05:30' });
    expect(result.events).toHaveLength(3);
    expect(result.events?.[1]).not.toHaveProperty('time');
    expect(result.events?.[2]?.stage).toBe('in_transit');
    expect(result.events?.[0]).toMatchObject({ summary_snapshot: true });
    expect(JSON.stringify(result)).not.toMatch(/Private|private-reference|Example Address|Out For Delivery/);
    expect(JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')).capabilities).toEqual(['history', 'delivered_at']);
  });
  it('requires one matching identity and the specific negative outcome', () => {
    for (const value of [null, {}, { statusCode: 200, data: [] }, { ...payload(), data: [payload().data[0], payload().data[0]] }]) {
      expect(() => parseDelhivery(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const value = payload(); value.data[0].awb = '0000000000002';
    expect(() => parseDelhivery(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    value.data[0].awb = `${NUMBER}${' '.repeat(64)}0000000000002`;
    expect(() => parseDelhivery(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDelhivery({ statusCode: 200, data: [], message: 'invalid AWB or very old package' }, NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'not_found' }));
  });
  it('reads a current status given as a token like its words', () => {
    const value = payload(); value.data[0].status = { status: 'IN_TRANSIT', statusDateTime: '2026-01-03T14:00:00' };
    expect(parseDelhivery(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });
  it('keeps unknown status and historical scan semantics separate', () => {
    const value = payload(); value.data[0].status = { status: 'New current status', statusDateTime: 'not a date' };
    value.data[0].trackingStates[0].scans[0].scan = 'New scan';
    const result = parseDelhivery(value, NUMBER);
    expect(result.status).toBe('unknown'); expect(result.last_update).toBeNull();
    expect(result.events?.[0]).not.toHaveProperty('stage');
  });
  it('never stamps repeated historical labels with the current snapshot time', () => {
    const value = payload(); value.data[0].status.status = 'In Transit';
    value.data[0].trackingStates = [{ label: 'In Transit', scans: [
      { scan: 'In Transit', cityLocation: 'Earlier hub' }, { scan: 'In Transit', cityLocation: 'Later hub' },
    ] }];
    const result = parseDelhivery(value, NUMBER);
    expect(result.events?.filter(event => event.time)).toEqual([expect.objectContaining({ summary_snapshot: true, description: 'In Transit' })]);
    expect(result.events?.filter(event => event.location).every(event => !event.time)).toBe(true);
  });
  it('keeps calendar days unresolved rather than creating midnight scans or delivery times', () => {
    const value = payload(); value.data[0].status.statusDateTime = '2026-01-03';
    value.data[0].trackingStates[0].scans[0].scanDateTime = '2026-01-03';
    const result = parseDelhivery(value, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ summary_snapshot: true, provider_time_text: '2026-01-03' });
    expect(result.events?.[1]).toMatchObject({ location: 'Example City', provider_time_text: '2026-01-03' });
    expect(result.events?.every(event => !event.time)).toBe(true);
  });
  it('deduplicates a current scan by its instant across equivalent timezone representations', () => {
    const value = payload();
    value.data[0].trackingStates[0].scans[0].scanDateTime = '2026-01-03T08:30:00Z';
    const result = parseDelhivery(value, NUMBER);
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', time: '2026-01-03T08:30:00Z', location: 'Example City' });
    expect(result.events?.some(event => event.summary_snapshot)).toBe(false);
  });
  it('keeps an undated current summary separate from repeated historical labels', () => {
    const value = payload();
    value.data[0].status.statusDateTime = '';
    value.data[0].trackingStates[0].scans = [
      { scan: 'Delivered', cityLocation: 'Earlier delivery office', scanDateTime: '' },
      { scan: 'Delivered', cityLocation: 'Later delivery office', scanDateTime: '' },
    ];
    const result = parseDelhivery(value, NUMBER);
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ description: 'DELIVERED', summary_snapshot: true });
    expect(result.events?.[0]!.location).toBeUndefined();
    expect(result.events?.filter(event => event.location)).toHaveLength(3);
    expect(result.events?.every(event => !event.time)).toBe(true);
  });
  it('keeps current return delivery distinct from recipient delivery history', () => {
    const value = payload(); value.data[0].status.status = 'RTO DELIVERED';
    const result = parseDelhivery(value, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(result.events?.[0]).toMatchObject({ stage: 'returned', summary_snapshot: true });
    expect(result.events?.[1]!.stage).toBe('delivered');
    expect(result.delivered_at).toBeUndefined();
  });
  it('keeps the returned flow moving until the shipment status confirms delivery', () => {
    const value = JSON.parse(readFileSync(new URL('./fixtures/return-in-transit.json', import.meta.url), 'utf8'));
    const result = parseDelhivery(value, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'RETURNED' });
    expect(result.events).toEqual([
      expect.objectContaining({ description: 'In Transit', stage: 'in_transit', provider_leg: 'return', summary_snapshot: true }),
      expect.objectContaining({ stage: 'in_transit', provider_leg: 'return', location: 'Example City' }),
    ]);
    expect(result.events?.[1]).not.toHaveProperty('time');
    expect(result.delivered_at).toBeUndefined();
    value.data[0].hqStatus = 'Delivered';
    expect(parseDelhivery(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned' });
    value.data[0].hqStatus = 'Unfamiliar status';
    expect(parseDelhivery(value, NUMBER)).toMatchObject({ status: 'unknown' });
    expect(parseDelhivery(value, NUMBER).current_stage).toBeUndefined();
    expect(resolveResult(parseDelhivery(value, NUMBER)).events.every(event => event.stage !== 'returned')).toBe(true);
    delete value.data[0].hqStatus;
    expect(parseDelhivery(value, NUMBER).events).toHaveLength(1);
  });
  it('marks sender delivery and individual return scans without relabelling outbound scans', () => {
    const value = payload();
    value.data[0].status.status = 'DELIVERED_SELLER';
    value.data[0].status.statusType = 'RT';
    value.data[0].trackingStates[1].scans = [{
      scan: 'Delivered', scanType: 'RT', cityLocation: 'Example Return Hub', scanDateTime: '2026-01-03T13:00:00',
    }];
    const result = parseDelhivery(value, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(result.events?.find(event => event.location === 'Example Return Hub'))
      .toMatchObject({ stage: 'returned', provider_leg: 'return' });
    const outbound = result.events?.find(event => event.location === 'Example City');
    expect(outbound?.stage).toBe('delivered');
    expect(outbound).not.toHaveProperty('provider_leg');
    expect(result.delivered_at).toBeUndefined();
  });
  it('does not let an outbound scan hide a return snapshot at the same instant', () => {
    const value = payload();
    value.data[0].status.statusType = 'RT';
    value.data[0].trackingStates[0].scans[0].scanDateTime = value.data[0].status.statusDateTime;
    const result = parseDelhivery(value, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(result.events?.filter(event => event.summary_snapshot)).toEqual([
      expect.objectContaining({ stage: 'returned', provider_leg: 'return' }),
    ]);
    expect(result.events?.find(event => event.location === 'Example City' && event.description === 'Delivered')?.stage)
      .toBe('delivered');
  });
  it('keeps identical outbound and return scan labels separate', () => {
    const value = payload();
    value.data[0].trackingStates = [{ label: 'Delivered', scans: [
      { scan: 'Delivered', scanType: 'DL', scanDateTime: '2026-01-03T13:00:00', cityLocation: 'Example City' },
      { scan: 'Delivered', scanType: 'RT', scanDateTime: '2026-01-03T13:00:00', cityLocation: 'Example City' },
    ] }];
    const rows = parseDelhivery(value, NUMBER).events?.filter(event => !event.summary_snapshot);
    expect(rows).toHaveLength(2);
    expect(rows?.map(event => event.stage)).toEqual(['delivered', 'returned']);
  });
  it('keeps scans of one instant in the carrier\'s order, after the status snapshot', () => {
    const value = payload();
    value.data[0].trackingStates = [{ label: 'In Transit', scans: [
      { scan: 'Manifested', scanType: 'UD', scanDateTime: '2026-01-02T06:00:00', cityLocation: 'Example City' },
      { scan: 'Picked Up', scanType: 'UD', scanDateTime: '2026-01-02T08:00:00', cityLocation: 'Example City' },
      { scan: 'In Transit', scanType: 'UD', scanDateTime: '2026-01-02T10:00:00', cityLocation: 'Example Hub' },
      { scan: 'Dispatched', scanType: 'UD', scanDateTime: '2026-01-02T10:00:00', cityLocation: 'Example Hub' },
    ] }];
    const scans = ['Dispatched', 'In Transit', 'Picked Up', 'Manifested'];
    expect(parseDelhivery(value, NUMBER).events?.map(event => event.description)).toEqual(['DELIVERED', ...scans]);
    value.data[0].status.statusDateTime = '2026-01-02T10:00:00';
    expect(parseDelhivery(value, NUMBER).events?.map(event => event.description)).toEqual(['DELIVERED', ...scans]);
  });
  it('distinguishes future rail states from malformed completed history', () => {
    for (const state of [null, { scans: {} }, { scans: [null] }, { scans: [{}] }]) {
      const value = payload(); value.data[0].trackingStates = [state];
      expect(() => parseDelhivery(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = payload(); value.data[0].trackingStates = [{ label: 'Out For Delivery' }];
    const result = parseDelhivery(value, NUMBER);
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]).toMatchObject({ description: 'DELIVERED', summary_snapshot: true });
  });
  it('dates reached freight milestones whose scans carry no time', () => {
    const result = parseDelhivery(freight(), FREIGHT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-03-04T10:00:00+05:30',
      delivered_at: '2026-03-02T19:45:00+05:30', expected_delivery: null });
    // The delivered status dates a later audit and repeats the milestone, so it adds no snapshot.
    expect(result.events?.filter(event => event.time).map(event => [event.description, event.time, event.stage])).toEqual([
      ['Delivered', '2026-03-02T19:45:00+05:30', 'delivered'],
      ['Out for Delivery', '2026-03-02T10:30:00+05:30', 'out_for_delivery'],
      ['On the Way', '2026-02-27T06:00:00+05:30', 'in_transit'],
      ['Picked Up', '2026-02-24T09:15:00+05:30', 'accepted'],
    ]);
    expect(result.events?.filter(event => !event.time).map(event => [event.description, event.location, event.stage])).toEqual([
      ['In Transit', 'Example Gateway', 'in_transit'], ['In Transit', 'Example Hub', 'in_transit'],
      ['Dispatched', 'Example City', 'out_for_delivery'], ['Delivered', 'Example City', 'delivered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Private|private-|Example Address/);
    // Without a dated delivered milestone, the status still dates the delivery.
    const undated = freight();
    undated.data[0].trackingStates[3].date = 'Mon, 2 Mar';
    const snapshot = parseDelhivery(undated, FREIGHT);
    expect(snapshot.events?.[0]).toMatchObject({ description: 'DELIVERED', time: '2026-03-04T10:00:00+05:30', stage: 'delivered', summary_snapshot: true });
    expect(snapshot.delivered_at).toBe('2026-03-04T10:00:00+05:30');
  });
  it('reads a milestone year from its weekday before the status date, or keeps the text', () => {
    const value = freight();
    value.data[0].status.statusDateTime = '2027-01-05T10:00:00';
    value.data[0].trackingStates[0].date = 'Wed, 30 Dec, 6:00 PM';
    value.data[0].trackingStates[1].date = 'Thu, 30 Dec, 6:00 PM';
    value.data[0].trackingStates[2].date = 'Mon, 2 Mar, 10:30';
    value.data[0].currentTrackIndex = 2;
    const events = parseDelhivery(value, FREIGHT).events ?? [];
    expect(events.find(event => event.description === 'Picked Up')).toMatchObject({ time: '2026-12-30T18:00:00+05:30' });
    for (const description of ['On the Way', 'Out for Delivery']) {
      expect(events.find(event => event.description === description)).not.toHaveProperty('time');
    }
    expect(events.find(event => event.description === 'On the Way')).toMatchObject({ provider_time_text: 'Thu, 30 Dec, 6:00 PM' });
    // The delivered milestone lies past the current index: the future rail.
    expect(events.filter(event => event.description === 'Delivered')).toEqual([expect.objectContaining({ location: 'Example City' })]);
    value.data[0].status.statusDateTime = '';
    expect(parseDelhivery(value, FREIGHT).events?.filter(event => event.time)).toEqual([]);
    const dated = freight();
    dated.data[0].trackingStates[3].scans[0].scanDateTime = '2026-03-02T19:40:00';
    const result = parseDelhivery(dated, FREIGHT);
    expect(result.events?.filter(event => event.description === 'Delivered').map(event => event.time)).toEqual(['2026-03-02T19:40:00+05:30']);
    expect(result.delivered_at).toBe('2026-03-04T10:00:00+05:30');
  });
  it('files lost, cancelled and returned-to-seller statuses', () => {
    for (const [status, scan, flow, stage] of [
      ['LOST', 'LOST', 'Closed', 'exception'], ['CANCELLED', 'Canceled', 'Reverse', 'exception'],
      ['DELIVERED_SELLER', 'RTO', 'Returned', 'returned'], ['DELIVERED_SELLER', 'DTO', 'Reverse', 'returned'],
    ] as const) {
      const value = payload();
      value.data[0].currentFlow = flow;
      value.data[0].status = { status, statusType: 'DL', statusDateTime: '2026-01-03T14:00:00' };
      value.data[0].trackingStates = [{ label: 'Example', scans: [{ scan, scanType: 'DL', scanDateTime: '', cityLocation: 'Example City' }] }];
      const result = parseDelhivery(value, NUMBER);
      expect(result).toMatchObject({ status: 'exception', current_stage: stage });
      expect(result.events?.find(event => event.location === 'Example City')?.stage).toBe(stage);
      expect(result.delivered_at).toBeUndefined();
    }
    for (const entry of statuses.entries) expect(classifyDelhiveryStatus(entry.wording)?.stage, entry.wording).toBe(entry.stage);
  });
  it('passes the website headers and bounded cancellation into the public read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload())));
    await new DelhiveryTracker({ fetcher }).fetch(NUMBER, { budgetMs: 1000 });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://dlv-api.delhivery.com/v3/unified-tracking-new?wbn=${NUMBER}`);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Origin: 'https://www.delhivery.com', Referer: 'https://www.delhivery.com/' });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
