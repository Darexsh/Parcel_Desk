import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PANDU_LOGISTICS_ENDPOINT, PanduLogisticsTracker } from './adapter.js';
import { normalizePanduLogisticsNumber, panduLogisticsWording, parsePanduLogistics } from './parser.js';
import { panduLogisticsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '30000000001';
const IN_TRANSIT = 'ABCDE00000000002';
const UNKNOWN = '30000000000';

type Row = Record<string, unknown>;
type Answer = { detail: Row[]; track: Row[] };
type Reply = Row & { json: Answer; request: Row & { response: Row }; html: string };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (answer: Answer, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.json, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pandu Logistics HTTP adapter', () => {
  it('posts the whole number in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PanduLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' abcde 0000-0000-002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PANDU_LOGISTICS_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ action: 'awb_tracking', awb: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pandu-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock, newest first, with the branch it arrived at', () => {
    const result = parsePanduLogistics(fixture('in-transit'), IN_TRANSIT);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'ARRIVED AT PSS JAKARTA', last_update: null, last_update_local: '2026-10-14T23:51:00', expected_delivery: null,
      weight_kg: 1, events: [
        { local_time: '2026-10-14T23:51:00', location: 'JAKARTA', description: 'ARRIVED AT PSS JAKARTA', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-13T07:45:00', description: 'DEPARTED FROM ORIGIN', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-12T16:09:00', location: 'MEDAN', description: 'ARRIVED AT PSS MEDAN', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-12T16:02:00', description: 'RECEIVED AT ORIGIN STATION', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
  });

  it('keeps the delivery without the receiver, the sender, the consignee, the postcode, the contents or the repeated scan', () => {
    const result = parsePanduLogistics(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'RECEIVED', last_update: null, last_update_local: '2026-09-03T14:12:00', expected_delivery: null, weight_kg: 2 });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage, event.location ?? null])).toEqual([
      ['2026-09-03T14:12:00', 'RECEIVED', 'delivered', null],
      ['2026-09-03T08:30:00', 'DELIVERY PROCESS BY COURIER', 'out_for_delivery', null],
      // The repeated arrival is kept once.
      ['2026-09-03T06:05:00', 'ARRIVED AT PSS DENPASAR', 'in_transit', 'DENPASAR'],
      ['2026-09-02T21:40:00', 'DEPARTED FROM ORIGIN', 'in_transit', null],
      ['2026-09-02T10:20:00', 'ARRIVED AT PSS SURABAYA', 'in_transit', 'SURABAYA'],
      ['2026-09-02T10:15:00', 'RECEIVED AT ORIGIN STATION', 'accepted', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE (?:SENDER|CONSIGNEE|RECEIVER)|sample receiver|00000|DOKUMEN|SEP 2026/i);
  });

  it('takes the summary’s word for a delivery, and keeps one without scans as a summary', () => {
    const summarized = parsePanduLogistics(changed('delivered', (answer) => { answer.track = []; }), DELIVERED);
    expect(summarized).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, expected_delivery: null, weight_kg: 2, summary_only: true, events: [] });
    // A delivered summary over a history whose newest scan stops short of it decides the stage.
    const ahead = parsePanduLogistics(changed('delivered', (answer) => { answer.track.pop(); }), DELIVERED);
    expect(ahead).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'DELIVERY PROCESS BY COURIER' });
    // A summary still `NOT AVAILABLE` leaves the stage to the scans, and with none the shipment has no history.
    expect(() => parsePanduLogistics(changed('in-transit', (answer) => { answer.track = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('takes people and phone numbers out of the wording', () => {
    expect(panduLogisticsWording('RECEIVED BY SAMPLE PERSON, DATE 03 SEP 2026 14:12')).toBe('RECEIVED');
    expect(panduLogisticsWording('received by sample person')).toBe('received');
    expect(panduLogisticsWording('RECEIVED AT ORIGIN STATION ')).toBe('RECEIVED AT ORIGIN STATION');
    expect(panduLogisticsWording('CALL 0800-0000-0000 BEFORE DELIVERY')).toBe('CALL BEFORE DELIVERY');
    const result = parsePanduLogistics(changed('delivered', (answer) => {
      answer.track[5]!.details = 'DELIVERY PROCESS BY COURIER TO SAMPLE CONSIGNEE';
      answer.track[1]!.details = 'ARRIVED AT PSS SURABAYA FROM SAMPLE SENDER';
    }), DELIVERED);
    expect(result.events!.map((event) => event.description)).toContain('DELIVERY PROCESS BY COURIER TO');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE/);
  });

  it('reads an unknown number as not found, and the tracking service’s failure as inconclusive', () => {
    expect(() => parsePanduLogistics(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const failed = changed('not-found', (_answer, body) => { body.request.response = { code: 500, message: 'Internal Server Error' }; });
    expect(() => parsePanduLogistics(failed, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const unreachable = changed('not-found', (_answer, body) => {
      (body as Row).request = { errors: { http_request_failed: ['cURL error 28: Operation timed out'] }, error_data: [] };
    });
    expect(() => parsePanduLogistics(unreachable, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // An empty answer is only a missing parcel with the page's notice, and a reply that is not JSON is a changed service.
    expect(() => parsePanduLogistics(changed('not-found', (_answer, body) => { body.html = ''; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePanduLogistics(changed('not-found', (_answer, body) => { body.request.body = '<html>Error</html>'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePanduLogistics(changed('not-found', (_answer, body) => { body.json = { detail: [], track: [] }; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parsePanduLogistics(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pandu Logistics answered for another shipment' }));
    expect(parsePanduLogistics(changed('in-transit', (answer) => { answer.detail[0]!.awb = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(4);
    expect(() => parsePanduLogistics(changed('delivered', (answer) => { answer.detail.push({ ...answer.detail[0]! }); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pandu Logistics listed several shipments for the number' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_answer: Answer, body: Reply) => { delete (body as Row).json; },
      (_answer: Answer, body: Reply) => { delete (body as Row).request; },
      (_answer: Answer, body: Reply) => { delete (body.request as Row).response; },
      (_answer: Answer, body: Reply) => { body.json = 'shipment' as never; },
      (answer: Answer) => { delete (answer as Row).detail; },
      (answer: Answer) => { answer.detail[0] = 'shipment' as never; },
      (answer: Answer) => { delete answer.detail[0]!.awb; },
      (answer: Answer) => { answer.track = 'scans' as never; },
      (answer: Answer) => { answer.track = Array.from({ length: 501 }, () => answer.track[0]!); },
      (answer: Answer) => { answer.track[0] = 'scan' as never; },
      (answer: Answer) => { answer.track[0]!.date = '2026-10-12 16:02'; },
      (answer: Answer) => { answer.track[0]!.date = '12 Okt 2026 16:02'; },
      (answer: Answer) => { answer.track[0]!.date = '31 Sep 2026 16:02'; },
      (answer: Answer) => { answer.track[0]!.date = '12 Oct 2026 24:00'; },
      (answer: Answer) => { delete answer.track[0]!.date; },
      (answer: Answer) => { answer.track[0]!.details = ['RECEIVED']; },
      (answer: Answer) => { answer.track[0]!.details = ' '; },
      (answer: Answer) => { answer.detail[0]!.status_delivery = { status: 'DELIVERED' }; },
    ]) {
      expect(() => parsePanduLogistics(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // WordPress answers "0" for an action no plugin handles any more.
    await expect(lookup('0', { status: 400, headers: { 'Content-Type': 'text/html; charset=UTF-8' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://pandulogistics.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt = {}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Pandu Logistics</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('false')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Pandu Logistics does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-03T14:12:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('3000-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Pandu Logistics does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['3000000', 'SAMPLETRACKING', `30${'0'.repeat(29)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePanduLogisticsNumber('300 0000 0001')).toBe(DELIVERED);
  });

  it('sends a read that fails to reach Pandu once more inside the budget, and never a reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const answered = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')));
    await expect(carrier(answered).track({ number: UNKNOWN }, { budgetMs: 2000 })).rejects.toMatchObject({ kind: 'not_found' });
    expect(answered).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Pandu Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pandu-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pandu-logistics', source: 'pandu-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === PANDU_LOGISTICS_ENDPOINT)).toBe(true);
  });
});

describe('Pandu Logistics numbers', () => {
  it('claims no number: its POD numbers are bare digit runs other carriers share', () => {
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('pandu-logistics');
  });
});

describe('Pandu Logistics status vocabulary', () => {
  it('records every wording the current tracker showed with the stage the map gives it', () => {
    const live = (statuses.entries as { wording: string; stage: string; confirmedBy: string }[]).filter((entry) => entry.confirmedBy === 'live');
    expect(live.length).toBeGreaterThan(0);
    for (const entry of live) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(panduLogisticsStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'pandu-logistics', providerCode: null, description: 'ARRIVED AT PSS SAMPLE CITY' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'pandu-logistics', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared wording rules.
    expect(panduLogisticsStage('SHIPMENT DELIVERED')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(panduLogisticsStage('Synthetic note')).toBeNull();
  });
});
