import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CENTRAL_TRANSPORT_HISTORY, CENTRAL_TRANSPORT_TRACE, CentralTransportTracker } from './adapter.js';
import {
  centralTransportResult, normalizeCentralTransportNumber, parseCentralTransportHistory, parseCentralTransportTrace,
} from './parser.js';
import { centralTransportStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900000001';
const IN_TRANSIT = '90000000003';
const UNKNOWN = '900000009';

type Row = Record<string, unknown>;
type Trace = { d: Row & { ShipmentInfo: Row[] } };
type History = { d: Row & { TrackingHistories: (Row & { HistoryItems: Row[] })[] } };

const fixture = <T = Row>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const trace = (name: string, change: (shipment: Row, body: Trace) => void = () => {}) => {
  const body = fixture<Trace>(`${name}-trace`);
  change(body.d.ShipmentInfo[0]!, body);
  return body;
};
const history = (name: string, change: (body: History) => void = () => {}) => {
  const body = fixture<History>(`${name}-history`);
  change(body);
  return body;
};
const result = (name: string, number: string, changeTrace?: (shipment: Row) => void, changeHistory?: (body: History) => void) =>
  centralTransportResult(parseCentralTransportTrace(trace(name, changeTrace), number), parseCentralTransportHistory(history(name, changeHistory), number));
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The trace's answer and then the history's, for one lookup.
const replies = (...bodies: unknown[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const body of bodies) fetcher.mockResolvedValueOnce(body instanceof Response ? body : reply(body));
  return fetcher;
};

describe('Central Transport HTTP adapter', () => {
  it('traces the PRO number as the tracking page does, then reads the shipment’s history by its key, through the supplied transport', async () => {
    const fetcher = replies(trace('in-transit'), history('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CentralTransportTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 900-0000000-3 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[traceUrl, traceInit], [historyUrl, historyInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(traceUrl).toBe(CENTRAL_TRANSPORT_TRACE);
    expect(historyUrl).toBe(CENTRAL_TRANSPORT_HISTORY);
    for (const init of [traceInit, historyInit]) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(JSON.parse(String(traceInit.body))).toEqual({ data: { type: '1', typeName: 'PRO', items: [{ id: 0, number: IN_TRANSIT }] } });
    expect(JSON.parse(String(historyInit.body))).toEqual({ pro: '900-0000000-3', proNumKey: 1000003 });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'central-transport', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the history newest first and puts the summary’s delivery above it', () => {
    const delivered = result('delivered', DELIVERED);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered.', last_update: null, last_update_local: '2026-03-12T14:41:00', expected_delivery: null, weight_kg: 235.868 });
    expect(delivered.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-03-12T14:41:00', 'Delivered.', null, 'delivered'],
      ['2026-03-12T07:58:03', 'Out For Delivery', null, 'out_for_delivery'],
      // A day's rows come in id order, latest first.
      ['2026-03-11T23:20:45', 'Arrived at terminal', 'EXAMPLE CITY, OH', 'in_transit'],
      ['2026-03-11T03:15:10', 'Departed terminal', 'SAMPLETOWN, MI', 'in_transit'],
      // The repeated pickup row is kept once.
      ['2026-03-09T16:30:00', 'Picked Up', 'SAMPLETOWN, MI', 'accepted'],
    ]);
    expect(delivered.events!.every((event) => event.time === undefined && event.provider_code === undefined)).toBe(true);
    expect(delivered).not.toHaveProperty('summary_only');
    expect(JSON.stringify(delivered)).not.toMatch(/SAMPLE (?:SHIPPER|CONSIGNEE)|SAMPLE ST|EXAMPLE AVE|0000[01]\b|SAMPLEBOL|SAMPLEPO|SAMPLHU|1000001/);
  });

  it('keeps the summary’s newer status at its current location, the estimate and a row flagged as a service exception', () => {
    const transit = result('in-transit', IN_TRANSIT);
    expect(transit).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'In Transit', last_update_local: '2026-05-04T06:05:00', expected_delivery: '2026-05-06', weight_kg: 566.99 });
    expect(transit.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null, event.stage_source ?? null]))
      .toEqual([
        ['2026-05-04T06:05:00', 'In Transit', 'SAMPLE HUB, IN', 'in_transit', 'wording:language'],
        ['2026-05-02T09:00:00', 'Synthetic delay', 'SAMPLE HUB, IN', 'exception', 'carrier_map'],
        ['2026-05-01T14:10:00', 'Picked Up', 'SAMPLETOWN, MI', 'accepted', 'carrier_map'],
      ]);
    // A summary no newer than the newest row adds nothing.
    const same = result('in-transit', IN_TRANSIT, (shipment) => { shipment.StatusDate = '5/2/2026 9:00 AM'; shipment.StatusMessage = 'Synthetic delay'; });
    expect(same).toMatchObject({ current_stage: 'exception', last_status_text: 'Synthetic delay', last_update_local: '2026-05-02T09:00:00' });
    expect(same.events).toHaveLength(2);
    // A history listed oldest first is turned round.
    const reversed = result('delivered', DELIVERED, undefined, (body) => { body.d.TrackingHistories.reverse(); });
    expect(reversed.events!.map((event) => event.local_time)).toEqual(result('delivered', DELIVERED).events!.map((event) => event.local_time));
  });

  it('answers with the summary alone when the history is empty or cannot be read', async () => {
    const old = (shipment: Row) => Object.assign(shipment, { IsDelivered: false, StatusMessage: 'Contact Customer Service at (586) 467-1900.',
      StatusDate: '12/15/2022 10:02 AM', DeliveryDateEstimate: '12/15/2022' });
    const empty = { d: { __type: 'BusinessDomain.ProEvent.TrackDetails', ProNumber: null, TrackingHistories: [] } };
    const parsed = centralTransportResult(parseCentralTransportTrace(trace('delivered', old), DELIVERED), parseCentralTransportHistory(empty, DELIVERED));
    expect(parsed).toMatchObject({ status: 'unknown', summary_only: true, last_status_text: 'Contact Customer Service at (586) 467-1900.',
      last_update_local: '2022-12-15T10:02:00', expected_delivery: '2022-12-15' });
    expect(parsed).not.toHaveProperty('current_stage');
    expect(parsed.events).toEqual([{ local_time: '2022-12-15T10:02:00', description: 'Contact Customer Service at (586) 467-1900.' }]);

    // The page shows the history only when the summary turns it on; a history it no longer serves leaves the summary.
    for (const second of [new Response('', { status: 500 }), new Response('', { status: 404 }), reply('<html><title>Central Transport</title></html>'),
      reply({ d: null }), reply(history('delivered', (body) => { body.d.ProNumber = '900000002'; }))]) {
      await expect(carrier(replies(trace('delivered'), second)).track({ number: DELIVERED }))
        .resolves.toMatchObject({ current_stage: 'delivered', summary_only: true, events: [{ description: 'Delivered.' }] });
    }
    // A refusal, a rate limit or an outage of the history stands.
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      await expect(carrier(replies(trace('delivered'), new Response('', { status }))).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    }
    // Without a status clock or a row there is nothing to show.
    expect(() => centralTransportResult(parseCentralTransportTrace(trace('delivered', (shipment) => { shipment.StatusDate = ''; }), DELIVERED), []))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the tracker’s failure for an unknown PRO, and an empty or crowded trace, as inconclusive', () => {
    expect(() => parseCentralTransportTrace(fixture('unknown'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Central Transport could not trace the PRO number' }));
    expect(() => parseCentralTransportTrace(trace('delivered', (_shipment, body) => { body.d.ShipmentInfo = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCentralTransportTrace(trace('delivered', (shipment, body) => { body.d.ShipmentInfo.push(shipment); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when it names the whole PRO number asked, with or without dashes', () => {
    expect(() => parseCentralTransportTrace(trace('delivered'), '900000002'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Central Transport answered for another shipment' }));
    expect(() => parseCentralTransportTrace(trace('in-transit'), '9000000000'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseCentralTransportTrace(trace('in-transit'), '900-0000000-3')).toMatchObject({ pro: '900-0000000-3', key: 1000003 });
    expect(() => parseCentralTransportHistory(history('in-transit'), '90000000004'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Row, body: Trace) => { delete (body as Row).d; },
      (_shipment: Row, body: Trace) => { delete body.d.ServerResponseFailed; },
      (_shipment: Row, body: Trace) => { body.d.ShipmentInfo = 'shipments' as never; },
      (_shipment: Row, body: Trace) => { body.d.ShipmentInfo = ['shipment' as never]; },
      (shipment: Row) => { shipment.ProNumber = 900000001; },
      (shipment: Row) => { delete shipment.ProNumKey; },
      (shipment: Row) => { shipment.ProNumKey = '1000001'; },
      (shipment: Row) => { shipment.IsDelivered = 'true'; },
    ]) {
      expect(() => parseCentralTransportTrace(trace('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => result('delivered', DELIVERED, (shipment) => { shipment.StatusMessage = ['Delivered.']; }))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (body: History) => { delete (body as Row).d; },
      (body: History) => { body.d.TrackingHistories = 'days' as never; },
      (body: History) => { body.d.TrackingHistories[0] = 'day' as never; },
      (body: History) => { body.d.TrackingHistories[0]!.HistoryItems = 'rows' as never; },
      (body: History) => { body.d.TrackingHistories[0]!.HistoryItems[0] = 'row' as never; },
      (body: History) => { body.d.TrackingHistories[0]!.Date = '2026-03-12'; },
      (body: History) => { body.d.TrackingHistories[0]!.Date = 'Thursday, 31 February 2026'; },
      (body: History) => { body.d.TrackingHistories[0]!.HistoryItems[0]!.Time = '13:58:03 PM'; },
      (body: History) => { body.d.TrackingHistories[0]!.HistoryItems[0]!.StatusMessage = ''; },
      (body: History) => { delete body.d.TrackingHistories[0]!.HistoryItems[0]!.RowId; },
      (body: History) => { body.d.TrackingHistories[0]!.HistoryItems[0]!.IsSeviceException = 'false'; },
      (body: History) => { body.d.TrackingHistories = Array.from({ length: 201 }, () => body.d.TrackingHistories[0]!); },
    ]) {
      expect(() => parseCentralTransportHistory(history('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown PRO, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(replies(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('unknown'))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The site sends a retired page to its home page.
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.centraltransport.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Track Shipment - Central Transport</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    // ASP.NET's answer to a request it could not read.
    await expect(lookup({ Message: 'There was an error processing the request.', StackTrace: '', ExceptionType: '' }, { status: 500 }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the trace as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a lookup that failed to reach Central Transport once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(trace('delivered'))).mockResolvedValueOnce(reply(history('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    // A failed connection to the history fails the attempt, so the retry reads both again.
    const second = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(trace('delivered'))).mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(trace('delivered'))).mockResolvedValueOnce(reply(history('delivered')));
    await expect(carrier(second).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.not.toHaveProperty('summary_only');
    expect(second).toHaveBeenCalledTimes(4);
    await expect(carrier(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))).track({ number: DELIVERED }, { budgetMs: 2000 }))
      .rejects.toBeInstanceOf(UpstreamNetworkError);
  });

  it('rejects numbers Central Transport does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['90000000', '900000000012', 'PU-123-1234567', 'SAMPLETRACKING', '9'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCentralTransportNumber('900-0000000-3')).toBe(IN_TRANSIT);
    expect(normalizeCentralTransportNumber('9000000000')).toBe('9000000000');
  });

  it('declares no recognition: the tracker’s answer for an unknown PRO is its failure', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a PRO number filed under Central Transport to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => reply(String(url) === CENTRAL_TRANSPORT_TRACE
      ? trace('delivered') : history('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'central-transport' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'central-transport', source: 'central-transport', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([CENTRAL_TRANSPORT_TRACE, CENTRAL_TRANSPORT_HISTORY]);
  });
});

describe('Central Transport status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean; confirmedBy: string }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(centralTransportStage(entry.wording, false), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'central-transport', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(centralTransportStage(entry.wording, false), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'central-transport', providerCode: null, description: 'Out For Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'central-transport', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Other wording falls to the shared rules, and a flagged row without a mapped wording is an exception.
    expect(centralTransportStage('Arrived at terminal', false)).toEqual({ stage: 'in_transit', source: 'wording:language' });
    expect(centralTransportStage('Synthetic note', false)).toBeNull();
    expect(centralTransportStage('Synthetic note', true)).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(centralTransportStage('Delivered', true)).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
