import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TmmExpressTracker, tmmExpressTrackingUrl } from './adapter.js';
import { normalizeTmmExpressNumber, parseTmmExpress, tmmExpressWording } from './parser.js';
import { statusMap, tmmExpressStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic TMM Express AWB numbers.
const DELIVERED = '0000000001';
const TRANSIT = '0000000002';
const UNKNOWN = '0000000003';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const summary = (result: ReturnType<typeof parseTmmExpress>) => result.events!.map((event) =>
  [event.local_time, event.provider_code, event.location ?? null, event.description, event.stage ?? null]);
// The page's consignment data, base64 XML in the download form, changed as text.
const DATA = /(name="xmltosave\[0\]" value=")([^"]*)(")/;
const withData = (body: string, change: (xml: string) => string) => body.replace(DATA, (_match, open: string, encoded: string, close: string) =>
  `${open}${Buffer.from(change(Buffer.from(encoded, 'base64').toString('utf8')), 'utf8').toString('base64')}${close}`);
const BLOCK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('TMM Express HTTP adapter', () => {
  it('asks the tracker\'s page for the whole AWB number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TmmExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 000 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://ukr.tmm-express.com/en/trackparcels?num=${TRANSIT}&mark=is_code`);
    expect(tmmExpressTrackingUrl(TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tmm-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered import by its codes, once per scan, without the recipient\'s details', () => {
    const result = parseTmmExpress(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Consignment delivered in good condition', last_update: null, last_update_local: '2026-03-06T11:42:00',
      expected_delivery: null, destination_country: 'UA' });
    expect(summary(result)).toEqual([
      ['2026-03-06T11:42:00', 'OK', 'KYIV', 'Consignment delivered in good condition', 'delivered'],
      ['2026-03-06T08:12:44', 'OD', 'KYIV', 'Out for Delivery', 'out_for_delivery'],
      ['2026-03-05T13:10:00', 'PNA', 'KYIV', 'The phone does not answer', 'failed_attempt'],
      ['2026-03-05T08:31:09', 'OD', 'KYIV', 'Out for Delivery', 'out_for_delivery'],
      // The new delivery date and the new address after " - " are not kept.
      ['2026-03-04T17:49:13', 'BSC', 'KYIV', 'Delivery date is changed by client request', 'in_transit'],
      ['2026-03-04T17:49:13', 'CA', 'KYIV', 'Change of delivery address', 'in_transit'],
      // The repeated scan is kept once.
      ['2026-03-04T09:05:30', 'HW', 'KYIV', 'Consignment in Warehouse', 'in_transit'],
      ['2026-03-03T17:36:00', 'RC', 'KYIV', 'Released from customs', 'in_transit'],
      ['2026-03-03T16:17:00', 'IR', 'KYIV', 'Import received at destination depot', 'in_transit'],
      ['2026-03-02T17:48:55', 'TS', 'WARSAW CENTRAL HUB', 'Consignment sent from depo', 'in_transit'],
      ['2026-03-02T12:54:59', 'TR', 'WARSAW CENTRAL HUB', 'Allocated to a unit / container or separately in truck', 'in_transit'],
      ['2026-03-02T11:45:00', 'DH', 'WARSAW CENTRAL HUB', 'Entered to warehouse', 'accepted'],
    ]);
    // Scan clocks name no zone and stay local.
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The signatory, the customer reference, the new address and the delivery window are not kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE SIGNER|SAMPLEREF|Зразкова|00000,|06\.03\.2026|POLAND/);
  });

  it('keeps the hub and partner depot names, and names no partner the page does not name', () => {
    const result = parseTmmExpress(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Import received at partner destination depot - SAMPLE DEPOT 7', last_update_local: '2026-05-13T15:19:00',
      destination_country: 'UA' });
    expect(summary(result)).toEqual([
      ['2026-05-13T15:19:00', 'IRP', 'KYIV', 'Import received at partner destination depot - SAMPLE DEPOT 7', 'in_transit'],
      ['2026-05-13T06:46:00', 'IS', 'KYIV', 'Import Received HUB - SAMPLE HUB 1', 'in_transit'],
      ['2026-05-12T16:20:42', 'OF', 'PROLISKY', 'The consignment has been onforwarded for transportation to a destination', 'in_transit'],
      ['2026-05-11T22:54:45', 'TR', 'PROLISKY', 'Allocated to a unit / container or separately in truck', 'in_transit'],
      ['2026-05-11T22:54:00', 'HW', 'KYIV', 'Consignment in Warehouse', 'in_transit'],
    ]);
    // The Partner Connote names no partner, so it is no hand-off.
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(JSON.stringify(result)).not.toContain('0000000000020');
  });

  it('keeps only a hub\'s or depot\'s name after " - "', () => {
    expect(tmmExpressWording('IS', 'Import Received HUB - SAMPLE HUB 1')).toEqual({ head: 'Import Received HUB', wording: 'Import Received HUB - SAMPLE HUB 1' });
    expect(tmmExpressWording('CA', 'Change of delivery address - Sample Street 1 - flat 2'))
      .toEqual({ head: 'Change of delivery address', wording: 'Change of delivery address' });
    expect(tmmExpressWording('RO', 'Returned to origin - ')).toEqual({ head: 'Returned to origin', wording: 'Returned to origin' });
    expect(tmmExpressWording('IRP', 'Import received at partner destination depot - ')).toMatchObject({ wording: 'Import received at partner destination depot' });
    expect(tmmExpressWording('TR', 'Allocated to a unit / container  or separately in truck'))
      .toMatchObject({ wording: 'Allocated to a unit / container or separately in truck' });
  });

  it('stages a code the map does not hold by its wording, or leaves it without a stage', () => {
    const scan = (code: string, description: string) => withData(page('in-transit'), (xml) => xml.replace('<statuses>',
      `<statuses>\n<status code="${code}" description="${description}" eventDate="2026-05-14" eventTime="9:00:00" depotName="KYIV"/>`));
    const known = parseTmmExpress(scan('ZZ', 'Out for Delivery'), TRANSIT);
    expect(known).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map', last_update_local: '2026-05-14T09:00:00' });
    const worded = parseTmmExpress(scan('ZZ', 'Shipment delivered'), TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'delivered' });
    expect(worded.current_stage_source).toMatch(/^wording:/);
    const silent = parseTmmExpress(scan('ZZ', 'Synthetic note'), TRANSIT);
    expect(silent).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
    expect(silent.events![0]).toMatchObject({ provider_code: 'ZZ' });
    expect(silent.events![0]).not.toHaveProperty('stage');
  });

  it('reads a return as returned', () => {
    const returned = withData(page('in-transit'), (xml) => xml.replace('<statuses>',
      '<statuses>\n<status code="RO" description="Returned to origin - " eventDate="2026-05-20" eventTime="14:20:00" depotName="KYIV"/>'
      + '\n<status code="CR" description="Receiver refused delivery." eventDate="2026-05-18" eventTime="9:32:00" depotName="KYIV"/>'));
    expect(parseTmmExpress(returned, TRANSIT)).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to origin' });
  });

  it('reads the notice for an unknown number as not found, bound to the number', () => {
    expect(() => parseTmmExpress(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The site's English and its Russian source wording.
    for (const notice of [`On request -${UNKNOWN} information not found`, `по запросу -${UNKNOWN} информация не найдена`]) {
      expect(() => parseTmmExpress(page('not-found').replace(`за запитом -${UNKNOWN} інформація не знайдена`, notice), UNKNOWN), notice)
        .toThrow(expect.objectContaining({ kind: 'not_found' }));
    }
    expect(() => parseTmmExpress(page('not-found'), '0000000009'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TMM Express answered for another number' }));
    expect(() => parseTmmExpress(page('not-found').replace(`-${UNKNOWN} `, ' '), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TMM Express answered for another number' }));
    expect(() => parseTmmExpress(page('not-found').replace(`за запитом -${UNKNOWN} інформація не знайдена`, 'Service unavailable'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTmmExpress(page('not-found').replace(/<div class="messages notice">[\s\S]*?<\/div>/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the page to the whole number asked', () => {
    expect(() => parseTmmExpress(page('in-transit'), '0000000004'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TMM Express answered for another number' }));
    expect(() => parseTmmExpress(withData(page('in-transit'), (xml) => xml.replace(`<number>${TRANSIT}</number>`, '<number>0000000004</number>')), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TMM Express answered for another number' }));
  });

  it('reads a consignment without scans as no history', () => {
    const empty = withData(page('in-transit'), (xml) => xml.replace(/<statuses>[\s\S]*<\/statuses>/, '<statuses/>'));
    expect(() => parseTmmExpress(empty, TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    const status = (change: (row: string) => string) => (body: string) => withData(body, (xml) =>
      xml.replace(/<status code="HW"[^>]*\/>/, (row) => change(row)));
    for (const change of [
      (body: string) => body.replace(DATA, '$1$3'),
      (body: string) => body.replace(DATA, '$1not base64!$3'),
      (body: string) => body.replace(DATA, `$1${Buffer.from('<connote><number>0000000002</number>').toString('base64')}$3`),
      (body: string) => body.replace(/<input type="hidden" name="xmltosave\[0\]"[^>]*>/, ''),
      (body: string) => body.replace('name="language[0]"', 'name="xmltosave[1]"'),
      (body: string) => withData(body, (xml) => `${xml}${xml}`),
      (body: string) => body.replace('<td id="awbnum">', '<td id="awb">'),
      (body: string) => body.replace('</table>\n<div class="show_table">', '</table><table class="common_information"></table>\n<div class="show_table">'),
      status((row) => row.replace('eventTime="22:54:00"', 'eventTime="22:54"')),
      status((row) => row.replace('eventDate="2026-05-11"', 'eventDate="2026-02-30"')),
      status((row) => row.replace('eventDate="2026-05-11"', 'eventDate="11.05.2026"')),
      status((row) => row.replace('eventTime="22:54:00"', 'eventTime="24:00:00"')),
      status((row) => row.replace(/ eventTime="[^"]*"/, '')),
      status((row) => row.replace(/ code="[^"]*"/, '')),
      status((row) => row.replace(/description="[^"]*"/, 'description=" "')),
      (body: string) => withData(body, (xml) => xml.replace('<statuses>',
        `<statuses>${'<status code="HW" description="Consignment in Warehouse" eventDate="2026-05-10" eventTime="9:00:00" depotName="KYIV"/>'.repeat(301)}`)),
    ]) {
      expect(() => parseTmmExpress(change(page('in-transit')), TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(html(body, init))).track({ number: UNKNOWN });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers every number with HTTP 200: a 404 is a moved route and a redirect another page.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://ukr.tmm-express.com/en' } })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(BLOCK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 429, headers: { 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Відстеження відправлення | Ukr</title><body>Home</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the not-found notice, and asks nothing for a number TMM Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(page('delivered')))
      .mockResolvedValueOnce(html(page('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-06T11:42:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failure to reach the tracker, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TmmExpressTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tmm-express', step: 'retry', outcome: 'ok' }));
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
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers TMM Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000001', '00000000011', 'A000000001', 'JJD0000000000000002', `${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTmmExpressNumber(' 000-000-0001 ')).toBe(DELIVERED);
  });

  it('routes a number filed under TMM Express, or in a tracker link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === tmmExpressTrackingUrl(DELIVERED)
      ? html(page('delivered')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tmm-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tmm-express', source: 'tmm-express', result: { current_stage: 'delivered' } });
    for (const link of [`https://ukr.tmm-express.com/en/trackparcels?mark=is_code&num=${DELIVERED}`,
      `http://www.tmm-express.com/pl/trackparcels?num=${DELIVERED}&mark=is_code`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ carrier: 'tmm-express', confidence: 'high' });
    }
  });
});

describe('TMM Express numbers', () => {
  it('leaves bare ten-digit numbers to the other carriers that print them', () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('tmm-express');
  });
});

describe('TMM Express status vocabulary', () => {
  it('records every code and wording with the stage the map gives it', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(tmmExpressStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'tmm-express', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // A code stages the scan in every language the page has.
    expect(tmmExpressStage('OK', 'Dostarczono')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    // No wording is recorded with two stages.
    const stages = new Map<string, Set<string>>();
    for (const entry of entries) stages.set(entry.wording.toLowerCase(), (stages.get(entry.wording.toLowerCase()) ?? new Set()).add(entry.stage));
    expect([...stages.values()].every((set) => set.size === 1)).toBe(true);
    expect(statusMapAnswer({ carrier: 'tmm-express', providerCode: 'ZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
