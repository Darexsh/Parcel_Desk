import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { A1_POST_PAGE, A1PostTracker, a1PostPageUrl, adapter } from './adapter.js';
import { normalizeA1PostNumber, parseA1Post } from './parser.js';
import { a1PostScan, a1PostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic USPS package barcodes whose check digits pass.
const PARTNER = '9200190000000000000016';
const RELAYED = '9200190000000000000023';
const UNKNOWN = '9200190000000000000030';
const PARTNER_LINK = `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${PARTNER}`;

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A fixture page with its result table's rows replaced. */
const withRows = (rows: string) => page('partner').replace(/<table id="ritm">[\s\S]*?<\/table>/, `<table id="ritm">${rows}</table>`);
const row = (clock: string, text: string) => `<tr><td>${clock}</td><td>${text}</td></tr>`;
const partnerRow = (href: string, name = 'USPS') => row('', `Track at partner website <a href='${href}' rel='noreferrer' target='_blank'>${name}</a>`);
const ownRows = row('14.03.2026 10:41', 'The shipment has been processed, A1 POST') + row('13.03.2026 20:40', 'Shipment information uploaded to A1 POST');

describe('A1 POST HTTP adapter', () => {
  it('asks the tracker\'s page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('partner')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new A1PostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9200 1900 0000 0000 0000 16 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${A1_POST_PAGE}?t=${PARTNER}&l=en`);
    expect(a1PostPageUrl(PARTNER)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'a1-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads A1 POST\'s own rows on Sofia\'s clock and names the partner its page links to', () => {
    const result = parseA1Post(page('partner'), PARTNER);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment has been processed, A1 POST', last_update: '2026-03-14T10:41:00+02:00',
      expected_delivery: null, delivery_carrier: 'usps',
      events: [
        { time: '2026-03-14T10:41:00+02:00', description: 'The shipment has been processed, A1 POST', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-13T20:40:00+02:00', description: 'Shipment information uploaded to A1 POST', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps a partner\'s relayed scans as wall clocks, without their ZIP codes', () => {
    const result = parseA1Post(page('relayed'), RELAYED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'Delivered, In/At Mailbox SAMPLETOWN, ME', last_update: null, last_update_local: '2026-10-29T14:05:00',
      expected_delivery: null });
    // A delivery on a clock of unknown zone has no instant to give.
    expect(result).not.toHaveProperty('delivered_at');
    // The archived layout has no partner link.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-10-29T14:05:00', 'Delivered, In/At Mailbox SAMPLETOWN, ME', null, 'delivered'],
      // A row the map does not know keeps its text, a wall clock and no stage.
      ['2026-10-27T17:39:00', 'Shipment Ready for , BG', null, null],
      ['2026-10-27T17:35:00', 'Departed Shipping Partner Facility, USPS Awaiting Item', 'SAMPLEPORT, ME', 'in_transit'],
      ['2026-10-27T10:41:00+02:00', 'The shipment has been processed A1 Post', null, 'in_transit'],
      ['2026-10-27T09:37:00+02:00', 'Received by employee', 'Varna - Sample office', 'in_transit'],
      ['2026-10-27T09:07:00+02:00', 'Arrive in office', 'Varna - Sample office', 'in_transit'],
      ['2026-10-26T07:07:00+02:00', 'Loaded to line-haul', 'Sample hub', 'in_transit'],
      // The hour clocks go back over reads at its first occurrence, in summer time; the repeated row is kept once.
      ['2026-10-25T03:30:00+03:00', 'Arrive in office', 'Sample hub', 'in_transit'],
      ['2026-10-24T21:22:00+03:00', 'Loaded to line-haul', 'Plovdiv - Sample office', 'in_transit'],
      ['2026-10-24T00:50:00', 'Shipping Label Created, USPS Awaiting Item', 'SAMPLETON, CA', 'registered'],
      ['2026-10-23T20:40:00+03:00', 'Shipment information uploaded to A1 Post', null, 'registered'],
    ]);
    expect(result.events!.every((event) => (event.time === undefined) !== (event.local_time === undefined))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/00000/);
  });

  it('reads the Bulgarian rows too', () => {
    const result = parseA1Post(withRows(row('14.03.2026 10:41', 'Пратката е обработена A1 POST')
      + row('13.03.2026 20:40', 'Информацията за пратката е качена в A1 POST')), PARTNER);
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-03-14T10:41:00+02:00', 'in_transit'], ['2026-03-13T20:40:00+02:00', 'registered'],
    ]);
  });

  it('names a partner only for a known name, its own host and one number its rules offer', () => {
    const partner = (rows: string) => {
      const result = parseA1Post(withRows(rows), PARTNER);
      return { carrier: result.delivery_carrier, number: result.delivery_tracking_number };
    };
    expect(partner(partnerRow(PARTNER_LINK) + ownRows)).toEqual({ carrier: 'usps', number: undefined });
    // Another number in the link is the delivery number.
    expect(partner(partnerRow(PARTNER_LINK.replace(PARTNER, RELAYED)) + ownRows)).toEqual({ carrier: 'usps', number: RELAYED });
    // The link must be on the partner's host, the name known and the number the partner's.
    expect(partner(partnerRow(`https://tracking.example/?n=${PARTNER}`, 'USPS') + ownRows)).toEqual({ carrier: 'usps', number: undefined });
    expect(partner(partnerRow(`https://www.royalmail.com/track-your-item?n=${PARTNER}`, 'USPS') + ownRows)).toEqual({ carrier: undefined, number: undefined });
    expect(partner(partnerRow(PARTNER_LINK, 'Sample Partner') + ownRows)).toEqual({ carrier: 'usps', number: undefined });
    expect(partner(partnerRow('https://tracking.example/?n=1', 'Sample Partner') + ownRows)).toEqual({ carrier: undefined, number: undefined });
    expect(partner(partnerRow('https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=SAMPLE1234') + ownRows)).toEqual({ carrier: undefined, number: undefined });
    expect(partner(partnerRow(`${PARTNER_LINK}&qtc_tLabels2=${RELAYED}`) + ownRows)).toEqual({ carrier: undefined, number: undefined });
    expect(partner(partnerRow('javascript:void(0)') + ownRows)).toEqual({ carrier: undefined, number: undefined });
  });

  it('reads the not-found row as not found, and nothing else', () => {
    expect(() => parseA1Post(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseA1Post(withRows(row('18.10.2026 09:48', 'Пратката не е намерена')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Beside scans or a partner's link it is a changed page, not an answer.
    expect(() => parseA1Post(withRows(row('18.10.2026 09:48', 'Package not found') + ownRows), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseA1Post(withRows(partnerRow(PARTNER_LINK) + row('18.10.2026 09:48', 'Package not found')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads an empty result as inconclusive and a partner\'s link alone as no history', () => {
    expect(() => parseA1Post(withRows(''), PARTNER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseA1Post(withRows(partnerRow(PARTNER_LINK)), PARTNER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const body of [
      '<html><body><p>A1 POST</p></body></html>',
      page('partner').replace('id="ritm"', 'id="results"'),
      withRows(row('14.03.2026', 'The shipment has been processed, A1 POST')),
      withRows(row('2026-03-14 10:41', 'The shipment has been processed, A1 POST')),
      withRows(row('30.02.2026 10:41', 'The shipment has been processed, A1 POST')),
      withRows(row('14.03.2026 24:00', 'The shipment has been processed, A1 POST')),
      withRows(row('14.03.2026 10:41', ' ')),
      withRows('<tr><td>14.03.2026 10:41</td><td>The shipment has been processed, A1 POST</td><td>extra</td></tr>'),
      withRows(row('', 'Track at partner website') + ownRows),
      withRows(partnerRow(PARTNER_LINK) + partnerRow(PARTNER_LINK) + ownRows),
      withRows(row('14.03.2026 10:41', 'The shipment has been processed, A1 POST').repeat(301)),
    ]) {
      expect(() => parseA1Post(body, PARTNER), body.slice(-200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved page, a refusal, a bot check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(html(body, init))).track({ number: UNKNOWN });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://a1post.bg/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="g-recaptcha"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('[{"t":"18.10.2026 09:48","d":"Package not found"}]', { headers: { 'Content-Type': 'application/json' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: PARTNER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a failure to reach A1 POST, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(html(page('partner')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new A1PostTracker({ fetcher, recorder }).fetch(PARTNER, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'a1-post', step: 'retry', outcome: 'ok' }));
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
    await clock.settle(expect(carrier(fetcher).track({ number: PARTNER }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers the tracker cannot take and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123', 'SAMPLETRACKING', 'A1'.repeat(21), '9'.repeat(65), '420000009200190000000000000000']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARTNER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeA1PostNumber(' 9200-1900-0000-0000-0000-16 ')).toBe(PARTNER);
    // A USPS routing barcode is asked for without the recipient's ZIP code.
    expect(normalizeA1PostNumber(`42000000${PARTNER}`)).toBe(PARTNER);
  });

  it('routes a number filed under A1 POST, or its tracking link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(page('partner')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: PARTNER, carrier: 'a1-post' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'a1-post', source: 'a1-post', result: { current_stage: 'in_transit', delivery_carrier: 'usps' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === a1PostPageUrl(PARTNER))).toBe(true);
    expect(parseTrackingInput(`https://a1post.bg/track.php?t=${PARTNER}`)).toMatchObject({ trackingNumber: PARTNER, carrier: 'a1-post' });
  });
});

describe('A1 POST numbers', () => {
  it('claims no number: its tracker takes the partner\'s label number', () => {
    for (const number of [PARTNER, RELAYED, UNKNOWN]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'usps', confidence: 'high' });
    }
  });
});

describe('A1 POST status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, with or without its place', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      for (const text of [entry.wording, `${entry.wording} Sample office`, `${entry.wording} in Sample office`]) {
        const scan = a1PostScan(text);
        if (text !== entry.wording && scan.wording === text) continue;
        expect(scan, text).toMatchObject({ wording: entry.wording, stage: { stage: entry.stage, source: 'carrier_map' } });
        expect(statusMapAnswer({ carrier: 'a1-post', providerCode: null, description: scan.wording }), text)
          .toEqual({ kind: 'mapped', stage: entry.stage });
      }
      expect(a1PostStage(entry.wording), entry.wording).toBe(entry.stage);
    }
  });

  it('reads either casing, and leaves an unknown row to the shared rules', () => {
    expect(a1PostStage('SHIPMENT INFORMATION UPLOADED TO A1 POST')).toBe('registered');
    expect(a1PostStage('пратката е обработена a1 post')).toBe('in_transit');
    expect(a1PostScan('Synthetic row')).toEqual({ wording: 'Synthetic row', place: '', home: false });
    expect(statusMap.stage(null, 'synthetic row')).toBeUndefined();
    expect(statusMap.stage('1', 'arrive in office')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'a1-post', providerCode: null, description: 'Synthetic row' })).toEqual({ kind: 'unknown' });
  });
});
