import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AirpakTracker } from './adapter.js';
import { AIRPAK_TRACKER, normalizeAirpakNumber, parseAirpak } from './parser.js';
import { airpakStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '200000000002';
const IN_TRANSIT = '81000000001';
const UNKNOWN = '200000000003';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });

describe('Airpak Express HTTP adapter', () => {
  it('reads Airpak’s own page for the whole number once, under its member id, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AirpakTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 810 0000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${AIRPAK_TRACKER}?stid=airpak&cn=${IN_TRANSIT}`);
    expect(String(url)).toMatch(/^https:\/\/tracking\.airpak-express\.com\/go\/plm-tracking\?/);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'airpak-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates every scan in Malaysia on its clock and stages a delivery after failed attempts', () => {
    const result = parseAirpak(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-12T13:00:00+08:00', expected_delivery: null, destination_country: 'MY' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location])).toEqual([
      ['2026-03-12T13:00:00+08:00', '1', 'delivered', 'Sampletown - MALAYSIA'],
      ['2026-03-12T09:37:00+08:00', '50', 'ready_for_pickup', 'Sampletown - MALAYSIA'],
      // A hold in the depot moves nothing.
      ['2026-03-11T17:36:00+08:00', '19', null, 'Sampletown - MALAYSIA'],
      ['2026-03-11T13:47:00+08:00', '43', 'failed_attempt', 'Sampletown - MALAYSIA'],
      ['2026-03-10T14:44:00+08:00', '18', 'failed_attempt', 'Sampletown - MALAYSIA'],
      ['2026-03-09T19:00:00+08:00', '38', 'failed_attempt', 'Sampletown - MALAYSIA'],
      ['2026-03-09T10:34:00+08:00', '15', 'out_for_delivery', 'Sampletown - MALAYSIA'],
      ['2026-03-09T08:53:00+08:00', '4', 'in_transit', 'Sampletown - MALAYSIA'],
      ['2026-03-09T00:58:00+08:00', '162', 'in_transit', 'Samplehub - MALAYSIA'],
      ['2026-03-08T23:59:00+08:00', '3', 'in_transit', 'Samplehub - MALAYSIA'],
      ['2026-03-08T18:00:00+08:00', '3', 'in_transit', 'MALAYSIA'],
      ['2026-03-08T15:12:00+08:00', '2', 'accepted', 'Sampleport - MALAYSIA'],
    ]);
    expect(result.events!.every((event) => !event.local_time)).toBe(true);
    // The masked signatory, the service type, the sender's reference and the destination's state are not kept.
    expect(JSON.stringify(result)).not.toMatch(/S\*{7}|E-Parcel|SAMPLEREF01|SAMPLE STATE/);
  });

  it('dates the scans in Singapore and Malaysia, midnight included, with the documents prepared before the collection', () => {
    const result = parseAirpak(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-04-15T00:10:00+08:00',
      last_status_text: 'In Transit - Loaded to Transit Vehicle/Aircraft' });
    expect(result.destination_country).toBeUndefined();
    expect(result.events!.slice(3).map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-04-14T00:00:00+08:00', '3', 'in_transit', 'SINGAPORE'],
      ['2026-04-13T17:49:00+08:00', '4', 'in_transit', 'SINGAPORE'],
      ['2026-04-13T17:28:00+08:00', '2', 'accepted', 'SINGAPORE'],
      ['2026-04-13T12:23:00+08:00', '90', 'registered', 'SINGAPORE'],
      ['2026-04-13T12:23:00+08:00', '91', 'registered', 'SINGAPORE'],
    ]);
  });

  it('counts a history only when every scan names the number asked', () => {
    expect(() => parseAirpak(fixture('in-transit'), '81000000002'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Airpak answered for another shipment' }));
    const mixed = fixture('delivered').replace(`$(".cn").html("${DELIVERED}");`, `$(".cn").html("${UNKNOWN}");`);
    expect(() => parseAirpak(mixed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    const page = fixture('delivered');
    for (const changed of [
      '<html><title>GETOnline</title></html>',
      page.replace('function js_getTrack()', 'function js_getTracking()'),
      page.replace('$(".trackingstatus-connote").show();', '').replace(/\$\("\.cn"\)\.html\("\d+"\);/g, ''),
      page.replace('12 Mar 2026</span>', '2026-03-12</span>'),
      page.replace('01:00 PM</span>', '13:00</span>'),
      page.replace(/langtag="event_' \+ 1\+'">' \+ "Delivered"/, 'langtag="event_\' + 1+\'">\' + ""'),
      page.replace('var sno = 0;', 'var sno = 0;\n            $(".no-trackingstatus").show();'),
    ]) {
      expect(() => parseAirpak(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page, an empty page and a broken page apart', async () => {
    await expect(lookup(fixture('not-found'), {}, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: '/go/plm-tracking_search?stid=airpak' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Access Denied</title></head><body>Request Rejected</body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>GETOnline</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends only a whole connote number: no partial reference, pattern or letters', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['2000000001', '2000000000001', '20000000000%', '20000000000*', 'ZZ0000000001', '000000000000']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAirpakNumber('2000-0000-0002')).toBe(DELIVERED);
  });

  it('recognizes a known connote by its last scan and an unknown one by the tracker’s notice', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(fixture(String(url).endsWith(DELIVERED) ? 'delivered' : 'not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T05:00:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('routes a number filed under Airpak to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'airpak-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'airpak-express', source: 'airpak-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(AIRPAK_TRACKER))).toBe(true);
  });
});

describe('Airpak Express numbers', () => {
  it('claims no bare eleven or twelve digits: other carriers print them too', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) {
      const match = detectCarrierMatch(number);
      expect(match.carrier).not.toBe('airpak-express');
      expect(match.candidates).not.toContain('airpak-express');
    }
  });
});

describe('Airpak Express status vocabulary', () => {
  it('records every event number the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(airpakStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'airpak-express', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(airpakStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'airpak-express', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // An event number the map does not know falls to the shared wording rules.
    expect(airpakStage('999', 'Out for Delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(airpakStage('999', 'Synthetic note')).toBeNull();
  });
});
