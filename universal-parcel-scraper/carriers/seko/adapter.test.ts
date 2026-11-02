import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SEKO_API, SekoTracker } from './adapter.js';
import { normalizeSekoNumber, parseSeko } from './parser.js';
import { sekoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'SMPLE0000001';
const IN_TRANSIT = 'SMP0000002';
const UNKNOWN = '000000003';

type Row = Record<string, unknown>;
type Shipment = Row & { milestones: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment;
const changed = (name: string, change: (data: Shipment) => void) => {
  const data = fixture(name);
  change(data);
  return data;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
// SEKO's answer for a number it does not know: a 404 without a body.
const missing = () => new Response(null, { status: 404 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SEKO HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SekoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' smp 000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SEKO_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'seko', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each milestone’s wall clock, newest first, and stages it by SEKO’s statuses', () => {
    const result = parseSeko(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Status Changed to [At Delivery Terminal]', last_update: null, last_update_local: '2026-05-07T09:55:00',
      expected_delivery: '2026-05-11', service_name: 'SEKO 3-5 Day', destination_country: 'US', weight_kg: 98 });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.description])).toEqual([
      ['2026-05-07T09:55:00', 'in_transit', 'Status Changed to [At Delivery Terminal]'],
      ['2026-05-06T10:25:00', 'in_transit', 'Status changed to [At Transfer Terminal]'],
      ['2026-05-04T23:40:00', 'in_transit', 'Status changed to [In Transit to Delivery Terminal]'],
      // The reply lists the newer record first within a minute.
      ['2026-05-04T15:05:00', 'accepted', 'Status Changed to [At Pickup Terminal]'],
      ['2026-05-04T15:05:00', 'registered', 'Status Changed to [Arrived at PU location]'],
      ['2026-05-03T14:10:00', 'registered', 'Shipment Created'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
  });

  it('keeps the delivery without its proof-of-delivery records, the signer, the references or the postcodes', () => {
    const result = parseSeko(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Status Changed to [Shipment Delivered]', last_update_local: '2026-03-16T13:42:00', expected_delivery: null,
      service_name: 'SEKO 3-5 Day', destination_country: 'US', weight_kg: 68.039 });
    expect(result.events!.map((event) => [event.stage, event.description])).toEqual([
      ['delivered', 'Status Changed to [Shipment Delivered]'],
      ['out_for_delivery', 'Status Changed to [Driver on site Delivery Location]'],
      ['out_for_delivery', 'Status Changed to [Shipment is Out for Delivery]'],
      ['in_transit', 'Status Changed to On Hand Destination Station-'],
      ['in_transit', 'Status Changed to [In Transit to Delivery Terminal]'],
      // The status change repeated in lower case at the same minute is kept once.
      ['accepted', 'Status Changed to [At Pickup Terminal]'],
      ['in_transit', 'Shipment in transit to Delivery Station.'],
      ['registered', 'Shipment information received'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Signer|Town|City)|SAMPLE|0000[01]\b|POD|11:42|0000000000000/i);
  });

  it('takes the summary’s word for a finished or held shipment, and for one the milestones lag behind', () => {
    const held = parseSeko(changed('in-transit', (data) => { data.shipmentStatus = 'Temporary Destination Hold'; }), IN_TRANSIT);
    expect(held).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Status Changed to [At Delivery Terminal]', expected_delivery: '2026-05-11' });
    const ahead = parseSeko(changed('in-transit', (data) => { data.shipmentStatus = 'Shipment is Out for Delivery'; }), IN_TRANSIT);
    expect(ahead).toMatchObject({ current_stage: 'out_for_delivery' });
    const delivered = parseSeko(changed('in-transit', (data) => { data.shipmentStatus = 'Delivered'; }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    // A summary behind the milestones, or one the map does not stage, leaves them the say.
    for (const status of ['Shipment Data Received', 'Return Data Received', 'Synthetic status', null]) {
      expect(parseSeko(changed('in-transit', (data) => { data.shipmentStatus = status; }), IN_TRANSIT), String(status))
        .toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    }
  });

  it('answers a shipment without milestones from its summary, and one with neither as no history', () => {
    const summary = parseSeko(changed('in-transit', (data) => { data.milestones = []; data.shipmentStatus = 'Shipment Data Received'; }), IN_TRANSIT);
    expect(summary).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Shipment Data Received',
      summary_only: true, events: [], expected_delivery: '2026-05-11' });
    expect(summary).not.toHaveProperty('last_update_local');
    expect(() => parseSeko(changed('in-transit', (data) => { data.milestones = []; data.shipmentStatus = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSeko(changed('delivered', (data) => {
      delete (data as Row).milestones;
      data.shipmentStatus = 'Synthetic status';
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // Proof-of-delivery records alone are no history.
    expect(() => parseSeko(changed('delivered', (data) => {
      data.milestones = data.milestones.filter((row) => /^POD/.test(String(row.message)));
      data.shipmentStatus = '';
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('stages wording SEKO’s map does not know by the shared rules, and leaves the rest without a stage', () => {
    const result = parseSeko(changed('in-transit', (data) => {
      data.milestones.push({ eventDate: '2026-05-08T08:00:00', message: 'Synthetic note' },
        { eventDate: '2026-05-08T09:00:00', message: 'Status Changed to [Delivery attempted]' });
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 2).map((event) => [event.description, event.stage ?? null])).toEqual([
      ['Status Changed to [Delivery attempted]', 'failed_attempt'],
      ['Synthetic note', null],
    ]);
    expect(result.events![0]!.stage_source).toMatch(/^wording:/);
    // A failed attempt the summary does not show yet stands.
    expect(result).toMatchObject({ current_stage: 'failed_attempt' });
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseSeko(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SEKO answered for another shipment' }));
    expect(parseSeko(changed('in-transit', (data) => { data.trackingNumber = ` ${IN_TRANSIT.toLowerCase()} `; }), IN_TRANSIT).events)
      .toHaveLength(6);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (data: Shipment) => { delete data.trackingNumber; },
      (data: Shipment) => { data.trackingNumber = 7; },
      (data: Shipment) => { data.milestones = 'milestones' as never; },
      (data: Shipment) => { data.milestones = Array.from({ length: 501 }, () => data.milestones[0]!); },
      (data: Shipment) => { data.milestones[0] = 'milestone' as never; },
      (data: Shipment) => { data.milestones[0]!.eventDate = '05/03/2026 2:10 PM'; },
      (data: Shipment) => { data.milestones[0]!.eventDate = '2026-02-30T14:10:00'; },
      (data: Shipment) => { data.milestones[0]!.eventDate = '2026-05-03T24:00:00'; },
      (data: Shipment) => { delete data.milestones[0]!.eventDate; },
      (data: Shipment) => { data.milestones[0]!.message = ['Shipment Created']; },
      (data: Shipment) => { data.milestones[0]!.message = ' '; },
      (data: Shipment) => { data.shipmentStatus = 4; },
      (data: Shipment) => { data.dueDate = 'next week'; },
      (data: Shipment) => { data.serviceLevel = { name: 'Standard' }; },
    ]) {
      expect(() => parseSeko(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSeko(['shipment'], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads milestone clocks with a fraction, and drops a weight in an unknown unit', () => {
    const result = parseSeko(changed('in-transit', (data) => {
      data.milestones[5]!.eventDate = '2026-05-07T09:55:00.1234567';
      data.unitOfWeight = 'ST';
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ local_time: '2026-05-07T09:55:00' });
    expect(result).not.toHaveProperty('weight_kg');
    expect(parseSeko(changed('in-transit', (data) => { data.totalWeight = 0; }), IN_TRANSIT)).not.toHaveProperty('weight_kg');
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(missing())).rejects.toMatchObject({ kind: 'not_found' });
    // The gateway's own answer for a route it does not have.
    await expect(lookup(reply('{ "statusCode": 404, "message": "Resource not found" }', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 301, headers: { Location: 'https://www.sekologistics.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    const check = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    await expect(lookup(reply(check, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply(check, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><title>SEKO</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(reply('null'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number SEKO does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(missing());
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-16T13:42:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ABC123')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers SEKO does not issue, short references among them, and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ABC', 'SMP000002', 'SAMPLE123456', '1234567', `SMP${'0'.repeat(18)}`, 'SMP0000002/1', 'SMP_0000002']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSekoNumber('smple 000-0001')).toBe(DELIVERED);
    expect(normalizeSekoNumber(UNKNOWN)).toBe(UNKNOWN);
  });

  it('tries a request that fails to reach SEKO once more, and ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await clock.settle(expect(carrier(flaky).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' }));
    expect(flaky).toHaveBeenCalledTimes(2);

    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('routes a number filed under SEKO to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'seko' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'seko', source: 'seko', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${SEKO_API}${DELIVERED}`)).toBe(true);
  });
});

describe('SEKO numbers', () => {
  it('leaves SEKO to an explicit choice, since its layouts are other carriers\' too', () => {
    for (const number of [IN_TRANSIT, DELIVERED, UNKNOWN]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('seko');
    }
  });
});

describe('SEKO status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    const entries = (statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean; confirmedBy: string }[])
      .filter((entry) => entry.code === undefined && entry.wording !== 'Received by Destination Customs');
    expect(entries.length).toBeGreaterThan(30);
    for (const entry of entries) {
      const answer = statusMapAnswer({ carrier: 'seko', providerCode: null, description: entry.wording });
      if (entry.unmapped) {
        expect(sekoStage(entry.wording), entry.wording).toBeNull();
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(sekoStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      // A milestone names the summary's statuses as the one it changed to.
      if (entry.confirmedBy === 'official-doc') expect(sekoStage(`Status Changed to [${entry.wording}]`)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'seko', providerCode: null, description: 'Status Changed to [Return Data Received]' }))
      .toMatchObject({ kind: 'intentional_gap' });
    // The coded entries are OmniParcel's, which this tracker does not read.
    expect(statusMap.stage('OP-72', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'seko', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
