import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EUSHIPMENTS_TRACKER, EushipmentsTracker } from './adapter.js';
import { normalizeEushipmentsNumber, parseEushipments, parseEushipmentsError } from './parser.js';
import { eushipmentsMappedStage, eushipmentsPlace, eushipmentsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const ORDER = '10000017';
const COURIER = '1050000000017';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The order before its delivery, and before a courier has it.
const onDelivery = () => text('delivered.html').replace(/<div class="order-detail-table-row">(?:(?!order-detail-table-row)[\s\S])*?>Delivered<[\s\S]*?<\/p>\s*<\/div>\s*<\/div>\n/, '');
const atHub = () => text('delivered.html').replace(/<div class="order-detail-table-row">(?:(?!order-detail-table-row)[\s\S])*?>Picked up<[\s\S]*(?=\s*\n {6}<\/div>)/, '')
  .replace(/<div class="order-last-mile">[\s\S]*<\/div>/, '');

describe('euShipments HTTP adapter', () => {
  it('posts the number to the tracking page’s form handler', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EushipmentsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EUSHIPMENTS_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `tracking_number=${ORDER}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'eushipments', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the statuses as wall clocks with their places, newest first, and hands the parcel to its courier', () => {
    const result = parseEushipments(text('delivered.html'), ORDER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-07T13:06:00', expected_delivery: null, delivery_carrier: 'econt', delivery_tracking_number: COURIER });
    // The row the page lists twice is kept once.
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-07T13:06:00', 'Delivered', undefined, 'delivered'],
      ['2026-03-07T07:58:00', 'On delivery', undefined, 'out_for_delivery'],
      ['2026-03-06T21:47:00', 'In transit', undefined, 'in_transit'],
      ['2026-03-06T08:33:00', 'Picked up', undefined, 'in_transit'],
      ['2026-03-05T18:10:00', 'Loaded hub Specimen Hub (BG)', 'Specimen Hub, BG', 'in_transit'],
      ['2026-03-05T11:25:00', 'Unloaded hub Specimen Hub (BG)', 'Specimen Hub, BG', 'in_transit'],
      ['2026-03-04T05:40:00', 'Loaded hub Example Hub (HR)', 'Example Hub, HR', 'in_transit'],
      ['2026-03-03T16:02:00', 'Warehouse Sampleville', 'Sampleville', 'accepted'],
      ['2026-03-03T09:14:00', 'New', undefined, 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The courier's own wording is not kept.
    expect(JSON.stringify(result)).not.toMatch(/Приета|Доставена|депо/);
  });

  it('reads an order on its way, and one no courier has yet', () => {
    expect(parseEushipments(onDelivery(), ORDER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'On delivery', last_update_local: '2026-03-07T07:58:00', delivery_carrier: 'econt' });
    const result = parseEushipments(atHub(), ORDER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Loaded hub Specimen Hub (BG)' });
    expect(result).not.toHaveProperty('delivery_carrier');
    // A status the map does not know goes to the shared wording rules, and one they do not know has no stage.
    const returned = parseEushipments(onDelivery().replace('>On delivery<', '>Returned to sender<'), ORDER);
    expect(returned).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language' });
    const odd = parseEushipments(onDelivery().replace('>On delivery<', '>Sample state<'), ORDER);
    expect(odd).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample state' });
    expect(odd.events![0]).not.toHaveProperty('stage');
  });

  it('hands an order to Express One Bulgaria by its tracking link', () => {
    // Express One's courier number is the order's own eight digits.
    const expressOne = text('delivered.html').replace('> Econt<', '> Express One<').replaceAll(COURIER, ORDER)
      .replaceAll('https://www.econt.com/services/track-shipment/', 'https://expressone.bg/en/tracking/');
    const result = parseEushipments(expressOne, ORDER);
    expect(result).toMatchObject({ delivery_carrier: 'express-one-bg' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('hands off only to a courier its link names, for the number in the link', () => {
    const swap = (from: string, to: string) => parseEushipments(text('delivered.html').replaceAll(from, to), ORDER);
    // The same number as asked is no second number.
    expect(swap(COURIER, ORDER)).toMatchObject({ delivery_carrier: 'econt' });
    expect(swap(COURIER, ORDER)).not.toHaveProperty('delivery_tracking_number');
    // A name alone, a courier's host the catalog does not know, or a link for another number names no courier.
    expect(swap('https://www.econt.com/services/track-shipment/', 'https://courier.example/track/')).not.toHaveProperty('delivery_carrier');
    expect(parseEushipments(text('delivered.html').replace(/<p><span class="order-last-mile-label">Tracking Link:[\s\S]*?<\/p>/, ''), ORDER))
      .not.toHaveProperty('delivery_carrier');
    expect(parseEushipments(text('delivered.html').replace(/href="[^"]*"/, 'href="https://www.econt.com/services/track-shipment/1050000000099"'), ORDER))
      .not.toHaveProperty('delivery_carrier');
    expect(parseEushipments(text('delivered.html').replace(/href="[^"]*"/, 'href="not a link"'), ORDER)).not.toHaveProperty('delivery_carrier');
    expect(parseEushipments(text('delivered.html').replace(/href="[^"]*"/, 'href="javascript:void(0)"'), ORDER)).not.toHaveProperty('delivery_carrier');
  });

  it('names the other couriers its links point to', () => {
    for (const [link, carrier] of [
      [`https://www.speedy.bg/bg/track-shipment?shipmentNumber=${COURIER}`, 'speedy'],
      [`https://boxnow.bg/track?track=${COURIER}`, 'box-now'],
      [`https://gls-group.com/RO/en/parcel-tracking?match=${COURIER}`, 'gls-de'],
      [`https://www.dpdgroup.com/ro/mydpd/my-parcels/search?parcelNumber=${COURIER}`, 'dpd-ro'],
    ] as const) {
      expect(parseEushipments(text('delivered.html').replace(/href="[^"]*"/, `href="${link}"`), ORDER))
        .toMatchObject({ delivery_carrier: carrier, delivery_tracking_number: COURIER });
    }
  });

  it('reads the handler’s unknown-number error as not found, and its other errors as no answer', async () => {
    expect(() => parseEushipmentsError(JSON.parse(text('not-found.json')))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => json(text('not-found.json')))).track({ number: ORDER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(replying(() => json('{"errors":{"tracking_number":"Please enter numbers to track packages"}}'))).track({ number: ORDER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    for (const body of ['{"errors":{}}', '{"data":[]}', '{"errors":', '{}']) {
      await expect(carrier(replying(() => json(body))).track({ number: ORDER }), body).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('keeps only an order the heading says was searched with the whole number asked', () => {
    expect(() => parseEushipments(text('delivered.html'), '10000018'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'euShipments answered for another shipment' }));
    expect(() => parseEushipments(text('delivered.html').replace('N 10000017', 'N 1000001'), ORDER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEushipments(text('delivered.html').replace('N 10000017', '10000017'), ORDER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('order-number', 'order-title'),
      delivered.replace('class="order-detail-table"', 'class="order-table"'),
      delivered.replace('order-detail-table-heading', 'order-detail-table-head'),
      delivered.replace('order-time-p', 'order-date-p'),
      delivered.replace('order-info-p', 'order-note-p'),
      delivered.replace('>03 March, 2026 09:14<', '>2026-03-03 09:14<'),
      delivered.replace('>03 March, 2026 09:14<', '>03 March, 2026 24:00<'),
      delivered.replace('>03 March, 2026 09:14<', '>30 February, 2026 09:14<'),
      delivered.replace('>03 March, 2026 09:14<', '>03 Marzo, 2026 09:14<'),
      delivered.replace('>New<', '> <'),
      delivered.replace(/<div class="order-detail-table-row">[\s\S]*?order-info-p">[^<]*<\/p>\s*<\/div>\s*<\/div>\n/, (row: string) => row.repeat(501)),
    ].entries()) {
      expect(() => parseEushipments(body, ORDER), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for an order without statuses', () => {
    const empty = text('delivered.html').replace(/\s*<div class="order-detail-table-row">[\s\S]*<\/p>\s*<\/div>\s*<\/div>(?=\n)/, '');
    expect(() => parseEushipments(empty, ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a firewall page, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: ORDER });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('0', { status: 400 }))).rejects.toMatchObject({ kind: 'transport', status: 400 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://eushipments.com/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: ORDER })).rejects.toMatchObject({ kind });
  });

  it('refuses what is no tracking number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345', 'ZZ-12/34', '0'.repeat(41), '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: ORDER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEushipmentsNumber(' ab 1000 0017 ')).toBe('AB10000017');
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: ORDER }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => html(text('delivered.html')))).recognize!(ORDER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => json(text('not-found.json')))).recognize!(ORDER)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('12345')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under euShipments to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: ORDER, carrier: 'eushipments' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'eushipments', source: 'eushipments', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === EUSHIPMENTS_TRACKER)).toBe(true);
  });
});

describe('euShipments status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'eushipments', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(eushipmentsStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('reads a warehouse or hub status without its place', () => {
    expect(eushipmentsPlace('Loaded hub Example Hub (HR)')).toEqual({ wording: 'Loaded hub', place: 'Example Hub', country: 'HR' });
    expect(eushipmentsPlace('Warehouse Sampleville')).toEqual({ wording: 'Warehouse', place: 'Sampleville' });
    expect(eushipmentsPlace('In transit')).toEqual({ wording: 'In transit' });
    expect(statusMapAnswer({ carrier: 'eushipments', providerCode: null, description: 'Unloaded hub Specimen Hub (BG)' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'sample state')).toBeUndefined();
    expect(eushipmentsMappedStage('On delivery')).toBeUndefined();
    expect(eushipmentsMappedStage('on delivery')).toBe('out_for_delivery');
    expect(eushipmentsStage('Returned to sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(eushipmentsStage('Sample state')).toBeNull();
    expect(statusMapAnswer({ carrier: 'eushipments', providerCode: null, description: 'Sample state' })).toEqual({ kind: 'unknown' });
  });
});
