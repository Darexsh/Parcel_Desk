import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LICCARDI_API, LiccardiTracker } from './adapter.js';
import { normalizeLiccardiNumber, parseLiccardi } from './parser.js';
import { liccardiStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The shipment numbers of the fixtures, and their labels' thirteen digits.
const DELIVERED = '90000001';
const DELIVERED_LABEL = '6609000000100';
const IN_TRANSIT = '90000002';
const IN_TRANSIT_LABEL = '6609000000200';
const UNKNOWN = '90000009';

type Row = Record<string, unknown>;
type Parcel = Row & { esiti: Row[] };
type Tracking = Row & { colli: Parcel[] };
type Reply = Row & { tracking: Tracking };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (name: string, change: (tracking: Tracking, reply: Reply) => void) => {
  const body = fixture(name);
  change(body.tracking, body);
  return body;
};
const reply = (body: unknown, status = 200, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page the SafeLine firewall serves while it checks a browser, trimmed.
const SAFELINE = '<!DOCTYPE html><html lang="it"><head><title>Controllo di Sicurezza</title></head><body><p>Attendere prego, controlli di sicurezza in corso...</p></body></html>'
  + '<script>install("/.safeline/challenge/v2/challenge.js");</script>';

describe('Liccardi HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, as the page, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LiccardiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LICCARDI_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', Referer: 'https://my.liccarditrasporti.com/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'liccardi', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('merges the parcels’ scans, keeps a repeated scan once and returns each instant at Italy’s offset', () => {
    const result = parseLiccardi(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SPEDIZIONE CONSEGNATA', last_update: '2026-03-30T13:12:54+02:00', delivered_at: '2026-03-30T13:12:54+02:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location])).toEqual([
      ['2026-03-30T13:12:54+02:00', '1', 'delivered', 'SAMPLE CITY'],
      ['2026-03-30T07:37:58+02:00', '52', 'out_for_delivery', 'SAMPLE CITY'],
      ['2026-03-27T06:20:00+01:00', '49', 'in_transit', 'SAMPLE CITY'],
      ['2026-03-25T14:35:21+01:00', '28', 'failed_attempt', 'SAMPLE CITY'],
      ['2026-03-25T07:39:21+01:00', '52', 'out_for_delivery', 'SAMPLE CITY'],
      ['2026-03-25T06:15:17+01:00', '49', 'in_transit', 'SAMPLE CITY'],
      // The second parcel reached the branch later, so its arrival stays.
      ['2026-03-25T04:14:00+01:00', '72', 'in_transit', 'SAMPLE CITY'],
      ['2026-03-25T03:55:23+01:00', '72', 'in_transit', 'SAMPLE CITY'],
      ['2026-03-24T17:43:10+01:00', '91', 'in_transit', 'SAMPLE ORIGIN'],
      ['2026-03-24T17:42:52+01:00', '48', 'in_transit', 'SAMPLE ORIGIN'],
      ['2026-03-24T16:10:42+01:00', '23', 'in_transit', 'SAMPLE ORIGIN'],
      ['2026-03-24T16:10:41+01:00', '4', 'accepted', 'SAMPLE ORIGIN'],
      ['2026-03-23T21:30:59+01:00', '50', 'registered', 'SAMPLE ORIGIN'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.description)).toBe(true);
    // Drivers, notes, the recipient's town and postcode, references, the pickup and the proof of delivery stay out.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE DRIVER|Sample (?:Neighbour|Recipient|Town)|SAMPLE (?:SENDER|PARCEL)|SAMPLE-REF|00000"|Ritiro|podId|101|102/);
    expect(result).not.toHaveProperty('local_time');
  });

  it('finds the shipment by its label’s thirteen digits as by its own number', () => {
    expect(parseLiccardi(fixture('delivered'), DELIVERED_LABEL)).toEqual(parseLiccardi(fixture('delivered'), DELIVERED));
    expect(parseLiccardi(fixture('in-transit'), IN_TRANSIT_LABEL)).toMatchObject({ current_stage: 'out_for_delivery' });
  });

  it('follows a parcel out for delivery again, leaves a forecast without a stage and gives the planned day', () => {
    const result = parseLiccardi(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'IN CONSEGNA', last_update: '2026-05-23T08:37:47+02:00', expected_delivery: '2026-05-23' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.location])).toEqual([
      ['52', 'out_for_delivery', 'Sample City'],
      // A delivery planned for the next day is no scan.
      ['71', null, 'Sample City'],
      ['49', 'in_transit', 'Sample City'],
      ['101', 'failed_attempt', 'Sample City'],
      ['52', 'out_for_delivery', 'Sample City'],
      ['47', 'in_transit', 'Sample City'],
      ['72', 'in_transit', 'Sample City'],
      ['91', 'in_transit', 'SAMPLE HUB'],
      ['48', 'in_transit', 'SAMPLE HUB'],
      ['18', 'in_transit', 'SAMPLE HUB'],
      // The arrival scanned twice within a minute is kept once.
      ['47', 'in_transit', 'SAMPLE HUB'],
      ['4', 'accepted', 'SAMPLE HUB'],
      ['50', 'registered', 'SAMPLE ORIGIN'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE DRIVER|latitude|currentPosition/);
    // The day the page shows over the history comes first, then the first planned day.
    expect(parseLiccardi(changed('in-transit', (tracking) => { tracking.estimatedArrivalDate = '2026-05-24'; }), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-05-24' });
    expect(parseLiccardi(changed('in-transit', (tracking) => { tracking.dataPrevistaConsegnaAggiornata = null; }), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-05-21' });
    expect(parseLiccardi(changed('in-transit', (tracking) => {
      tracking.dataPrevistaConsegnaAggiornata = '2026-02-30';
      tracking.dataPrevistaConsegnaTeorica = null;
    }), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('does not deliver a shipment while one of its parcels is still on its way', () => {
    const partial = parseLiccardi(changed('delivered', (tracking) => { tracking.colli[1]!.esiti.pop(); }), DELIVERED);
    expect(partial).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'SPEDIZIONE CONSEGNATA',
      expected_delivery: '2026-03-30' });
    expect(partial).not.toHaveProperty('delivered_at');
    const returning = parseLiccardi(changed('delivered', (tracking) => {
      Object.assign(tracking.colli[1]!.esiti.at(-1)!, { codEsito: 31, descEsito: 'RIENTRO AL MITTENTE' });
    }), DELIVERED);
    expect(returning).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
  });

  it('gives the summary’s event for a shipment whose parcels have no scan yet', () => {
    const registered = parseLiccardi(changed('in-transit', (tracking) => {
      tracking.colli[0]!.esiti = [];
      Object.assign(tracking, { codEvento: 50, descEvento: 'DATI SPEDIZIONE TRASMESSI A LICCARDI', dateTimeEv: '2026-05-18T07:39:51Z' });
    }), IN_TRANSIT);
    expect(registered).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'DATI SPEDIZIONE TRASMESSI A LICCARDI', provider_code: '50', last_update: '2026-05-18T09:39:51+02:00',
      expected_delivery: '2026-05-23', summary_only: true, events: [] });
    expect(() => parseLiccardi(changed('in-transit', (tracking) => {
      tracking.colli = [];
      Object.assign(tracking, { codEvento: null, descEvento: null, dateTimeEv: null });
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('passes on another courier’s waybill, which the page shows, for a hand-off', () => {
    const handed = parseLiccardi(changed('in-transit', (tracking) => {
      Object.assign(tracking, { externalCourierCode: 'SAMPLE', externalCourierLdv: ' sa 0000 0000 1 ' });
    }), IN_TRANSIT);
    expect(handed).toMatchObject({ delivery_tracking_number: 'SA000000001' });
    expect(handed).not.toHaveProperty('delivery_carrier');
    for (const change of [{ externalCourierCode: null, externalCourierLdv: 'SA000000001' }, { externalCourierCode: 'SAMPLE', externalCourierLdv: IN_TRANSIT_LABEL },
      { externalCourierCode: 'SAMPLE', externalCourierLdv: 'SA-1' }]) {
      expect(parseLiccardi(changed('in-transit', (tracking) => { Object.assign(tracking, change); }), IN_TRANSIT)).not.toHaveProperty('delivery_tracking_number');
    }
    // Only a number another carrier's rules claim is worth asking that carrier about.
    expect(deliveryHandoff('liccardi', IN_TRANSIT, handed)).toBeNull();
  });

  it('counts a shipment only when it gives back the number asked', () => {
    expect(() => parseLiccardi(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Liccardi answered for another shipment' }));
    expect(() => parseLiccardi(fixture('in-transit'), DELIVERED_LABEL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A shorter or longer number that only starts the same is another shipment.
    expect(() => parseLiccardi(fixture('in-transit'), '9000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLiccardi(changed('in-transit', (tracking) => { tracking.courierLdv = null; }), IN_TRANSIT_LABEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseLiccardi(changed('in-transit', (tracking) => { tracking.ldv = 9000002; }), '09000002').events).toHaveLength(13);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_tracking: Tracking, body: Reply) => { delete (body as Row).status; },
      (_tracking: Tracking, body: Reply) => { delete (body as Row).tracking; },
      (tracking: Tracking) => { tracking.ldv = String(IN_TRANSIT); },
      (tracking: Tracking) => { tracking.ldv = 90000002.5; },
      (tracking: Tracking) => { tracking.courierLdv = 6609000000200; },
      (tracking: Tracking) => { tracking.colli = 'parcels' as never; },
      (tracking: Tracking) => { tracking.colli = Array.from({ length: 201 }, () => tracking.colli[0]!); },
      (tracking: Tracking) => { tracking.colli[0] = 'parcel' as never; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti = 'scans' as never; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti = Array.from({ length: 1001 }, () => tracking.colli[0]!.esiti[0]!); },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0] = 'scan' as never; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.eventDateTime = '2026-05-18 07:39:51'; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.eventDateTime = '2026-02-30T07:39:51Z'; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.eventDateTime = null; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.codEsito = '50'; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.codEsito = null; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.descEsito = ' '; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.descEsito = ['IN CONSEGNA']; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.descFiliale = 7; },
      (tracking: Tracking) => { tracking.dataPrevistaConsegnaAggiornata = 20260523; },
    ]) {
      expect(() => parseLiccardi(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLiccardi({ status: { code: 500, message: 'Error' }, tracking: null }, IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps an unknown number, a moved route, the firewall’s check and a broken reply apart', async () => {
    const lookup = (body: unknown, status?: number, type?: string) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'), 404)).rejects.toMatchObject({ kind: 'not_found' });
    // A 404 without the service's own answer, a 410 or a redirect is a moved route.
    await expect(lookup({ error: 'RESTEASY003210: Could not find resource for full path' }, 404)).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup('<html><body>Not Found</body></html>', 404, 'text/html')).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', 410)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', 302)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(SAFELINE, 468, 'text/html')).rejects.toMatchObject({ kind: 'challenge', status: 468 });
    await expect(lookup(SAFELINE, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Liccardi</title></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(text('not-found'), 200)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[403, 'challenge'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('takes seven or eight digits, or thirteen starting with 66, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['900000', '900000012', '6509000000100', '660900000010', '66090000001000', 'SAMPLETRACKING', `${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLiccardiNumber(' 660 9000 0001 00 ')).toBe(DELIVERED_LABEL);
    expect(normalizeLiccardiNumber('9000000')).toBe('9000000');
  });

  it('is asked when the number is filed under Liccardi or comes in its tracker’s link, which no rule claims', async () => {
    for (const number of [DELIVERED, DELIVERED_LABEL]) expect(detectCarrierMatch(number).carrier, number).not.toBe('liccardi');
    expect(parseTrackingInput(`https://my.liccarditrasporti.com/segui?ldv=${DELIVERED_LABEL}`))
      .toMatchObject({ trackingNumber: DELIVERED_LABEL, carrier: 'liccardi' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => reply(String(url).endsWith(DELIVERED) ? text('delivered') : text('not-found'),
      String(url).endsWith(DELIVERED) ? 200 : 404));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'liccardi' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'liccardi', source: 'liccardi', result: { current_stage: 'delivered' } });
  });
});

type Entry = { code?: string; wording: string; stage?: string; unmapped?: boolean };

describe('Liccardi status vocabulary', () => {
  it('maps every code it recorded to the stage recorded for it, and leaves the others out on purpose', () => {
    for (const entry of (statuses.entries as Entry[]).filter((candidate) => candidate.code)) {
      const code = entry.code!;
      if (entry.unmapped) {
        expect(statusMap.stage(code, entry.wording.toLowerCase()), code).toBeUndefined();
        expect(liccardiStage(code, entry.wording), code).toBeNull();
        expect(statusMapAnswer({ carrier: 'liccardi', providerCode: code, description: entry.wording }), code)
          .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        continue;
      }
      expect(statusMap.stage(code, entry.wording.toLowerCase()), code).toBe(entry.stage);
      expect(liccardiStage(code, entry.wording), code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'liccardi', providerCode: '28', description: 'ASSENTE' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'liccardi', providerCode: '999', description: 'Sample note' })).toEqual({ kind: 'unknown' });
    // A code the list does not hold falls to the shared wording rules.
    expect(liccardiStage('999', 'SPEDIZIONE CONSEGNATA')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(liccardiStage('999', 'Sample note')).toBeNull();
  });
});
