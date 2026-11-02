import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DPD_ZA_API, dpdZaLookupUrl, DpdZaTracker } from './adapter.js';
import { dpdZaWording, normalizeDpdZaNumber, parseDpdZa } from './parser.js';
import { dpdZaRailStage, dpdZaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ0000000001';
const IN_TRANSIT = 'ZZ0000000002';
const UNKNOWN = 'ZZ0000000009';

type Row = Record<string, unknown>;
type Reply = Row & { trackingEvents: Row[] };

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return JSON.stringify(reply);
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPD South Africa HTTP adapter', () => {
  it('asks the tracker app’s lookup for the whole waybill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(raw('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DpdZaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 0000-000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'failed_attempt' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DPD_ZA_API}?waybillNo=${IN_TRANSIT}&includeRelatedWaybills=true&includeCollectionTrackingEvents=true`);
    expect(dpdZaLookupUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpd-za', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and branch, stages it by its event type and drops the copies', () => {
    const result = parseDpdZa(raw('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Manifest arrived', last_update: null, last_update_local: '2026-03-12T09:02:41', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      // A manifest scan after the delivery does not undo it.
      ['2026-03-12T09:02:41', '14', 'in_transit', 'SAMPLE TOWN ZA'],
      ['2026-03-11T11:28:09', '64', 'delivered', 'SAMPLE TOWN ZA'],
      ['2026-03-11T10:31:12', '4', 'delivered', null],
      ['2026-03-11T10:29:12', '8', 'delivered', 'SAMPLE TOWN ZA'],
      ['2026-03-11T08:14:02', '3', 'out_for_delivery', 'SAMPLE TOWN ZA'],
      // The repeated manifest scan is kept once; the hidden scan before it is left out.
      ['2026-03-11T04:55:24', '34', 'in_transit', 'SAMPLE TOWN ZA'],
      ['2026-03-10T03:24:09', '14', 'in_transit', 'SAMPLE TOWN ZA'],
      ['2026-03-09T20:40:42', '26', 'in_transit', 'SAMPLE CITY ZA'],
      ['2026-03-09T17:17:32', '49', 'in_transit', 'SAMPLE CITY ZA'],
      ['2026-03-09T17:05:43', '1', 'in_transit', 'SAMPLE CITY ZA'],
      // Scans of one second come in the reply's order reversed, newest first; the copies without the branch are dropped.
      ['2026-03-09T16:25:34', '30', 'in_transit', 'SAMPLE CITY ZA'],
      ['2026-03-09T16:25:34', '27', 'accepted', null],
      ['2026-03-09T10:09:08', '52', 'registered', null],
      ['2026-03-09T10:09:07', '32', 'registered', 'SAMPLE CITY ZA'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.map((event) => event.description).slice(0, 5)).toEqual(['Manifest arrived', 'Mobile pod Image Scanned In',
      'Your parcel has been delivered', 'Your parcel has been delivered', 'Your parcel is out on delivery']);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE (?:PERSON|SUBURB)|Date:|10:29:12 |SWAD|SMPSMT|Trip|At Receiver|"SAMPLE TOWN"/);
  });

  it('takes the newest scan over the rail before a delivery, and leaves out the contacts and a booked day', () => {
    const result = parseDpdZa(raw('in-transit'), IN_TRANSIT);
    // The rail shows the parcel on delivery; the newest staged scan is the failed round.
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Your delivery has been scheduled for May 15 2026 6:30PM', last_update_local: '2026-05-14T10:51:44' });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['48', null, 'Your delivery has been scheduled for May 15 2026 6:30PM'],
      ['5', 'failed_attempt', "We couldn't complete your delivery."],
      ['3', 'out_for_delivery', 'Your parcel is out on delivery'],
      ['49', 'in_transit', 'Your parcel has been processed at our depot'],
      ['1', 'in_transit', 'We have taken receipt of your parcel at our depot'],
      ['9', 'accepted', "We have taken receipt of your parcel at the sender's location"],
      ['52', 'registered', expect.stringMatching(/^Good news, DPD has been assigned to deliver your parcel in South Africa\. .+accordingly\.$/)],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/000 000|example\.test|CONTACT NOT AVAILABLE/);
  });

  it('settles a delivery or an exception by the rail, and falls back to it without a staged scan', () => {
    const exception = parseDpdZa(changed('in-transit', (body) => { body.opsStatusId = 35; }), IN_TRANSIT);
    expect(exception).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    const delivered = parseDpdZa(changed('in-transit', (body) => { body.opsStatusId = 21; }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    // A value the rail does not show leaves the scans to decide.
    expect(parseDpdZa(changed('delivered', (body) => { body.opsStatusId = 0; }), DELIVERED)).toMatchObject({ current_stage: 'in_transit' });
    expect(parseDpdZa(changed('delivered', (body) => { body.opsStatusId = null; }), DELIVERED)).toMatchObject({ current_stage: 'in_transit' });
    const unstaged = parseDpdZa(changed('in-transit', (body) => { body.trackingEvents = [body.trackingEvents.at(-1)!]; }), IN_TRANSIT);
    expect(unstaged).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    const notice = parseDpdZa(changed('in-transit', (body) => { body.opsStatusId = 0; body.trackingEvents = [body.trackingEvents.at(-1)!]; }), IN_TRANSIT);
    expect(notice).toMatchObject({ status: 'unknown', events: [{ provider_code: '48' }] });
    expect(notice).not.toHaveProperty('current_stage');
  });

  it('takes the recipient, the delivery time, the branch and contacts out of the wording', () => {
    expect(dpdZaWording('Your parcel has been delivered to SAMPLE PERSON <br>Date: Mar 11 2026   Time: 10:29:12  SAMPLE TOWN ZA',
      'SAMPLE TOWN ZA')).toBe('Your parcel has been delivered');
    expect(dpdZaWording('Your parcel has been collected by Sample Person', '')).toBe('Your parcel has been collected');
    expect(dpdZaWording('Your parcel is out on delivery   SAMPLE CITY ZA', 'SAMPLE CITY ZA')).toBe('Your parcel is out on delivery');
    // A branch elsewhere in the wording stays.
    expect(dpdZaWording('Moved from SAMPLE CITY ZA to the hub', 'SAMPLE CITY ZA')).toBe('Moved from SAMPLE CITY ZA to the hub');
    expect(dpdZaWording('We couldn\'t complete your delivery. Call +27 (0)00 000 0000. Thank you!', '')).toBe('We couldn\'t complete your delivery. Thank you!');
    expect(dpdZaWording('Sorry. Email queries@example.test for help', '')).toBe('Sorry.');
    // A date stays.
    expect(dpdZaWording('Your delivery has been scheduled for May 15 2026  6:30PM  ', '')).toBe('Your delivery has been scheduled for May 15 2026 6:30PM');
    expect(dpdZaWording('<b>Delivered</b> &amp; signed', '')).toBe('Delivered & signed');
  });

  it('reads an empty reply or a waybill id of 0 as not found, and a waybill without scans as no history', () => {
    for (const body of ['', '  ', 'null', '﻿', JSON.stringify({ $id: '1', waybillId: 0, waybillNo: null, trackingEvents: null })]) {
      expect(() => parseDpdZa(body, UNKNOWN), body).toThrow(expect.objectContaining({ kind: 'not_found' }));
    }
    for (const change of [
      (body: Reply) => { body.trackingEvents = []; body.opsStatusId = 0; },
      (body: Reply) => { delete (body as Row).trackingEvents; },
      // Scans the app hides are no history either.
      (body: Reply) => { for (const row of body.trackingEvents) row.webVisible = false; },
      (body: Reply) => { for (const row of body.trackingEvents) row.longDescription = '  '; },
    ]) {
      expect(() => parseDpdZa(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('counts a waybill only when it is the number asked, and leaves out a related waybill’s scans', () => {
    expect(() => parseDpdZa(raw('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'DPD South Africa answered for another shipment' }));
    expect(() => parseDpdZa(changed('delivered', (body) => { body.waybillNo = ''; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDpdZa(changed('delivered', (body) => { body.waybillNo = `${DELIVERED}1`; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker writes the number back in capitals, at times with the spaces it was sent with.
    expect(parseDpdZa(changed('delivered', (body) => { body.waybillNo = `${DELIVERED.toLowerCase()} `; }), DELIVERED).events).toHaveLength(14);
    const scan = (number: string) => (body: Reply) => {
      body.trackingEvents.push({ ...body.trackingEvents.at(-1)!, waybillNo: number, dateAndTime: '2026-03-13T08:00:00', trackingEventTypeId: 3 });
    };
    expect(() => parseDpdZa(changed('delivered', scan('ZZ0000000003')), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'DPD South Africa answered with another shipment’s scans' }));
    const related = parseDpdZa(changed('delivered', (body) => { body.childWaybillNo = 'zz0000000003'; scan('ZZ0000000003')(body); }), DELIVERED);
    expect(related.events).toHaveLength(14);
    expect(related).toMatchObject({ last_update_local: '2026-03-12T09:02:41' });
    expect(JSON.stringify(related)).not.toContain('ZZ0000000003');
  });

  it('skips a reference to a scan already written', () => {
    const result = parseDpdZa(changed('delivered', (body) => { body.trackingEvents.push({ $ref: '2' }); }), DELIVERED);
    expect(result.events).toHaveLength(14);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).waybillId; },
      (body: Reply) => { body.waybillId = '10000001'; },
      (body: Reply) => { body.waybillId = -1; },
      (body: Reply) => { delete (body as Row).waybillNo; },
      (body: Reply) => { body.waybillNo = 1; },
      (body: Reply) => { body.childWaybillNo = 3; },
      (body: Reply) => { body.opsStatusId = '21'; },
      (body: Reply) => { body.trackingEvents = 'events' as never; },
      (body: Reply) => { body.trackingEvents = Array.from({ length: 501 }, () => body.trackingEvents[1]!); },
      (body: Reply) => { body.trackingEvents[1] = 'scan' as never; },
      (body: Reply) => { delete body.trackingEvents[1]!.waybillNo; },
      (body: Reply) => { body.trackingEvents[1]!.trackingEventTypeId = '32'; },
      (body: Reply) => { body.trackingEvents[1]!.trackingEventTypeId = 3.5; },
      (body: Reply) => { body.trackingEvents[1]!.dateAndTime = '09/03/2026 10:09'; },
      (body: Reply) => { body.trackingEvents[1]!.dateAndTime = '2026-02-30T10:09:07'; },
      (body: Reply) => { body.trackingEvents[1]!.dateAndTime = '2026-03-09T24:00:00'; },
      (body: Reply) => { body.trackingEvents[1]!.dateAndTime = '0001-01-01T00:00:00'; },
      (body: Reply) => { body.trackingEvents[1]!.dateAndTime = '2026-03-09T10:09:07Z'; },
      (body: Reply) => { body.trackingEvents[1]!.longDescription = ['Delivered']; },
      (body: Reply) => { body.trackingEvents[1]!.branch = 5; },
    ]) {
      expect(() => parseDpdZa(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseDpdZa(changed('delivered', (body) => { body.trackingEvents[0]!.dateAndTime = '2026-03-09T10:09:08.153'; }), DELIVERED).events)
      .toHaveLength(14);
    expect(() => parseDpdZa('{"waybillId":', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDpdZa('[]', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The tracker answers a waybill it does not hold with an empty 200.
    await expect(lookup('')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.dpd.com/za/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // The app's own shell in place of the reply is a changed route.
    await expect(lookup('<!doctype html><html><title>DPDLaserParcelAndTrack</title><app-root></app-root></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known waybill and the empty answer, and asks nothing for a number DPD South Africa does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(raw('delivered')))
      .mockResolvedValueOnce(reply(''))
      .mockResolvedValueOnce(reply(raw('in-transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T09:02:41' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // An answer for another waybill is no recognition.
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('ZZ000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers DPD South Africa does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000', 'SAMPLEWAYBILL', 'ZZ/0000001', `ZZ${'0'.repeat(29)}`, `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDpdZaNumber('zzzzz 0000000 z1')).toBe('ZZZZZ0000000Z1');
    expect(normalizeDpdZaNumber('00000001')).toBe('00000001');
  });

  it('tries a read that never reaches the site once more inside the budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 200 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    const recovered = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(raw('in-transit')));
    await expect(carrier(recovered).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'failed_attempt' });
    expect(recovered).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under DPD South Africa to the adapter, and detection claims none', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(raw('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'dpd-za' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dpd-za', source: 'dpd-za', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(DPD_ZA_API))).toBe(true);
    for (const number of [DELIVERED, 'WC0000000', 'ZZ0000000000001', 'ODOZZ0000000S1', '00000000000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('dpd-za');
    }
  });
});

describe('DPD South Africa status vocabulary', () => {
  it('records every event type the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) continue;
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(dpdZaStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'dpd-za', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(dpdZaStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'dpd-za', providerCode: '5', description: 'We couldn\'t complete your delivery.' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'dpd-za', providerCode: '99', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A type the map does not know falls to the shared wording rules.
    expect(dpdZaStage('99', 'Your parcel has been delivered')).toMatchObject({ stage: 'delivered', source: expect.stringMatching(/^wording:/) });
    expect(dpdZaStage('98', 'Synthetic note')).toBeNull();
  });

  it('reads the rail the app lights from the summary', () => {
    expect([4, 13, 5, 9, 18, 17, 21, 1, 35, 43, 0, 2].map(dpdZaRailStage)).toEqual(['accepted', 'in_transit', 'in_transit', 'in_transit',
      'in_transit', 'out_for_delivery', 'delivered', 'exception', 'exception', 'exception', undefined, undefined]);
  });
});
