import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';
import { parseXpoBrowser } from './browser.js';

const number = '990000001';
const other = '990000012';
const endpoint = `https://api.ltl.xpo.com/public-tracking/1.0/shipments/${number}/tracking`;
const stamp = Date.parse('2031-04-18T10:00:00Z');
const event = (description: string, time = stamp, type?: string) => ({
  eventHdr: { eventDesc: description, eventTmst: time, ...(type ? { eventTypeCd: type } : {}) },
  eventOccrdLoc: { cityName: 'Example City', stateCd: 'NY', postalCd: 'PRIVATE', locationLink: 'PRIVATE' },
});
const found = () => ({ code: '200', data: { proNbr: number, shipmentTracking: [{ proNbr: number,
  statusCd: '20', statusMessage: 'Delivered', consignee: { address: 'PRIVATE' },
  shipmentTrackingSummaryEvents: [event('Pickup', stamp - 1000, 'Pickup'), event('Delivered', stamp, 'Delivered')],
  shipmentTrackingDetailedEvents: [event('Reported picked up from XSA', stamp - 1000),
    event('Final delivered from XSA - P&D route: PRIVATE'), event('Record updated', stamp + 1000)],
}] } });
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const capture = (body: unknown, status = 200, url = endpoint) => ({ url, status, body: JSON.stringify(body),
  headers: {}, truncated: false, base64Encoded: false, error: null });

describe('XPO current public tracker', () => {
  it('binds both identities, combines milestones with full history and retains epoch instants', () => {
    const result = parseXpoBrowser(found(), number);
    expect(result).toMatchObject({ status: 'delivered', provider_code: '20', current_stage: 'delivered',
      last_update: '2031-04-18T10:00:00.000Z', events: [{ stage: 'delivered', location: 'Example City, NY' }, { stage: 'accepted' }] });
    expect(result.events).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    for (const part of ['envelope', 'shipment']) {
      const payload = found();
      if (part === 'envelope') payload.data.proNbr = other;
      else payload.data.shipmentTracking[0]!.proNbr = other;
      expect(() => parseXpoBrowser(payload, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const partial = found(); partial.data.shipmentTracking[0]!.shipmentTrackingDetailedEvents = [];
    expect(parseXpoBrowser(partial, number).events).toHaveLength(2);
    const invalid = found(); invalid.data.shipmentTracking[0]!.shipmentTrackingDetailedEvents[0]!.eventHdr.eventTmst = NaN;
    expect(() => parseXpoBrowser(invalid, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('recovers after a firewall response and records the original failure', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('The requested URL was rejected. Please consult with your administrator.'));
    const browserFetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ skipHttp: true, maxTier: 3, captureResponses: [endpoint] });
      expect(request.maxTimeout).toBeLessThan(8000);
      return reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture(null, 428), capture(found())] });
    });
    const recorded: unknown[] = [];
    const carrier = adapter({ env: {}, fetcher, trawl: new TrawlClient('http://browser.test', browserFetcher),
      recorder: { ...NOOP_RECORDER, step: value => { recorded.push(value); } }, browserExecutablePath: null });
    await expect(carrier.track({ number }, { budgetMs: 8000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'challenge' }, { step: 'trawl', outcome: 'ok' }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    browserFetcher.mockClear();
    await expect(carrier.recognize!(number)).rejects.toMatchObject({ kind: 'challenge' });
    expect(browserFetcher).not.toHaveBeenCalled();
  });

  it('uses only the final whole-PRO response and retains challenge, rate-limit and transport failures', async () => {
    for (const [responses, kind] of [
      [[capture(found(), 200, endpoint.replace(number, other))], 'challenge'],
      [[capture(found()), capture(null, 428)], 'challenge'],
      [[capture(null, 429)], 'rate_limited'],
      [[{ ...capture(found()), truncated: true }], 'transport'],
      [[capture({ code: '200', data: {} })], 'schema'],
    ] as const) {
      const trawl = new TrawlClient('http://browser.test', async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: responses }));
      const carrier = adapter({ env: {}, trawl, recorder: NOOP_RECORDER, browserExecutablePath: null });
      await expect(carrier.recognizeWithBrowser!(number, { budgetMs: 8000 })).rejects.toMatchObject({ kind });
    }
  });
});
