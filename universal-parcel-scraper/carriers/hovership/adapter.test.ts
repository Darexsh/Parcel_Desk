import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HOVERSHIP_TRACK, hovershipTrackUrl, HovershipTracker } from './adapter.js';
import { hovershipWording, normalizeHovershipNumber, parseHovership } from './parser.js';
import { hovershipHeadlineStage, hovershipStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'HVSAMPLE01';
const IN_TRANSIT = 'HVSAMPLE02';
const UNKNOWN = 'HVSAMPLE99';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string, status = 200) => answering(() => reply(fixture(name), { status }));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// The history's newest row, as the page renders one.
const row = (title: string, clock: string, line: string) => '<li class="relative flex gap-4 pb-7 last:pb-0"><span aria-hidden="true"></span>'
  + '<div class="min-w-0 flex-1"><div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">'
  + `<p class="text-[15px] font-medium text-black/75">${title}</p><time class="text-[13px] tabular-nums text-black/45">${clock}</time></div>`
  + `<p class="mt-1 text-[14px] leading-relaxed text-black/55">${line}</p></div></li>`;
const withRow = (html: string, added: string) => html.replace('<ol class="relative">', `<ol class="relative">${added}`);
const events = (result: ReturnType<typeof parseHovership>) => result.events!.map((event) => [event.time ?? event.local_time,
  event.provider_code, event.description, event.stage ?? null]);

describe('Hovership HTTP adapter', () => {
  it('asks the tracking page for the whole number, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HovershipTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' hvsample02 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HOVERSHIP_TRACK}${IN_TRANSIT}/`);
    expect(hovershipTrackUrl('hv sample-01')).toBe(`${HOVERSHIP_TRACK}${DELIVERED}/`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hovership', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history newest first, as instants in the zone the page names, without towns or the address form', () => {
    const result = parseHovership(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered to Front Door', last_update: '2026-07-14T15:42:00-07:00', expected_delivery: null,
      delivered_at: '2026-07-14T15:42:00-07:00',
    });
    for (const field of ['summary_only', 'history_truncated', 'last_update_local', 'receiver_name', 'sender_name', 'destination_country']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-07-14T15:42:00-07:00', 'Delivered', 'Delivered to Front Door', 'delivered'],
      ['2026-07-14T09:58:00-07:00', 'Out for Delivery', 'Shipment scanned out for delivery', 'out_for_delivery'],
      ['2026-07-14T08:31:00-07:00', 'In Transit', 'Arrived at Example Sort Facility', 'in_transit'],
      ['2026-07-13T21:05:00-07:00', 'In Possession', 'Arrived at Example Sort Facility', 'accepted'],
      ['2026-07-13T16:20:00-07:00', 'Label Created', 'Shipment label created', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event) && !('location' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Exampleville|Sampletown|ZIP|Unlock/);
  });

  it('reads an in-transit history with its latest delivery time, in winter time', () => {
    const result = parseHovership(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at Example Sort Facility', last_update: '2026-11-02T20:12:00-08:00',
      expected_delivery: '2026-11-03T17:00:00-08:00',
    });
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result)).toEqual([
      ['2026-11-02T20:12:00-08:00', 'In Possession', 'Arrived at Example Sort Facility', 'accepted'],
      ['2026-11-02T13:37:00-08:00', 'Label Created', 'Shipment label created', 'registered'],
    ]);
    // A delivery time the page words otherwise, or in a zone it names some other way, keeps its day or goes.
    const shifted = (note: string) => parseHovership(fixture('in-transit').replace('Arriving no later than Nov 3, 2026, 5:00 PM PST', note), IN_TRANSIT);
    expect(shifted('Arriving by Nov 3, 2026, 5:00 PM EST').expected_delivery).toBe('2026-11-03T17:00:00-05:00');
    expect(shifted('Arriving no later than Nov 3, 2026, 5:00 PM Pacific').expected_delivery).toBe('2026-11-03');
    expect(shifted('Arriving soon').expected_delivery).toBeNull();
  });

  it('keeps each scan in the offset of the zone the page names, and a zone it names otherwise as a wall clock', () => {
    const scanned = (clock: string) => parseHovership(withRow(fixture('in-transit'), row('In Transit', clock, 'Departed Example Sort Facility')),
      IN_TRANSIT).events![0]!;
    expect(scanned('Nov 3, 2026, 6:05 AM EST')).toMatchObject({ time: '2026-11-03T06:05:00-05:00' });
    expect(scanned('Nov 3, 2026, 12:05 AM CST')).toMatchObject({ time: '2026-11-03T00:05:00-06:00' });
    expect(scanned('Nov 3, 2026, 12:30 PM MST')).toMatchObject({ time: '2026-11-03T12:30:00-07:00' });
    expect(scanned('Nov 3, 2026, 6:05 AM GMT-7')).toMatchObject({ time: '2026-11-03T06:05:00-07:00' });
    expect(scanned('Nov 3, 2026, 6:05 AM GMT+5:30')).toMatchObject({ time: '2026-11-03T06:05:00+05:30' });
    expect(scanned('Nov 3, 2026, 2:05 PM UTC')).toMatchObject({ time: '2026-11-03T14:05:00Z' });
    const local = scanned('Nov 3, 2026, 6:05 AM');
    expect(local).toMatchObject({ local_time: '2026-11-03T06:05:00' });
    expect(local).not.toHaveProperty('time');
    expect(scanned('Nov 3, 2026, 6:05 AM GMT+15')).toMatchObject({ local_time: '2026-11-03T06:05:00' });
    const result = parseHovership(withRow(fixture('in-transit'), row('In Transit', 'Nov 3, 2026, 6:05 AM', 'Departed Example Sort Facility')), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-11-03T06:05:00', current_stage: 'in_transit' });
  });

  it('stages a title it does not know by the shared rules, and keeps a scan without a line under its title', () => {
    const later = (title: string, line: string) => parseHovership(withRow(fixture('in-transit'), row(title, 'Nov 3, 2026, 6:05 AM PST', line)), IN_TRANSIT);
    expect(later('Delivery Attempted', 'Recipient not available')).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      current_stage_source: 'wording:language' });
    expect(later('Returned', 'Returned to sender')).toMatchObject({ current_stage: 'returned', expected_delivery: null });
    const unknown = later('Recalled', 'Recalled');
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ current_stage: 'accepted', last_status_text: 'Recalled' });
    expect(later('Out for Delivery', '').events![0]).toMatchObject({ description: 'Out for Delivery', provider_code: 'Out for Delivery' });
    // A repeated scan is kept once.
    expect(parseHovership(withRow(fixture('in-transit'), row('In Possession', 'Nov 2, 2026, 8:12 PM PST', 'Arrived at Example Sort Facility')),
      IN_TRANSIT).events).toHaveLength(2);
  });

  it('drops phone numbers from every line and who took a delivered parcel', () => {
    expect(hovershipWording('Delivered, signed by Sample Person', true)).toBe('Delivered');
    expect(hovershipWording('Left with Sample Person at the front desk', true)).toBe('');
    expect(hovershipWording('Call (555) 010-0000 to reschedule', false)).toBe('Call to reschedule');
    expect(hovershipWording('Received by facility staff', false)).toBe('Received by facility staff');
    const delivered = parseHovership(fixture('delivered').replace('Delivered to Front Door', 'Delivered to Front Door, signed by Sample Person'), DELIVERED);
    expect(delivered.events![0]).toMatchObject({ description: 'Delivered to Front Door', stage: 'delivered' });
    expect(JSON.stringify(delivered)).not.toContain('Sample Person');
  });

  it('turns an oldest-first history round, and stands the headline in for a history it lacks', () => {
    const html = fixture('in-transit');
    const items = html.match(/<li class="relative flex gap-4[\s\S]*?<\/li>/g)!;
    const reversed = html.replace(items.join(''), [...items].reverse().join(''));
    expect(events(parseHovership(reversed, IN_TRANSIT)).map(([time]) => time)).toEqual(['2026-11-02T20:12:00-08:00', '2026-11-02T13:37:00-08:00']);
    const bare = html.replace(/<div class="fade-up stat-card lg:col-span-2[\s\S]*?<\/ol><\/div><\/div>/, '');
    expect(bare).not.toContain('Tracking history');
    expect(parseHovership(bare, IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'In our possession',
      last_update: null, expected_delivery: '2026-11-03T17:00:00-08:00', summary_only: true, events: [] });
    const delivered = fixture('delivered').replace(/<div class="fade-up stat-card lg:col-span-2[\s\S]*?<\/ol><\/div><\/div>/, '');
    expect(parseHovership(delivered, DELIVERED)).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-07-14T15:42:00-07:00', summary_only: true });
    const unworded = bare.replace(/In our <span class="text-brand-gradient">possession<\/span>/, 'Sample status');
    expect(() => parseHovership(unworded, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the page’s own answer as not found, and a parcel only when the page names the number asked', () => {
    expect(() => parseHovership(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHovership(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Hovership answered for another parcel' }));
    const form = fixture('in-transit').replace(`data-tracking="${IN_TRANSIT}"`, `data-tracking="${UNKNOWN}"`);
    expect(() => parseHovership(form, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const longer = fixture('in-transit').replace(`Tracking · ${IN_TRANSIT}`, `Tracking · ${IN_TRANSIT}0`);
    expect(() => parseHovership(longer, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (html: string) => html.replace('section-marker', 'section-label'),
      (html: string) => html.replace(/<h1[\s\S]*?<\/h1>/, ''),
      (html: string) => html.replace('<ol class="relative">', '<ul class="relative">').replace('</ol></div></div>', '</ul></div></div>'),
      (html: string) => withRow(html, row('In Transit', 'Nov 31, 2026, 6:05 AM PST', 'Departed')),
      (html: string) => withRow(html, row('In Transit', 'Nov 3, 2026, 13:05 PM PST', 'Departed')),
      (html: string) => withRow(html, row('In Transit', 'Nov 3, 2026, 0:05 AM PST', 'Departed')),
      (html: string) => withRow(html, row('In Transit', '2026-11-03 06:05', 'Departed')),
      (html: string) => withRow(html, row('', 'Nov 3, 2026, 6:05 AM PST', 'Departed')),
      (html: string) => withRow(html, row('In Transit', 'Nov 3, 2026, 6:05 AM PST', 'Departed').replace('</p><time', '</p><time>Nov 3, 2026, 7:05 AM PST</time><time')),
      (html: string) => withRow(html, row('In Transit', 'Nov 3, 2026, 6:05 AM PST', 'Departed').repeat(300)),
      (html: string) => `${html}<main><p class="stat-card-label">Tracking history</p></main>`,
    ]) {
      expect(() => parseHovership(change(fixture('in-transit')), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['', '<html><body>Hovership</body></html>', fixture('not-found').replace('not found', 'missing')]) {
      expect(() => parseHovership(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found', 404)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: `${HOVERSHIP_TRACK}${UNKNOWN}/` } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>Hovership</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the not-found answer, and asks nothing for a number Hovership does not issue', async () => {
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-07-14T22:42:00.000Z' });
    await expect(carrier(page('not-found', 404)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another parcel is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('HV01')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Hovership does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'HV001', '______', 'HV00/0001', 'HV0000ÄÖ01', `HV${'0'.repeat(29)}`, `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of ['hvsample01', ' HV SAMPLE 01 ', 'HV-SAMPLE-01']) expect(normalizeHovershipNumber(raw), raw).toBe(DELIVERED);
    expect(normalizeHovershipNumber('SHIPPER_REF_0001')).toBe('SHIPPER_REF_0001');
    expect(normalizeHovershipNumber(`HV${'0'.repeat(28)}`)).toHaveLength(30);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'accepted' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number the caller names Hovership’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'hovership' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'hovership', source: 'hovership', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === hovershipTrackUrl(DELIVERED))).toBe(true);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'hovership', steps: ['direct', 'retry'], recognition: { rank: 687 }, localClocks: true });
  });
});

describe('Hovership numbers', () => {
  it('leaves Hovership numbers to the caller’s choice, and reads tracker links', () => {
    // Shippers choose their own numbers, so neither detection nor recognition offers Hovership.
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('hovership');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('hovership');
    for (const link of [`https://www.hovership.com/track/${DELIVERED}/`, `https://hovership.com/track/${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'hovership', source: 'link' });
    }
  });
});

describe('Hovership status vocabulary', () => {
  it('records every title the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries.filter((item) => item.code)) {
      expect(statusMap.stage(entry.code!, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(hovershipStage(entry.code!, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(hovershipHeadlineStage('In our  possession')).toBe('accepted');
    expect(hovershipHeadlineStage('Delivered')).toBe('delivered');
    expect(statusMapAnswer({ carrier: 'hovership', providerCode: 'In Possession', description: 'arrived at example sort facility' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'hovership', providerCode: 'Sample Status', description: 'sample' })).toEqual({ kind: 'unknown' });
    // A title the map does not know falls to the shared rules, on the title and then the line, else stays without a stage.
    expect(hovershipStage('Picked Up', '')).toEqual({ stage: 'accepted', source: 'wording:language' });
    expect(hovershipStage('Sample Status', 'Delivered to the front door')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(hovershipStage('Sample Status', 'Sample line')).toBeNull();
  });
});
