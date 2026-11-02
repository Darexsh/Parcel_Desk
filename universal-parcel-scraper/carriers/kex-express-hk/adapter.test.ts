import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KEX_HK_TRACKING, KexHkTracker } from './adapter.js';
import { kexHkWording, normalizeKexHkNumber, parseKexHk } from './parser.js';
import { kexHkStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'Z000000001';
const IN_TRANSIT = 'Z000000002';
const UNKNOWN = 'Z000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Imperva's refusal, which replaces the whole page.
const BLOCKED = '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"></head><body style="margin:0px;height:100%">'
  + '<iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=00&incident_id=0-000000000000000000" frameborder=0 width="100%" height="100%">'
  + 'Request unsuccessful. Incapsula incident ID: 0-000000000000000000</iframe></body></html>';
// The rows of the delivered page's timeline, in the order the page lists them.
const rowsOf = (html: string): string[] => [...html.match(/ {52}<li>[\s\S]*?<\/li>/g)!];
const withRows = (html: string, rows: string[]) => {
  const all = rowsOf(html);
  return html.replace(all.join('\n'), rows.join('\n'));
};

describe('KEX Express Hong Kong HTTP adapter', () => {
  it('opens the tracker’s page for the whole number, once, through the supplied transport', async () => {
    const fetcher = answering(() => page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KexHkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' z00000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${KEX_HK_TRACKING}?track=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kex-express-hk', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first as calendar days, once per scan', () => {
    expect(parseKexHk(fixture('delivered'), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment is delivered. Thank you for using KEX Express', last_update: null,
      last_update_local: '2026-03-04', expected_delivery: null,
      events: [
        { local_time: '2026-03-04', description: 'Shipment is delivered. Thank you for using KEX Express', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-04', description: 'Shipment is on the way of delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        // The page lists this sortation twice in the same half-day.
        { local_time: '2026-03-04', description: 'Sortation is completed, preparing for delivery', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03', description: 'Shipment arrived at KEX Express sortation hub', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-02', description: 'KEX Express has received the order information. The package is not yet received by KEX Express.',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads a parcel in transit through the adapter', async () => {
    const result = await carrier(answering(() => page(fixture('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-03-11',
      last_status_text: 'Shipment arrived at KEX Express sortation hub' });
    expect(result.events!.map((event) => event.stage)).toEqual(['in_transit', 'registered']);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('turns an oldest-first page round and orders scans by day and half-day', () => {
    const html = fixture('delivered');
    const rows = rowsOf(html);
    // The out-for-delivery and sortation scans share a half-day: turned round, they keep their place.
    expect(parseKexHk(withRows(html, [...rows].reverse()), DELIVERED)).toEqual(parseKexHk(html, DELIVERED));
    const shuffled = parseKexHk(withRows(html, [rows[4]!, rows[0]!, rows[5]!, rows[1]!]), DELIVERED);
    expect(shuffled.events!.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'registered']);
    expect(shuffled.events!.map((event) => event.local_time)).toEqual(['2026-03-04', '2026-03-04', '2026-03-03', '2026-03-02']);
  });

  it('keeps the former name’s wording and stages wording the map does not know by the shared rules', () => {
    const renamed = fixture('in-transit').replace('Shipment arrived at KEX Express sortation hub', 'Shipment arrived at Kerry Express sortation hub');
    expect(parseKexHk(renamed, IN_TRANSIT).events![0]).toMatchObject({ description: 'Shipment arrived at Kerry Express sortation hub', stage: 'in_transit', stage_source: 'carrier_map' });
    const failed = fixture('in-transit').replace('Shipment arrived at KEX Express sortation hub', 'Delivery attempt failed, recipient not available');
    expect(parseKexHk(failed, IN_TRANSIT)).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: expect.stringMatching(/^wording:/) });
    const unclear = fixture('in-transit').replace('Shipment arrived at KEX Express sortation hub', 'Xyzzy');
    expect(parseKexHk(unclear, IN_TRANSIT)).toMatchObject({ last_status_text: 'Xyzzy', current_stage: 'registered' });
    expect(parseKexHk(unclear, IN_TRANSIT).events![0]).not.toHaveProperty('stage');
  });

  it('takes phone numbers and collection codes out of wording', () => {
    expect(kexHkWording('Shipment arrived at locker, pickup code: 123456. Enquiries 9123 4567')).toBe('Shipment arrived at locker, pickup code. Enquiries');
    expect(kexHkWording('快件已到達智能櫃，取件碼：A12345，查詢請致電+852 2123-4567')).toBe('快件已到達智能櫃，取件碼，查詢請致電');
    expect(kexHkWording('Delivered on 2026-03-04')).toBe('Delivered on 2026-03-04');
    const html = fixture('in-transit').replace('Shipment arrived at KEX Express sortation hub', 'Shipment is ready at the locker, locker PIN 8765 4321');
    expect(JSON.stringify(parseKexHk(html, IN_TRANSIT))).not.toMatch(/8765|4321/);
  });

  it('reads the tracker’s notice for the whole number as not found', async () => {
    expect(() => parseKexHk(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const chinese = fixture('not-found').replace(/Sorry, KEX Express have not yet received[^<]*/, '抱歉，KEX Express 尚未收到運單資訊，請與寄方確認運單號碼');
    expect(() => parseKexHk(chinese, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => page(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A notice under another number says nothing about this one.
    expect(() => parseKexHk(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the tracker’s refusal of an input as invalid input', () => {
    const invalid = fixture('not-found').replace(`>${UNKNOWN}</p>`, '></p>')
      .replace(/Sorry, KEX Express have not yet received information of this tracking no\./, 'Sorry, Invalid input the tracking no.');
    expect(() => parseKexHk(invalid, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('refuses a page for another number or for several numbers', () => {
    expect(() => parseKexHk(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKexHk(fixture('delivered').replace(`>${DELIVERED}</p>`, `>${DELIVERED}0</p>`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker matches in any case and shows the number as it was typed.
    expect(parseKexHk(fixture('delivered').replace(`>${DELIVERED}</p>`, `>${DELIVERED.toLowerCase()}</p>`), DELIVERED).current_stage).toBe('delivered');
    const main = /<div class="main">[\s\S]*?<hr/.exec(fixture('in-transit'))![0].replace(/<hr$/, '');
    const two = fixture('delivered').replace('<div class="main">', `${main}<div class="main">`);
    expect(() => parseKexHk(two, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses a changed page, reads an empty timeline as no history and a bot check as a challenge', () => {
    const delivered = fixture('delivered');
    for (const changed of [
      delivered.replace('id="trackArea"', 'id="results"'),
      delivered.replace(`>${DELIVERED}</p>`, '></p>'),
      delivered.replace('<span>PM</span>', '<span>Noon</span>'),
      delivered.replace('<span>PM</span>', ''),
      delivered.replace('<span>2026-03-04</span>', '<span>2026-02-30</span>'),
      delivered.replace('<span>2026-03-04</span>', '<span>04/03/2026</span>'),
      delivered.replace('<h4>Shipment is on the way of delivery</h4>', '<h4></h4>'),
      '<html><body><h1>Internal Server Error</h1></body></html>',
      '',
    ]) expect(() => parseKexHk(changed, DELIVERED), changed.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A row without a day that is not the tracker's notice.
    expect(() => parseKexHk(fixture('not-found').replace(/Sorry, KEX Express have not yet received[^<]*/, 'Something else'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The script every tracker page loads is no bot check.
    expect(() => parseKexHk(delivered.replace('id="trackArea"', 'id="results"'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = withRows(delivered, []);
    expect(() => parseKexHk(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseKexHk(BLOCKED, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    // The tracker reads a missing parcel from a 200 page: a 404 or a redirect is a moved route.
    await expect(lookup(() => page('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('', { status: 302, headers: { Location: '/en/home' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('<html><body>Internal Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => page('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when KEX Express cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new KexHkTracker({ fetcher: flaky, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects what is not a number it issues, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'A1', 'Z000001', 'ABCDEFGHIJ', 'Z0000000000000000000001', '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeKexHkNumber('kehk-zz 0000 0003')).toBe('KEHKZZ00000003');
  });

  it('recognizes a known number and not an unknown one', async () => {
    await expect(carrier(answering(() => page(fixture('delivered')))).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T00:00:00' });
    await expect(carrier(answering(() => page(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('A1')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(answering(() => page(BLOCKED))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers a number filed under KEX Express Hong Kong or opened from its tracker’s address', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(KEX_HK_TRACKING)
      ? page(fixture('delivered')) : page('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: DELIVERED, carrier: 'kex-express-hk' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'kex-express-hk', source: 'kex-express-hk', result: { current_stage: 'delivered' } });
    for (const link of [`https://www.kex.kln.com/zh/track?track=${DELIVERED}`, `https://hk.kerryexpress.com/en/track?track=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'kex-express-hk' });
    }
  });
});

describe('KEX Express Hong Kong status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(kexHkStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'kex-express-hk', description: 'Shipment is on the way of delivery' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'kex-express-hk', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});
