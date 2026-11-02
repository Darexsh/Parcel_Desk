import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MIDLAND_TRACKING, MidlandTracker, midlandTrackingUrl } from './adapter.js';
import { normalizeMidlandNumber, parseMidland } from './parser.js';
import { midlandMappedStage, midlandStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1234567090123457';
const IN_TRANSIT = '0000000000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const answering = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => answer());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const IMPERVA = '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"></head><body style="margin:0px;height:100%">'
  + '<iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=00&incident_id=0-000000000000000000" frameborder=0 width="100%" height="100%">'
  + 'Request unsuccessful. Incapsula incident ID: 0-000000000000000000</iframe></body></html>';
const ASP_ERROR = '<!DOCTYPE html><html><head><title>Error</title></head><body><div class="container body-content">'
  + '<h1 class="text-danger">Error.</h1><h2 class="text-danger">An error occurred while processing your request.</h2></div></body></html>';
/** The delivered page with its history table's rows replaced. */
const withRows = (rows: string) => fixture('delivered').replace(/(<tbody>\s*)<tr class="scan-content">[\s\S]*?(\s*<\/tbody>\s*<\/table>\s*<\/div>\s*<\/div>\s*<\/div>)/,
  `$1${rows}$2`);
const row = (clock: string, activity: string, description: string, location = '') =>
  `<tr class="scan-content"><td>${clock}</td><td>${activity}</td><td class="scan-description text-center" data-location="${location}">${description}</td></tr>`;

describe('Midland Transport HTTP adapter', () => {
  it('opens the tracking page for the number in English through the supplied transport', async () => {
    const fetcher = answering(() => html(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MidlandTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 5670 9012 3457 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${MIDLAND_TRACKING}?TrackingNumber=${DELIVERED}&Lang=0`);
    expect(midlandTrackingUrl(DELIVERED)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'midland-transport', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, with the creation, each terminal as a location and wall clocks kept local', () => {
    const result = parseMidland(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-05T13:47:00',
      expected_delivery: null, service_name: 'Ground', destination_country: 'CA',
    });
    expect(result.events).toEqual([
      { local_time: '2026-03-05T13:47:00', location: 'EXAMPLE COVE, NS', description: 'Delivered', provider_code: 'Delivered',
        stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-03-05T08:15:00', location: 'EXAMPLE COVE, NS', description: 'Out for Delivery', provider_code: 'Out For Delivery',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-03-04T09:30:00', location: 'TESTVILLE, NB', description: 'Delayed in Transit - SHIPPER\'S DELAY',
        provider_code: 'Delivery Exception', stage: 'exception', stage_source: 'carrier_map' },
      { local_time: '2026-03-03T04:12:00', location: 'TESTVILLE, NB', description: 'Processed at Sort Facility', provider_code: 'In Transit',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-02T17:05:00', location: 'SAMPLETON, ON', description: 'Processed at Sort Facility', provider_code: 'In Transit',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-02T17:05:00', location: 'SAMPLETON, ON', description: 'Picked up', provider_code: 'Picked Up',
        stage: 'accepted', stage_source: 'carrier_map' },
      { local_time: '2026-03-02T10:20:00', description: 'Shipment Created', provider_code: 'Shipment Created',
        stage: 'registered', stage_source: 'carrier_map' },
    ]);
    // The shipper's name, phone, email and reference, the towns and the package list are not kept.
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE OUTFITTERS|0000000000|example\.com|EXAMPLE-REF|CANADA|Related/);
  });

  it('reads a history still on its way, with its first estimate when the page has no updated one', () => {
    expect(parseMidland(fixture('in-transit'), IN_TRANSIT)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Processed at Sort Facility', last_update: null, last_update_local: '2026-03-10T02:31:00',
      expected_delivery: '2026-03-12', service_name: 'Ground', destination_country: 'CA',
      events: [
        { local_time: '2026-03-10T02:31:00', location: 'TESTVILLE, NB', description: 'Processed at Sort Facility', provider_code: 'In Transit',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T18:02:00', location: 'SAMPLETON, ON', description: 'Picked up', provider_code: 'Picked Up',
          stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T15:40:00', description: 'Shipment Created', provider_code: 'Shipment Created',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The updated estimate wins over the first.
    const updated = fixture('in-transit').replace(/Updated Expected Delivery:\s*<strong style="float:right">\s*-\s*/, 'Updated Expected Delivery: <strong>Mar 13 2026 ');
    expect(parseMidland(updated, IN_TRANSIT).expected_delivery).toBe('2026-03-13');
  });

  it('reads a shipment Midland has not scanned yet as its creation, in place of the page’s placeholder row', () => {
    expect(parseMidland(fixture('created'), IN_TRANSIT)).toMatchObject({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Created', last_update_local: '2026-03-09T15:40:00', expected_delivery: '2026-03-12',
      events: [{ local_time: '2026-03-09T15:40:00', description: 'Shipment Created', provider_code: 'Shipment Created',
        stage: 'registered', stage_source: 'carrier_map' }],
    });
    // Without the creation date the placeholder row stands, staged by its Activity.
    const undated = fixture('created').replace('Mar 09 2026 15:40', '-');
    expect(parseMidland(undated, IN_TRANSIT).events).toEqual([{ local_time: '2026-03-09T15:40:00', provider_code: 'No Tracking Info',
      description: 'Your Shipment has been created. Check back soon for more info once the carrier/courier starts to scan.',
      stage: 'registered', stage_source: 'carrier_map' }]);
  });

  it('stages a scan by its Activity, else by its wording, and the parcel by the page’s summary word', () => {
    const page = withRows([
      row('06 Mar 2026 10:00', 'Returned', 'Returned to Shipper(SAMPLETON,ON)', 'CANADA, ONTARIO, SAMPLETON'),
      row('07 Mar 2026 11:00', 'Customs Note', 'Paperwork reviewed', 'UNITED STATES, MAINE, TESTPORT'),
    ].join('')).replace('<strong class="text-uppercase">Delivered</strong>', '<strong class="text-uppercase">Something New</strong>');
    const result = parseMidland(page, DELIVERED);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2026-03-07T11:00:00', location: 'UNITED STATES, MAINE, TESTPORT', description: 'Paperwork reviewed', provider_code: 'Customs Note' },
      { local_time: '2026-03-06T10:00:00', location: 'SAMPLETON, ON', description: 'Returned to Shipper', provider_code: 'Returned',
        stage: 'returned', stage_source: expect.stringMatching(/^wording:/) },
    ]);
    // An unknown summary word gives way to the newest staged scan.
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Paperwork reviewed', expected_delivery: null });
    // A signer or phone number in the wording is dropped.
    const signed = parseMidland(withRows(row('05 Mar 2026 13:47', 'Delivered', 'Delivered - Signed by EXAMPLE PERSON 506 000 0000(EXAMPLE COVE,NS)')), DELIVERED);
    expect(signed.events![0]).toMatchObject({ description: 'Delivered', location: 'EXAMPLE COVE, NS' });
    expect(JSON.stringify(signed)).not.toMatch(/EXAMPLE PERSON|506/);
  });

  it('reads the tracker’s line for an unknown number as not found when its search field repeats the number asked', async () => {
    expect(() => parseMidland(fixture('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMidland(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMidland(fixture('not-found').replace(/ value="0000000000000000"/, ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(answering(() => html(fixture('not-found')))).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a shipment for another number or carrier, or without its number, carrier, scans or valid clocks', () => {
    expect(() => parseMidland(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMidland(fixture('delivered').replace('<label>Package Tracking#:</label>', '<label>Tracking:</label>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMidland(fixture('delivered').replace(/(<label>Carrier:<\/label>\s*)Midland Courier/, '$1Example Freight'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMidland(fixture('delivered').replace('<label>Carrier:</label>', ''), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMidland(withRows('').replace('Mar 02 2026 10:20', '-'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseMidland(withRows('<tr class="scan-content"><td>02 Mar 2026 17:05</td><td>Picked Up</td></tr>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const clock of ['30 Feb 2026 08:27', '02 Mar 2026 24:00', '2026-03-02 08:27', '02 Mar 2026', '02 Mzr 2026 08:27']) {
      expect(() => parseMidland(withRows(row(clock, 'In Transit', 'Processed at Sort Facility(TESTVILLE,NB)')), DELIVERED), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps blocks, rate limits, moved routes and server errors apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => html(IMPERVA))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(IMPERVA, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Too Many Requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: '/login/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('Server Error', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => html(ASP_ERROR))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => html('<html><body><h1>Midland</h1></body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    // Every page loads Imperva's script; on a page with a shipment that is no block.
    expect(fixture('delivered')).toContain('_Incapsula_Resource');
  });

  it('asks once more when Midland cannot be reached, inside the caller’s budget', async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return html(fixture('delivered'));
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new MidlandTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('rejects what is not a sixteen-digit number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '123456789012345', '12345678901234567', 'A234567890123456', `${'0'.repeat(70)}`, '１２３４５６７８９０１２３４５６']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMidlandNumber('1234-5670-9012-3457')).toBe(DELIVERED);
  });

  it('answers a number filed under Midland Transport, and leaves sixteen digits unclaimed', async () => {
    const fetcher = answering(() => html(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'midland-transport' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'midland-transport', source: 'midland-transport', result: { current_stage: 'delivered' } });
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('midland-transport');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id), number).not.toContain('midland-transport');
    }
    expect(carrier(fetcher).recognize).toBeUndefined();
  });
});

describe('Midland Transport status vocabulary', () => {
  it('maps every recorded Activity to the stage it records', () => {
    const entries = statuses.entries as { code: string; wording: string; stage: string }[];
    for (const entry of entries) {
      expect(midlandMappedStage(entry.code), entry.code).toBe(entry.stage);
      expect(midlandStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'midland-transport', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'midland-transport', providerCode: 'Customs Note', description: 'Paperwork reviewed' }))
      .toEqual({ kind: 'unknown' });
    expect(midlandStage('Customs Note', 'Paperwork reviewed')).toBeNull();
  });
});
