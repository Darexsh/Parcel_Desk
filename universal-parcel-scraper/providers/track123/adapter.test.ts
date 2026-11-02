import { describe, expect, it } from 'vitest';
import { parseTrack123Response, adapter, TRACK123_QUERY, TRACK123_POLL } from './adapter.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { universalPlan } from '../plan.js';

const NUMBER = '909876543210';
const event = { trackingNo: NUMBER, eventTime: '2026-01-08 10:00:00', timezone: '-05:00',
  eventTimeUtc: '2026-01-08 15:00:00', eventDetail: 'Delivered', address: 'Example facility' };
const fixture = () => ({ code: '00000', data: { landWaybillLists: [{ trackingNo: NUMBER,
  localProviderCode: 'fedex', querying: false, hasTrackingDetails: true, localDetails: [{ ...event }] }] } });

describe('Track123 public FedEx history', () => {
  it('preserves the wall time and explicit offset as well as provider provenance', () => {
    expect(parseTrack123Response(fixture(), NUMBER)).toMatchObject({ tracking_provider: 'Track123',
      reported_carriers: ['FedEx'], events: [{ time: '2026-01-08T15:00:00.000Z', local_time: '2026-01-08T10:00:00', stage: 'delivered' }] });
  });
  it('rejects another shipment, another provider and another event identity', () => {
    for (const change of [(p: ReturnType<typeof fixture>) => { p.data.landWaybillLists[0]!.trackingNo += '0'; },
      (p: ReturnType<typeof fixture>) => { p.data.landWaybillLists[0]!.localProviderCode = 'other'; },
      (p: ReturnType<typeof fixture>) => { p.data.landWaybillLists[0]!.localDetails[0]!.trackingNo = '908765432109'; }]) {
      const payload = fixture(); change(payload); expect(() => parseTrack123Response(payload, NUMBER)).toThrow(/match|Unbound/);
    }
  });
  it('does not turn rejection, polling or absent history into not-found', () => {
    expect(() => parseTrack123Response({ code: 'B0001' }, NUMBER)).toThrow(/refused/);
    const payload = fixture(); payload.data.landWaybillLists[0]!.querying = true;
    expect(() => parseTrack123Response(payload, NUMBER)).toThrow(/retrieving/);
    payload.data.landWaybillLists[0]!.querying = false; payload.data.landWaybillLists[0]!.localDetails = [];
    expect(() => parseTrack123Response(payload, NUMBER)).toThrow(/available tracking history/);
  });
  it('rejects contradictory clocks and keeps an unzoned clock local', () => {
    const payload = fixture(); payload.data.landWaybillLists[0]!.localDetails[0]!.timezone = '+01:00';
    expect(() => parseTrack123Response(payload, NUMBER)).toThrow(/Conflicting/);
    payload.data.landWaybillLists[0]!.localDetails[0]!.timezone = '';
    expect(parseTrack123Response(payload, NUMBER).events![0]).not.toHaveProperty('time');
  });
  it('is opt-in and restricted to the requested FedEx carrier', () => {
    expect(universalPlan({ carriers: ['fedex'], trackingNumber: NUMBER }).sources).not.toContain('Track123');
    expect(universalPlan({ carriers: ['ups', 'fedex'], trackingNumber: NUMBER, enableTrack123: true }).sources).not.toContain('Track123');
    expect(universalPlan({ carriers: ['fedex'], trackingNumber: NUMBER, enableTrack123: true }).sources[0]).toBe('Track123');
    expect(universalPlan({ carriers: ['fedex'], trackingNumber: 'EXAMPLE123', enableTrack123: true }).sources).not.toContain('Track123');
  });
  it('does not hide a failed poll behind an earlier history', async () => {
    const trawl = { scrape: async () => ({ capturedResponses: [
      { url: TRACK123_QUERY, status: 200, trackingNumberSubmitted: NUMBER, body: JSON.stringify(fixture()) },
      { url: TRACK123_POLL, status: 0, trackingNumberSubmitted: NUMBER, body: null, error: 'request-failed' },
    ] }) } as unknown as TrawlClient;
    const tracker = adapter({ trawl, env: {}, recorder: NOOP_RECORDER, browserExecutablePath: null });
    await expect(tracker.track({ number: NUMBER, carrier: 'fedex' })).rejects.toThrow(/Incomplete/);
    await expect(tracker.track({ number: NUMBER, carrier: 'ups' })).rejects.toThrow(/only for named FedEx/);
  });
});
