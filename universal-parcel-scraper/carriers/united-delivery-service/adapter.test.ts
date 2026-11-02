import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, UDS_ENDPOINT, UnitedDeliveryServiceTracker } from './adapter.js';
import { parseUds } from './parser.js';
import { statusMap, udsMappedStage, udsStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '42UDS00000000017';
const RECEIVED = 'APUDS00000042';
const UNKNOWN = '42UDS00000000099';
// Lookups shortly after each fixture's newest scan, in UTC.
const JANUARY = Date.parse('2026-01-14T20:00:00Z');
const SEPTEMBER = Date.parse('2026-09-17T12:00:00Z');
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'interactive\'};</script></body></html>';
const SCAN = '2026-09-17&nbsp;-&nbsp;05:32:57 AM CDT';
// The received page's rail, with its current step moved to "Out for Delivery".
const outForDelivery = () => page('received')
  .replace("<div class='value'>Received</div>", "<div class='value'>Out for Delivery</div>")
  .replace(/<div class='uds-udsFormat-step future'>(\s*<div class='uds-udsFormat-dot'><\/div>\s*<div class='t'>Out for Delivery)/,
    "<div class='uds-udsFormat-step current'>$1")
  .replace(/<div class='uds-udsFormat-step current'>(\s*<div class='uds-udsFormat-current'><\/div>\s*<div class='t'>Received<\/div>\s*<div class='s'>[^<]*<\/div>)\s*<div class='m'>[^<]*<br>[^<]*<\/div>/,
    "<div class='uds-udsFormat-step completed'>$1")
  .replace("Package is loaded and out for delivery.</div>", `Package is loaded and out for delivery.</div><div class='m'>SAMPLE PARK, IL<br>${SCAN.replace('05:32:57 AM', '07:05:10 AM')}</div>`);

describe('United Delivery Service tracking adapter', () => {
  it('asks the barcode page once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('received')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new UnitedDeliveryServiceTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => SEPTEMBER })
      .fetch(' apuds-0000 0042 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.uniteddeliveryservice.com/track/barcode/${RECEIVED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'united-delivery-service', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery as its one dated scan, with the weight and size, without proof-of-delivery details', () => {
    const result = parseUds(page('delivered'), DELIVERED, JANUARY);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-01-14T13:16:53-06:00', expected_delivery: null, delivered_at: '2026-01-14T13:16:53-06:00',
      weight_kg: 1.814, dimensions_text: '18 × 14 × 6 in', summary_only: true,
      events: [{ time: '2026-01-14T13:16:53-06:00', location: 'EXAMPLEVILLE, IL', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' }],
    });
    for (const kept of ['Front Door', '100000001', 'Zip', 'Signature', 'photo']) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('reads a received parcel and its estimate, whose year is the one the weekday falls on', () => {
    const result = parseUds(page('received'), RECEIVED, SEPTEMBER);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: 'Received',
      last_update: '2026-09-17T05:32:57-05:00', expected_delivery: '2026-09-17', weight_kg: 0.68, dimensions_text: '12 × 6 × 4 in', summary_only: true,
      events: [{ time: '2026-09-17T05:32:57-05:00', location: 'SAMPLE PARK, IL', description: 'Received', stage: 'accepted', stage_source: 'carrier_map' }],
    });
    // Across New Year, and not on a weekday the day does not fall on, nor far from the lookup.
    const estimate = (line: string, now: number) => parseUds(page('received').replace('Thu, Sep 17 <span', `${line} <span`), RECEIVED, now).expected_delivery;
    expect(estimate('Fri, Jan 1', Date.parse('2026-12-31T18:00:00Z'))).toBe('2027-01-01');
    expect(estimate('Wed, Dec 30', Date.parse('2027-01-02T18:00:00Z'))).toBe('2026-12-30');
    expect(estimate('Fri, Sep 17', SEPTEMBER)).toBeNull();
    expect(estimate('Thu, Sep 17', Date.parse('2026-03-01T12:00:00Z'))).toBeNull();
    expect(estimate('Thursday', SEPTEMBER)).toBeNull();
    expect(parseUds(page('received').replace(/<div class='uds-udsFormat-etaLine'>.*?<\/span><\/div>/, ''), RECEIVED, SEPTEMBER))
      .toMatchObject({ expected_delivery: null, current_stage: 'accepted' });
  });

  it('dates a clock only when its offset name is Chicago’s at that clock, and keeps the rest as wall clocks', () => {
    const clock = (shown: string) => parseUds(page('received').replace(SCAN, shown), RECEIVED, SEPTEMBER).events![0];
    // The repeated autumn hour, read by the name the page gives it.
    expect(clock('2026-11-01&nbsp;-&nbsp;01:30:00 AM CDT')).toMatchObject({ time: '2026-11-01T01:30:00-05:00' });
    expect(clock('2026-11-01&nbsp;-&nbsp;01:30:00 AM CST')).toMatchObject({ time: '2026-11-01T01:30:00-06:00' });
    expect(clock('2026-09-17&nbsp;-&nbsp;12:05:00 AM CDT')).toMatchObject({ time: '2026-09-17T00:05:00-05:00' });
    expect(clock('2026-09-17&nbsp;-&nbsp;12:05:00 PM CDT')).toMatchObject({ time: '2026-09-17T12:05:00-05:00' });
    // A name that is not Chicago's offset then, a clock without a name and an hour that does not exist stay wall clocks.
    for (const [shown, local] of [['2026-09-17&nbsp;-&nbsp;05:32:57 AM CST', '2026-09-17T05:32:57'], ['2026-09-17&nbsp;-&nbsp;7:33 AM', '2026-09-17T07:33:00'],
      ['2026-03-08&nbsp;-&nbsp;02:30:00 AM CDT', '2026-03-08T02:30:00']]) {
      const event = clock(shown!);
      expect(event, shown).toMatchObject({ local_time: local });
      expect(event!.time, shown).toBeUndefined();
    }
    const local = parseUds(page('delivered').replaceAll('01:16:53 PM CST', '01:16:53 PM CDT'), DELIVERED, JANUARY);
    expect(local).toMatchObject({ last_update: null, last_update_local: '2026-01-14T13:16:53' });
    expect(local.delivered_at).toBeUndefined();
  });

  it('stages the parcel by its status heading, then by the step, and keeps a step without a scan out of the events', () => {
    expect(parseUds(outForDelivery(), RECEIVED, SEPTEMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      events: [{ time: '2026-09-17T07:05:10-05:00', location: 'SAMPLE PARK, IL', description: 'Out for Delivery', stage: 'out_for_delivery' }] });
    const delayed = parseUds(page('received').replace("<div class='value'>Received</div>", "<div class='value'>Delayed</div>"), RECEIVED, SEPTEMBER);
    expect(delayed).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Delayed', events: [{ description: 'Received', stage: 'accepted' }] });
    const notified = parseUds(page('received').replace("<div class='value'>Received</div>", "<div class='value'>Shipment Notification</div>")
      .replace(/<div class='m'>[^<]*<br>[^<]*<\/div>/, ''), RECEIVED, SEPTEMBER);
    expect(notified).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null, summary_only: true, events: [] });
    const unknown = parseUds(page('received').replace("<div class='value'>Received</div>", "<div class='value'>Status Pending Review</div>")
      .replace("<div class='t'>Received</div>", "<div class='t'>Status Pending Review</div>"), RECEIVED, SEPTEMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Status Pending Review' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-09-17T05:32:57-05:00', location: 'SAMPLE PARK, IL', description: 'Status Pending Review' });
    // A scan without its place keeps its clock.
    expect(parseUds(page('received').replace(`SAMPLE PARK, IL<br>${SCAN}`, SCAN), RECEIVED, SEPTEMBER).events)
      .toEqual([{ time: '2026-09-17T05:32:57-05:00', description: 'Received', stage: 'accepted', stage_source: 'carrier_map' }]);
  });

  it('binds the page to the requested number and rejects pages it cannot read', () => {
    expect(() => parseUds(page('delivered'), '42UDS00000000018', JANUARY)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUds(page('not-found'), DELIVERED, JANUARY)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseUds(page('received').replace(`<div class='v'>${RECEIVED}</div>`, "<div class='v'>apuds00000042</div>"), RECEIVED, SEPTEMBER))
      .toMatchObject({ current_stage: 'accepted' });
    for (const html of [
      page('delivered').replace("<div class='value'>Delivered</div>", "<div class='value'></div>"),
      page('delivered').replace("<div class='value'>Delivered</div>", "<div class='value'>Delivered</div><div class='value'>Delivered</div>"),
      page('delivered').replace(`<div class='v'>${DELIVERED}</div>`, ''),
      page('delivered').replaceAll('uds-udsFormat-step', 'uds-step'),
      page('delivered').replaceAll('step completed', 'step current'),
      page('delivered').replace("<div class='t'>Delivered</div>", "<div class='t'></div>"),
      page('delivered').replace("<div class='m'>EXAMPLEVILLE, IL<br>", "<div class='m'>EXAMPLE<br>EXAMPLEVILLE, IL<br>"),
      page('delivered').replace("<div class='m'>EXAMPLEVILLE, IL<br>2026-01-14&nbsp;-&nbsp;01:16:53 PM CST</div>", "<div class='m'></div>"),
      page('delivered').replace('2026-01-14&nbsp;-&nbsp;01:16:53 PM CST</div>', '2026-01-14&nbsp;-&nbsp;13:16:53 PM CST</div>'),
      page('delivered').replace('2026-01-14&nbsp;-&nbsp;01:16:53 PM CST</div>', '2026-02-30&nbsp;-&nbsp;01:16:53 PM CST</div>'),
      page('delivered').replace('2026-01-14&nbsp;-&nbsp;01:16:53 PM CST</div>', '01/14/2026 1:16 PM</div>'),
      page('not-found').replace(/<h2>[^<]*<\/h2>/, '<h2>Something went wrong</h2>'),
      '<html><body>Maintenance</body></html>']) {
      expect(() => parseUds(html, html.includes('Barcode Not Found') ? UNKNOWN : DELIVERED, JANUARY), html.slice(-200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the tracker’s notice for the number as a missing parcel, and a block page as a challenge', () => {
    expect(() => parseUds(page('not-found'), UNKNOWN, JANUARY)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The plain page names the barcode in its notice, which binds it the same way.
    expect(() => parseUds(page('not-found-plain'), ' 42uds-0000 0000 099 ', JANUARY)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseUds(page('not-found-plain'), DELIVERED, JANUARY)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUds(page('not-found-plain').replace(/Barcode <span[^>]*>[^<]*<\/span> Not Found/, 'Service unavailable'), UNKNOWN, JANUARY))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of [CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseUds(html, UNKNOWN, JANUARY)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes ten to forty letters and digits only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['UDS123456', 'APUDSABCDEFGH', `42UDS${'0'.repeat(36)}`, 'APUDS0000004/2', '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the notice for an unknown number as not found and recognizes a known parcel by its dated scan, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('delivered'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-14T19:16:53.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A page for another number is no answer either way.
    await expect(carrier(fetcher).recognize!('42UDS00000000018')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing parcels', async () => {
    const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(CHALLENGE));
    await expect(carrier(challenged).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(challenged).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    const redirected = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { Location: '/packageTrack.php' } }));
    await expect(carrier(redirected).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '  ']) {
      const empty = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(empty).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(empty).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: RECEIVED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('not-found')));
    await expect(carrier(flaky).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('not-found')));
    await expect(carrier(immediate).track({ number: UNKNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: UNKNOWN }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: RECEIVED }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('files UDS’s own labels under it without recognition, routes its links to the adapter, and claims no shipper barcode', async () => {
    for (const number of [DELIVERED, RECEIVED]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'united-delivery-service', confidence: 'high' });
      expect(recognitionAskedCarriers(number)).toEqual([]);
    }
    for (const number of ['EZ1000000000000000', 'BBC10000000', '100000000017']) expect(detectCarrierMatch(number).candidates ?? []).not.toContain('united-delivery-service');
    expect(parseTrackingInput(`https://www.uniteddeliveryservice.com/track/barcode/${DELIVERED}?t=1700000000000`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'united-delivery-service', source: 'link' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'united-delivery-service' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'united-delivery-service', source: 'united-delivery-service', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(UDS_ENDPOINT))).toBe(true);
  });
});

describe('United Delivery Service status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(udsMappedStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(stage);
    }
    expect(udsMappedStage('  OUT FOR   delivery ')).toBe('out_for_delivery');
    for (const wording of ['constructor', 'toString', 'Delivery', 'Barcode Not Found']) expect(udsMappedStage(wording), wording).toBeUndefined();
    expect(udsStage('Package delivered to the customer')).toMatchObject({ stage: 'delivered', source: expect.stringMatching(/^wording:/) });
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'united-delivery-service', description: 'Will-Call' })).toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
