import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, STARLINKS_GLOBAL_TRACKER, StarlinksGlobalTracker } from './adapter.js';
import { normalizeStarlinksGlobalNumber, parseStarlinksGlobal } from './parser.js';
import { starlinksGlobalMappedStage, starlinksGlobalPlace, starlinksGlobalStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'XYZ0001GB12345678001';
const COURIER = 'GF0000000000000017';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

const escape = (value: unknown) => JSON.stringify(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const unescape = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
type Parcel = Record<string, unknown> & { events: Record<string, unknown>[] };
/** The delivered page with its parcel changed. */
const edited = (change: (parcel: Parcel) => unknown) => text('delivered.html').replace(/:parcel="([^"]*)"/, (_, value: string) => {
  const parcel = JSON.parse(unescape(value)) as Parcel;
  const changed = change(parcel);
  return `:parcel="${escape(changed === undefined ? parcel : changed)}"`;
});
// The parcel before its delivery, and before a courier has it.
const onDelivery = () => edited((parcel) => {
  parcel.events = parcel.events.slice(1);
});
const atHub = () => edited((parcel) => {
  parcel.events = parcel.events.slice(-2);
  parcel.carrier_tracking_url = null;
  parcel.track_number = null;
});

describe('Starlinks Global HTTP adapter', () => {
  it('opens the tracking page at the number’s address', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new StarlinksGlobalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' xyz0001 gb1234 5678001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${STARLINKS_GLOBAL_TRACKER}${PARCEL}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'starlinks-global', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the events as wall clocks with their places, newest first, and hands the parcel to its courier', () => {
    const result = parseStarlinksGlobal(text('delivered.html'), PARCEL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-12T10:32:09', expected_delivery: null, destination_country: 'US', weight_kg: 0.2,
      delivery_carrier: 'gofo', delivery_tracking_number: COURIER });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-12T10:32:09', 'Delivered', undefined, 'delivered'],
      ['2026-03-12T07:05:03', 'Out for Delivery', undefined, 'out_for_delivery'],
      ['2026-03-12T06:55:03', 'In Transit, with delivery partner', undefined, 'in_transit'],
      ['2026-03-11T12:32:56', 'In Transit, with delivery partner', undefined, 'in_transit'],
      ['2026-03-10T12:51:37', 'Processed in carrier facility at EXAMPLEBURG, US', 'EXAMPLEBURG, US', 'in_transit'],
      ['2026-03-08T15:40:00', 'Customs Cleared', undefined, 'customs'],
      ['2026-03-07T21:50:53', 'Linehaul Export to Destination at Sampleton, GB', 'Sampleton, GB', 'in_transit'],
      ['2026-03-06T18:25:21', 'Accepted at Processing Hub', undefined, 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The recipient's town and the shop are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Sampleville|Example Shop|Example Regional/);
  });

  it('reads a parcel on its way, and one no courier has yet', () => {
    expect(parseStarlinksGlobal(onDelivery(), PARCEL)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Out for Delivery', last_update_local: '2026-03-12T07:05:03', delivery_carrier: 'gofo' });
    const result = parseStarlinksGlobal(atHub(), PARCEL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Linehaul Export to Destination at Sampleton, GB' });
    expect(result).not.toHaveProperty('delivery_carrier');
    // An event the map does not know goes to the shared wording rules, and one they do not know has no stage.
    const returned = parseStarlinksGlobal(edited((parcel) => {
      parcel.events[0] = { ...parcel.events[0], title: 'Returned', description: 'Returned to sender' };
    }), PARCEL);
    expect(returned).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language', last_status_text: 'Returned to sender' });
    const odd = parseStarlinksGlobal(edited((parcel) => {
      parcel.events[0] = { ...parcel.events[0], title: 'Sample state', description: '' };
    }), PARCEL);
    expect(odd).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Sample state' });
    expect(odd.events![0]).not.toHaveProperty('stage');
    // Of two events on one clock, the one higher on the page is the newer.
    const tied = parseStarlinksGlobal(edited((parcel) => {
      parcel.events[1] = { ...parcel.events[1], date: parcel.events[0]!.date };
    }), PARCEL);
    expect(tied.events!.slice(0, 2).map((event) => event.description)).toEqual(['Delivered', 'Out for Delivery']);
    // A country alone names no place.
    const attempted = parseStarlinksGlobal(edited((parcel) => {
      parcel.events[0] = { ...parcel.events[0], title: 'Delivery Attempted', description: 'Delivery Attempted at US' };
    }), PARCEL);
    expect(attempted).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map', last_status_text: 'Delivery Attempted at US' });
    expect(attempted.events![0]).not.toHaveProperty('location');
  });

  it('hands off only to a courier its link names, for the number in the link', () => {
    const delivered = text('delivered.html');
    // A link to the postal service names it too.
    expect(parseStarlinksGlobal(edited((parcel) => {
      parcel.track_number = '9200190000000000000017';
      parcel.carrier_tracking_url = 'https://tools.usps.com/go/TrackConfirmAction_input?origTrackNum=9200190000000000000017';
    }), PARCEL)).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9200190000000000000017' });
    // The same number as asked is no second number.
    expect(parseStarlinksGlobal(delivered.replaceAll(COURIER, PARCEL), PARCEL)).toMatchObject({ delivery_carrier: 'gofo' });
    expect(parseStarlinksGlobal(delivered.replaceAll(COURIER, PARCEL), PARCEL)).not.toHaveProperty('delivery_tracking_number');
    // A courier's host the catalog does not know, a link for another number, or no link names no courier.
    for (const change of [
      (parcel: Parcel) => { parcel.carrier_tracking_url = `https://courier.example/track/${COURIER}`; },
      (parcel: Parcel) => { parcel.carrier_tracking_url = 'https://www.gofo.com/us/track?searchID=GF0000000000000099'; },
      (parcel: Parcel) => { parcel.carrier_tracking_url = 'not a link'; },
      (parcel: Parcel) => { parcel.carrier_tracking_url = `javascript:void('${COURIER}')`; },
      (parcel: Parcel) => { parcel.track_number = ''; },
      (parcel: Parcel) => { delete parcel.carrier_tracking_url; },
    ]) {
      expect(parseStarlinksGlobal(edited(change), PARCEL)).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads the page for a number the tracker does not know as not found, and other empty pages as no answer', async () => {
    const unknown = 'XYZ0001GB99999999001';
    expect(() => parseStarlinksGlobal(text('not-found.html'), unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseStarlinksGlobal(text('not-found.html').replace('error="Parcel not found"', 'error="Sample error"'), unknown))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseStarlinksGlobal(text('not-found.html').replace('error="Parcel not found"', ''), unknown))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps only the parcel under the whole number asked', () => {
    // The page searched another number.
    expect(() => parseStarlinksGlobal(text('not-found.html'), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Starlinks Global answered for another shipment' }));
    // The tracker found a parcel by its courier's number, or another parcel.
    expect(() => parseStarlinksGlobal(edited((parcel) => { parcel.system_track_number = 'XYZ0001GB12345678002'; }), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Starlinks Global answered for another shipment' }));
  });

  it('leaves a cancelled parcel open, and has no history for one without events', () => {
    expect(() => parseStarlinksGlobal(edited((parcel) => { parcel.isCancelled = true; }), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Starlinks Global shows the shipment as cancelled' }));
    expect(() => parseStarlinksGlobal(edited((parcel) => { parcel.events = []; }), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('<public-tracking-page', '<tracking-page').replace('</public-tracking-page>', '</tracking-page>'),
      delivered.replace('</main>', '<public-tracking-page :parcel="null"></public-tracking-page></main>'),
      delivered.replace(':parcel=', ':shipment='),
      delivered.replace(':search=', ':query='),
      delivered.replace(/:search="[^"]*"/, ':search="null"'),
      delivered.replace(/:parcel="[^"]*"/, ':parcel="{&quot;events&quot;:"'),
      edited(() => []),
      edited((parcel) => { delete parcel.system_track_number; }),
      edited((parcel) => { (parcel as Record<string, unknown>).events = {}; }),
      edited((parcel) => { delete parcel.isCancelled; }),
      edited((parcel) => { (parcel.events as unknown[])[0] = 'Delivered'; }),
      edited((parcel) => { parcel.events[0]!.date = '12/03/2026 10:32'; }),
      edited((parcel) => { parcel.events[0]!.date = '2026-02-30 10:32:09'; }),
      edited((parcel) => { parcel.events[0]!.date = '2026-03-12 24:00:00'; }),
      edited((parcel) => { parcel.events[0]!.date = null; }),
      edited((parcel) => { parcel.events[0]!.title = ' '; }),
      edited((parcel) => { parcel.events[0]!.title = 7; }),
      edited((parcel) => { parcel.events[0]!.description = 7; }),
      edited((parcel) => { parcel.events = Array.from({ length: 501 }, () => parcel.events[0]!); }),
    ].entries()) {
      expect(() => parseStarlinksGlobal(body, PARCEL), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a firewall page, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: PARCEL });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://starlinks.app/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
  });

  it('refuses what is no Starlinks Global number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A courier's number is the courier's to track.
    for (const number of ['12345', COURIER, '9200190000000000000017', 'XYZ1234567890123', 'XYZ0001GB1234567800', 'XY0001GB123456780011', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeStarlinksGlobalNumber(' xyz-0001-gb-12345678001 ')).toBe(PARCEL);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => html(text('delivered.html')))).recognize!(PARCEL)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(text('not-found.html')))).recognize!('XYZ0001GB99999999001')).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('12345')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under Starlinks Global to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: PARCEL, carrier: 'starlinks-global' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'starlinks-global', source: 'starlinks-global', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${STARLINKS_GLOBAL_TRACKER}${PARCEL}`)).toBe(true);
  });
});

describe('Starlinks Global status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'starlinks-global', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(starlinksGlobalStage(entry.wording, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('reads a text without the place it ends with', () => {
    expect(starlinksGlobalPlace('Processed in carrier facility at EXAMPLEBURG, US'))
      .toEqual({ wording: 'Processed in carrier facility', place: 'EXAMPLEBURG', country: 'US' });
    expect(starlinksGlobalPlace('Accepted at Processing Hub')).toEqual({ wording: 'Accepted at Processing Hub' });
    // A country alone, and a wording that holds "at" itself.
    expect(starlinksGlobalPlace('Delivery Attempted at US')).toEqual({ wording: 'Delivery Attempted', country: 'US' });
    expect(starlinksGlobalPlace('Arrived at Post Office at Sampleville, US')).toEqual({ wording: 'Arrived at Post Office', place: 'Sampleville', country: 'US' });
    expect(statusMapAnswer({ carrier: 'starlinks-global', providerCode: null, description: 'Arrived at Post Office at US' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'starlinks-global', providerCode: null, description: 'Delivered at Sampleville, US' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    // An event's title decides over its text.
    expect(starlinksGlobalStage('Received by carrier', 'Sample text at Sampleville, US')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'sample state')).toBeUndefined();
    expect(starlinksGlobalMappedStage('Sample state at Sampleville, US')).toBeUndefined();
    expect(starlinksGlobalStage('Returned', 'Returned to sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(starlinksGlobalStage('Sample state', 'Sample state')).toBeNull();
    expect(statusMapAnswer({ carrier: 'starlinks-global', providerCode: null, description: 'Sample state' })).toEqual({ kind: 'unknown' });
  });
});
