import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SKYNET_TRACKER, SkynetTracker } from './adapter.js';
import { normalizeSkynetNumber, parseSkynet, skynetScanZone } from './parser.js';
import { skynetStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const IN_TRANSIT = '000000000001';
const DELIVERED = '000000000002';
const UNKNOWN = '000000000003';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });

describe('SkyNet Worldwide Express HTTP adapter', () => {
  it('reads the network’s page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SkynetTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000 0000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SKYNET_TRACKER}?stid=skynet&cn=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skynet-worldwide', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the scans of a country with one clock and keeps the others’ wall clocks', () => {
    const result = parseSkynet(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2025-10-29T14:47:00', expected_delivery: null,
      destination_country: 'CA' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location])).toEqual([
      ['2025-10-29T14:47:00', '1', 'delivered', 'SAMPLETOWN - CANADA'],
      ['2025-10-29T08:05:00', '15', 'out_for_delivery', 'SAMPLETOWN - CANADA'],
      ['2025-10-28T16:20:00', '18', 'failed_attempt', 'SAMPLETOWN - CANADA'],
      ['2025-10-28T07:55:00', '15', 'out_for_delivery', 'SAMPLETOWN - CANADA'],
      // A message to the recipient moves nothing.
      ['2025-10-27T18:12:00', '149', null, 'Samplehub - CANADA'],
      ['2025-10-27T17:30:00', '37', 'in_transit', 'Samplehub - CANADA'],
      ['2025-10-27T09:41:00', '10', 'customs', 'Samplehub - CANADA'],
      ['2025-10-27T06:02:00', '4', 'in_transit', 'Samplehub - CANADA'],
      // The hour the United Kingdom's clocks repeat reads as its first occurrence; the page keeps the country of an "Others" location.
      ['2025-10-26T01:30:00+01:00', '3', 'in_transit', 'UNITED KINGDOM'],
      ['2025-10-25T23:15:00+01:00', '23', 'in_transit', 'Sampleford - UNITED KINGDOM'],
      ['2025-10-24T15:10:00+01:00', '19', null, 'Sampleford - UNITED KINGDOM'],
      ['2025-10-23T17:48:00+01:00', '2', 'accepted', 'Sampleford - UNITED KINGDOM'],
    ]);
    // Canada keeps several clocks: its scans stay wall clocks.
    expect(result.events!.filter((event) => event.location!.endsWith('CANADA')).every((event) => event.local_time && !event.time)).toBe(true);
    // The masked signatory, the service type and the destination town are not kept.
    expect(JSON.stringify(result)).not.toMatch(/S\*{3}|Non Documents|SAMPLETOWN CANADA/);
    expect(result).not.toHaveProperty('service_name');
  });

  it('reads a parcel held by customs, newest notice first, as at customs', () => {
    const result = parseSkynet(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Info Message Sent to Recipient', last_update: null, last_update_local: '2026-05-06T10:02:00',
      destination_country: 'US' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-05-06T10:02:00', '148', null],
      ['2026-05-06T03:21:00', '10', 'customs'],
      ['2026-05-06T01:07:00', '4', 'in_transit'],
      ['2026-05-05T21:40:00+08:00', '3', 'in_transit'],
      ['2026-05-05T11:15:00+08:00', '14', 'in_transit'],
      ['2026-05-04T18:30:00+08:00', '4', 'in_transit'],
      ['2026-05-04T14:05:00+08:00', '2', 'accepted'],
    ]);
    expect(result.events![3]).toMatchObject({ location: 'SINGAPORE', description: 'In Transit to Destination', stage_source: 'carrier_map' });
  });

  it('dates the newest scan when its country keeps one clock', () => {
    const result = parseSkynet(fixture('in-transit').replace('"Sample City,st - UNITED STATES"', '"Sample City - SINGAPORE"'), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-05-06T10:02:00+08:00' });
    expect(result).not.toHaveProperty('last_update_local');
  });

  it('keeps a wall clock the zone skips when its clocks go forward', () => {
    const skipped = fixture('delivered').replace('25 Oct 2025</span>', '29 Mar 2026</span>').replace('11:15 PM</span>', '01:30 AM</span>');
    expect(parseSkynet(skipped, DELIVERED).events![9]).toMatchObject({ local_time: '2026-03-29T01:30:00', location: 'Sampleford - UNITED KINGDOM' });
  });

  it('reads the zone of a location in a country with one clock, and of no other', () => {
    expect(skynetScanZone('Sampleford - UNITED KINGDOM')).toBe('Europe/London');
    expect(skynetScanZone('Sampleton - South Africa')).toBe('Africa/Johannesburg');
    expect(skynetScanZone('SINGAPORE')).toBe('Asia/Singapore');
    expect(skynetScanZone('Madrid - SPAIN')).toBe('Europe/Madrid');
    expect(skynetScanZone('Las Palmas de Gran Canaria - SPAIN')).toBe('Atlantic/Canary');
    expect(skynetScanZone('Ponta Delgada - PORTUGAL')).toBe('Atlantic/Azores');
    for (const location of ['Sample City,st - UNITED STATES', 'SAMPLETOWN - CANADA', 'Sampleport - AUSTRALIA', 'Sampleford', '']) {
      expect(skynetScanZone(location), location).toBeNull();
    }
  });

  it('decodes the script’s escapes in a wording or a location and appends a location’s second part', () => {
    const html = fixture('delivered')
      .replace('"Delivered" + \'</span>\'', '"Delivered \\"front door\\" \\u0026 signed" + \'</span>\'')
      .replace('if ("" != "") {\n                        TrackingLocation += " - " + "";', 'if ("Depot 2" != "") {\n                        TrackingLocation += " - " + "Depot 2";');
    expect(parseSkynet(html, DELIVERED).events![0]).toMatchObject({ description: 'Delivered "front door" & signed', location: 'SAMPLETOWN - CANADA - Depot 2' });
  });

  it('reads the tracker’s no-tracking notice as not found and a shipment without scans as no history', () => {
    expect(() => parseSkynet(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = fixture('in-transit').replace(/\n\s*var divhtml = '';[\s\S]*\$\("\.tracking-events"\)\.append\(divhtml\);/, '');
    expect(() => parseSkynet(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a history only when every scan names the number asked', () => {
    expect(() => parseSkynet(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SkyNet answered for another shipment' }));
    const mixed = fixture('in-transit').replace(`$(".cn").html("${IN_TRANSIT}");`, `$(".cn").html("${DELIVERED}");`);
    expect(() => parseSkynet(mixed, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    const page = fixture('in-transit');
    for (const changed of [
      '<html><title>GETOnline</title></html>',
      page.replace('function js_getTrack()', 'function js_getTracking()'),
      page.replace('$(".trackingstatus-connote").show();', '').replace(/\$\("\.cn"\)\.html\("\d+"\);/g, ''),
      page.replace('05 May 2026</span>', '2026-05-05</span>'),
      page.replace('09:40 PM</span>', '21:40</span>'),
      page.replace('06 May 2026</span>', '31 Feb 2026</span>'),
      page.replace(/langtag="event_' \+ 148\+'">' \+ "Info Message Sent to Recipient"/, 'langtag="event_\' + 148+\'">\' + ""'),
      page.replace(/langtag="event_' \+ 148\+'"/, 'langtag="event_\' + code+\'"'),
      page.replace('var sno = 0;', 'var sno = 0;\n            $(".no-trackingstatus").show();'),
      page.replace(/(\$\("\.cn"\)\.html\("\d+"\);[\s\S]*?sno \+= 1;)/, (block: string) => block.repeat(501)),
    ]) {
      expect(() => parseSkynet(changed, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page, an empty page and a broken page apart', async () => {
    await expect(lookup(fixture('not-found'), {}, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker answers a number it does not know on its page: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: '/go/plm-tracking_search?stid=skynet' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The tracker answers a request without its member id with nothing.
    await expect(lookup('')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>GETOnline</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a page over its size limit', async () => {
    await expect(lookup('x', { headers: { 'Content-Length': String(3_000_000) } })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects references the tracker cannot hold, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000001', 'SAMPLETRACKING', `1${'0'.repeat(20)}`, '000000000000', '0000 0000 0000 00']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSkynetNumber('0000-0000-0001')).toBe(IN_TRANSIT);
    expect(normalizeSkynetNumber('zz00000001')).toBe('ZZ00000001');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('routes a number filed under SkyNet to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'skynet-worldwide' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'skynet-worldwide', source: 'skynet-worldwide', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(SKYNET_TRACKER))).toBe(true);
  });
});

describe('SkyNet Worldwide Express numbers', () => {
  it('claims no bare twelve digits: other carriers print them too', () => {
    const match = detectCarrierMatch('711000000001');
    expect(match.carrier).not.toBe('skynet-worldwide');
    expect(match.candidates).not.toContain('skynet-worldwide');
  });
});

describe('SkyNet Worldwide Express status vocabulary', () => {
  it('records every event number the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(skynetStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'skynet-worldwide', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(skynetStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'skynet-worldwide', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // An event number the map does not know falls to the shared wording rules.
    expect(skynetStage('999', 'Out for Delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(skynetStage('999', 'Synthetic note')).toBeNull();
  });
});
