import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PCS_API, PcsTracker } from './adapter.js';
import { normalizePcsNumber, parsePcs } from './parser.js';
import { pcsMappedStage, pcsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '000000000000011';
const IN_TRANSIT = '000000000000022';
const NO_HISTORY = '000000000000033';
const UNKNOWN = '000000000000000';

type Row = Record<string, unknown>;
type Result = { shipmentInfo: Row; shipmentStatuses: Row[] };
type Reply = Row & { Result: Result[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** A fixture whose only result is changed in place by `change`. */
const changed = (name: string, change: (result: Result, reply: Reply) => void): Reply => {
  const reply = fixture(name);
  change(reply.Result[0]!, reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const service = (reply: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => reply());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('PCS Logistics HTTP adapter', () => {
  it('asks the tracker page’s lookup for the whole number in English, through the supplied transport', async () => {
    const fetcher = service(() => json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PcsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000 0000 0000 022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${PCS_API}?OrderNumber%5B0%5D=${IN_TRANSIT}`);
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({ 'OrderNumber[0]': IN_TRANSIT });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { language: 'en-US', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pcs-logistics-vn', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan once, newest first, as an instant in Vietnam, and drops the recipient, the reference and the comments', () => {
    const result = parsePcs(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment delivered', last_update: '2026-05-18T14:02:31+07:00', delivered_at: '2026-05-18T14:02:31+07:00',
      expected_delivery: null, service_name: 'EXPRESS', destination_country: 'VN' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.location, event.description ?? null, event.provider_code ?? null, event.stage ?? null]))
      .toEqual([
        ['2026-05-18T14:02:31+07:00', 'HO CHI MINH, VIETNAM', 'Shipment delivered', '12', 'delivered'],
        ['2026-05-18T08:10:05+07:00', 'HO CHI MINH, VIETNAM', 'With delivery courier', '9', 'out_for_delivery'],
        // A scan without wording keeps its time and place, without a stage; the one listed twice is kept once.
        ['2026-05-17T05:44:12+07:00', 'HO CHI MINH, VIETNAM', null, null, null],
        ['2026-05-15T22:30:00+07:00', 'HA NOI, VIETNAM', null, null, null],
        ['2026-05-15T16:20:09+07:00', 'HA NOI, VIETNAM', 'Picked Up', '3', 'accepted'],
        ['2026-05-15T09:12:40+07:00', 'HA NOI, VIETNAM', 'Order Created', '1', 'registered'],
      ]);
    expect(result.events!.every((event) => !event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAM\*|SAMPLEREF|Sample Person|0900|1\.25|Người nhận/);
  });

  it('keeps the wall clock of a scan abroad, even one labelled with Vietnam’s clock', () => {
    const result = parsePcs(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived at destination hub',
      last_update: null, last_update_local: '2026-07-09T09:45:00', service_name: 'CT', destination_country: 'JP' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location])).toEqual([
      ['2026-07-09T09:45:00', 'OSAKA, JAPAN'],
      ['2026-07-08T06:40:00', 'OSAKA, JAPAN'],
      ['2026-07-06T22:05:00+07:00', 'HA NOI, VIETNAM'],
      ['2026-07-06T10:05:00+07:00', 'HA NOI, VIETNAM'],
      ['2026-07-03T20:15:00+07:00', 'HA NOI, VIETNAM'],
    ]);
    // A wording the map does not know falls to the shared rules.
    expect(result.events![0]).toMatchObject({ stage: 'in_transit', stage_source: expect.stringMatching(/^wording:/) });
  });

  it('keeps a wall clock without Vietnam’s label or outside a named country, and reads a history listed oldest first', () => {
    const result = parsePcs(changed('delivered', (shipment) => {
      shipment.shipmentStatuses.reverse();
      Object.assign(shipment.shipmentStatuses[6]!, { TIME_LOCATION: null });
      Object.assign(shipment.shipmentStatuses[5]!, { LOCATION: 'Sample Hub' });
      shipment.shipmentInfo.RECEIVER_LOCATION = 'SAMPLE TOWN, SAMPLELAND';
    }), DELIVERED);
    expect(result.events!.slice(0, 2).map((event) => [event.time ?? event.local_time, event.location])).toEqual([
      ['2026-05-18T14:02:31', 'HO CHI MINH, VIETNAM'],
      ['2026-05-18T08:10:05', 'Sample Hub'],
    ]);
    expect(result).toMatchObject({ last_status_text: 'Shipment delivered', last_update: null, last_update_local: '2026-05-18T14:02:31' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('destination_country');
    expect(result.events!.at(-1)).toMatchObject({ description: 'Order Created' });
  });

  it('reads an unknown number as not found, a refusal as inconclusive and a waybill without scans as no history', () => {
    expect(() => parsePcs(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePcs({ Message: 'Hệ thống đang bận', StatusCode: 500 }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PCS did not complete the lookup' }));
    expect(() => parsePcs(fixture('no-history'), NO_HISTORY)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps only the result whose waybill is the whole number asked', () => {
    expect(() => parsePcs(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PCS answered for another number' }));
    expect(() => parsePcs(changed('in-transit', (shipment) => { shipment.shipmentInfo.HAWB_NO = `${IN_TRANSIT}9`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'PCS answered for another number' }));
    // The page also finds a parcel by its reference, which does not make the number its waybill.
    expect(() => parsePcs(changed('delivered', (shipment) => { shipment.shipmentInfo.DATA_CODE = UNKNOWN; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PCS answered for another number' }));
    expect(() => parsePcs(changed('in-transit', (shipment) => { shipment.shipmentStatuses[2]!.HAWB = DELIVERED; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = fixture('in-transit');
    twice.Result.push(fixture('in-transit').Result[0]!);
    expect(() => parsePcs(twice, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A reply for several numbers is read for the one asked.
    const both = fixture('in-transit');
    both.Result.unshift(fixture('delivered').Result[0]!);
    expect(parsePcs(both, IN_TRANSIT)).toMatchObject({ destination_country: 'JP' });
  });

  it('rejects a changed reply', () => {
    for (const [index, change] of [
      (_shipment: Result, reply: Reply) => { delete reply.StatusCode; },
      (_shipment: Result, reply: Reply) => { reply.StatusCode = '200'; },
      (_shipment: Result, reply: Reply) => { reply.Result = 'Result' as never; },
      (_shipment: Result, reply: Reply) => { reply.Result = Array.from({ length: 26 }, () => reply.Result[0]!); },
      (shipment: Result) => { delete (shipment as Row).shipmentInfo; },
      (shipment: Result) => { shipment.shipmentInfo.HAWB_NO = 22; },
      (shipment: Result) => { shipment.shipmentStatuses = 'statuses' as never; },
      (shipment: Result) => { shipment.shipmentStatuses = Array.from({ length: 301 }, () => shipment.shipmentStatuses[0]!); },
      (shipment: Result) => { shipment.shipmentStatuses[0] = 'scan' as never; },
      (shipment: Result) => { shipment.shipmentStatuses[0]!.STRDETTIME = '2026-07-09 09:45:00'; },
      (shipment: Result) => { shipment.shipmentStatuses[0]!.STRDETTIME = '09/07/2026 24:00:00'; },
      (shipment: Result) => { shipment.shipmentStatuses[0]!.STRDETTIME = '30/02/2026 09:45:00'; },
      (shipment: Result) => { delete shipment.shipmentStatuses[0]!.STRDETTIME; },
      (shipment: Result) => { shipment.shipmentStatuses[0]!.STATUS_VN = ['Picked Up']; },
      (shipment: Result) => { shipment.shipmentStatuses[0]!.STATUS_ID = { id: 3 }; },
      (shipment: Result) => { shipment.shipmentStatuses[0]!.LOCATION = 7; },
      (shipment: Result) => { shipment.shipmentInfo.TOS = 7; },
    ].entries()) {
      expect(() => parsePcs(changed('in-transit', change), IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (reply: () => Response) => carrier(service(reply)).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // The gateway's own answer to a route it does not have, and a redirect, are moves.
    await expect(lookup(() => json({ Message: 'NOT_FOUND', StatusCode: 404 }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json({ Message: null, StatusCode: 405 }, { status: 405 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://pcs-logistics.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('<html><title>PCS Logistics</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json({ Message: 'Hệ thống đang bận', StatusCode: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = service(() => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('refuses what PCS does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000', 'SAMPLETRACKING', `${DELIVERED},${IN_TRANSIT}`, '0'.repeat(41), '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePcsNumber(' 000-000-000-000-033 ')).toBe(NO_HISTORY);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number PCS does not issue', async () => {
    const answers = [fixture('delivered'), fixture('not-found')];
    const fetcher = service(() => json(answers.shift()));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-18T07:02:31.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('00-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under PCS Logistics to the adapter', async () => {
    const fetcher = service(() => json(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pcs-logistics-vn' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pcs-logistics-vn', source: 'pcs-logistics-vn', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(PCS_API))).toBe(true);
  });
});

describe('PCS Logistics status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.stage) {
        expect(pcsMappedStage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        continue;
      }
      expect(statusMapAnswer({ carrier: 'pcs-logistics-vn', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(pcsStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('stages by code before wording and leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage('12', 'synthetic note')).toBe('delivered');
    expect(statusMap.stage(null, 'returned to sender')).toBeUndefined();
    expect(pcsStage('', 'Returned to sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(pcsStage('', 'Synthetic note')).toBeNull();
    expect(pcsStage('', '')).toBeNull();
  });
});
