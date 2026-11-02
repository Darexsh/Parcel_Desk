import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierRequirements, requirementSatisfied } from '../../core/catalog/index.js';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PACKS_TRACKING_PAGE, PacksTracker } from './adapter.js';
import { normalizePacksNumber, normalizePacksPostcode, parsePacks } from './parser.js';
import { packsMappedStage, packsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '90000001';
const MOVING = '90000002';
const ANNOUNCED = '90000003';
const REFERENCE = 'UTV900000004';
const UNKNOWN = '90000009';
const POSTCODE = '9999 ZZ';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (fetcher: typeof fetch, number = DELIVERED) => carrier(fetcher).track({ number, postcode: POSTCODE });
/** A site answering every lookup with this page. */
const site = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => answer());
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Packs tracking adapter', () => {
  it('posts the number and postcode as the tracking form does', async () => {
    const fetcher = site(() => html(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new PacksTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 9000 0001 ', ' 9999 zz ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PACKS_TRACKING_PAGE);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ zendingnr: DELIVERED, postcode: '9999ZZ', searchcode: 'Zoeken' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'packs', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery after a failed attempt from Dutch wall clocks, with the planning notices unstaged', () => {
    const result = parsePacks(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Uw zending is afgeleverd.', last_update: '2026-03-17T14:05:00+01:00', delivered_at: '2026-03-17T14:05:00+01:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.stage, event.description])).toEqual([
      ['2026-03-17T14:05:00+01:00', 'delivered', 'Uw zending is afgeleverd.'],
      ['2026-03-17T11:15:00+01:00', 'failed_attempt', 'De bezorging is niet gelukt.'],
      ['2026-03-17T09:02:00+01:00', undefined, 'Er is een afleverinstructie aan de zending toegevoegd.'],
      ['2026-03-17T07:30:00+01:00', undefined, 'Er is een nieuw tijdvenster aan deze zending toegekend.'],
      ['2026-03-17T00:12:00+01:00', 'in_transit', 'Uw zending is bij ons sorteercentrum aangekomen.'],
      ['2026-03-13T16:41:00+01:00', 'in_transit', 'Uw zending is aangekomen in het regionale Packscenter.'],
      ['2026-03-13T16:40:00+01:00', 'registered', 'Uw zending is aangemeld'],
    ]);
    expect(result.events!.every((event) => !('location' in event))).toBe(true);
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result).not.toHaveProperty('summary_only');
    // The sender, the delivery address and the postcode in the page's links are never read.
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|Erika|Voorbeeld|9999|review/i);
  });

  it('reads a parcel in sorting with the repeated hour as its first occurrence, and its delivery window', () => {
    const result = parsePacks(page('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-10-25T05:45:00+01:00',
      last_status_text: 'De zending heeft een tijdvak toegekend gekregen.',
      expected_delivery_from: '2026-10-26T10:00:00+01:00', expected_delivery: '2026-10-26T15:00:00+01:00' });
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-10-25T05:45:00+01:00', undefined],
      ['2026-10-25T02:30:00+02:00', 'in_transit'],
      ['2026-10-24T17:25:00+02:00', 'accepted'],
      ['2026-10-24T15:10:00+02:00', 'registered'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/9999|DeliveryOptions/);
  });

  it('reads the other ways the page states an expected delivery', () => {
    const at = (spans: string) => parsePacks(page('in-transit').replace(/<span class="eir-ro1-big">maandag.*?geleverd\.<\/span>/, spans), MOVING);
    expect(at('<span class="eir-ro1-big">dinsdag 27 oktober 2026 08:00 - 18:00</span>'))
      .toMatchObject({ expected_delivery_from: '2026-10-27T08:00:00+01:00', expected_delivery: '2026-10-27T18:00:00+01:00' });
    expect(at('<span class="eir-ro1-big">vrijdag 23 Oktober 2026 Uw zending wordt tussen 14:00 uur - 17:00 uur geleverd.</span>'))
      .toMatchObject({ expected_delivery_from: '2026-10-23T14:00:00+02:00', expected_delivery: '2026-10-23T17:00:00+02:00' });
    // A day without a window, or with one that does not close after it opens, is the day alone.
    const day = at('<span class="eir-ro1-big">maandag 26 oktober 2026</span><span class="eir-ro1-big">Eerstvolgende werkdag.</span>');
    expect(day).toMatchObject({ expected_delivery: '2026-10-26' });
    expect(day).not.toHaveProperty('expected_delivery_from');
    expect(at('<span class="eir-ro1-big">maandag 26 oktober 2026 15:00 - 10:00</span>')).toMatchObject({ expected_delivery: '2026-10-26' });
    // No day, or one that is not in the calendar, is no estimate.
    expect(at('<span class="eir-ro1-big">Morgen</span>')).toMatchObject({ expected_delivery: null });
    expect(at('<span class="eir-ro1-big">31 februari 2026</span>')).toMatchObject({ expected_delivery: null });
  });

  it('reads an announced shipment, whose block above the rail names no day', () => {
    const result = parsePacks(page('registered'), ANNOUNCED);
    expect(result).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Uw zending is aangemeld', last_update: '2026-04-20T09:49:00+02:00', expected_delivery: null,
      events: [{ time: '2026-04-20T09:49:00+02:00', description: 'Uw zending is aangemeld', stage: 'registered', stage_source: 'carrier_map' }] });
  });

  it('reads a reference’s page under the shipment number it names, as a delivery stated above the rail', () => {
    const result = parsePacks(page('summary'), REFERENCE);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Uw zending is afgeleverd.', last_update: '2025-08-21T19:53:00+02:00', expected_delivery: null,
      delivered_at: '2025-08-21T19:53:00+02:00', canonical_tracking_number: '90000004', summary_only: true, events: [] });
    // The delivery heading settles a delivery without its clock, and the status alone settles one without the heading.
    expect(parsePacks(page('summary').replace('21-08-2025 19:53', 'gisteren'), REFERENCE)).toMatchObject({ current_stage: 'delivered', last_update: null });
    expect(parsePacks(page('summary').replace('afgeleverd op:', 'Bezorgmoment:'), REFERENCE)).toMatchObject({ current_stage: 'delivered', expected_delivery: null });
    // A status the map does not know leaves the stage open.
    const open = parsePacks(page('summary').replace(/<span>Uw zending is afgeleverd\.<\/span>/, '<span>Synthetische status</span>')
      .replace('afgeleverd op:', 'Bezorgmoment:'), REFERENCE);
    expect(open).toMatchObject({ status: 'unknown', last_status_text: 'Synthetische status', summary_only: true });
    expect(open).not.toHaveProperty('current_stage');
  });

  it('settles a delivery the page states while the details have not reached it', () => {
    const result = parsePacks(page('delivered').replace(/\s*<div class="status-details-row">\s*<div class="status-details-time">17-03-2026 14:05[\s\S]*?<\/div>\s*<\/div>/, ''), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'De bezorging is niet gelukt.', delivered_at: '2026-03-17T14:05:00+01:00' });
    expect(result.events).toHaveLength(6);
  });

  it('reads the tracker’s notice as not found, and another notice as inconclusive', async () => {
    expect(() => parsePacks(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(lookup(site(() => html(page('not-found'))), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // If Packs corrects its spelling, the notice still reads.
    expect(() => parsePacks(page('not-found').replace('bekent', 'bekend'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePacks(page('not-found').replace(/Deze zendingnummer[^<]*/, 'Onze Track &amp; Trace is tijdelijk niet beschikbaar.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds Packs’ own number to the page’s shipment number, and reports a reference’s', () => {
    expect(() => parsePacks(page('delivered'), MOVING)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Packs answered for another shipment' }));
    expect(parsePacks(page('delivered'), '900000011')).toMatchObject({ canonical_tracking_number: DELIVERED });
    expect(parsePacks(page('delivered'), 'a900000001')).toMatchObject({ canonical_tracking_number: DELIVERED });
    expect(() => parsePacks(page('delivered').replace('<h2>Zendingnummer</h2>', '<h2>Referentie</h2>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Packs returned a shipment without its number' }));
    expect(() => parsePacks(page('delivered').replace(/90000001(\s*<\/div>)/, '$1'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects changed pages', () => {
    for (const changed of [
      page('form'),
      '',
      page('delivered').replace('17-03-2026 11:15', '17.03.2026 11:15'),
      page('delivered').replace('17-03-2026 11:15', '30-02-2026 11:15'),
      page('delivered').replace('17-03-2026 11:15', '17-03-2026 24:00'),
      page('delivered').replace('De bezorging is niet gelukt.', ''),
      page('delivered').replace(/<span>Uw zending is afgeleverd\.<\/span>/, '<span> </span>'),
      page('delivered') + page('not-found'),
      page('delivered').replace(/<div class="status-details-row">[\s\S]*?<\/div>\s*<\/div>/, (row) => row.repeat(301)),
    ]) {
      expect(() => parsePacks(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a browser check, a moved page and a broken reply apart from a missing shipment', async () => {
    await expect(lookup(site(() => html(CHECK)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => html(CHECK, 403)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => html(page('form'))))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(site(() => html('')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(site(() => new Response(null, { status: 301, headers: { Location: 'https://www.packs.nl/' } }))))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('takes 8 to 30 letters and digits and a Benelux postcode, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['9000001', 'ABCDEFGHIJ', '9'.repeat(31), '90000001/1']) {
      await expect(lookup(fetcher, number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    await expect(carrier(fetcher).track({ number: DELIVERED, postcode: '  ' })).rejects.toMatchObject({ kind: 'input_required' });
    for (const postcode of ['75001', '0999 AB', '1234 A', 'SW1A 1AA', 'D-1000']) {
      await expect(carrier(fetcher).track({ number: DELIVERED, postcode }), postcode).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePacksNumber(' utv 9000-0000-4 ')).toBe(REFERENCE);
    expect(normalizePacksPostcode('9999 zz')).toBe('9999ZZ');
    expect(normalizePacksPostcode('1000')).toBe('1000');
    expect(normalizePacksPostcode('B-1000')).toBe('1000');
    expect(normalizePacksPostcode('lu 1234')).toBe('1234');
  });

  it('asks the form for a Benelux postcode, which the catalog stores as typed', () => {
    const [requirement] = carrierRequirements('packs', DELIVERED);
    expect(requirement).toMatchObject({ field: 'postcode', validator: 'internationalPostcode', maxLength: 7, inputMode: 'text' });
    expect(requirement!.optional).toBeUndefined();
    for (const value of ['9999ZZ', '9999 zz', '1000', 'B-1000', 'BE 1000', 'L-1234', 'LU1234']) expect(requirementSatisfied(requirement!, value), value).toBe(true);
    for (const value of ['75001', '0999 AB', '999', 'SW1A 1AA', 'D-1000', '9999 Z']) expect(requirementSatisfied(requirement!, value), value).toBe(false);
    // Browsers compile the field's pattern with the `v` flag.
    expect(() => new RegExp(requirement!.pattern!, 'v')).not.toThrow();
    expect(() => normalizeCarrierInputs('packs', DELIVERED, '', '')).toThrow('Packs requires the delivery postcode');
    expect(normalizeCarrierInputs('packs', DELIVERED, '', ' 9999 zz ')).toEqual({ trackingUrl: null, postcode: '9999 ZZ' });
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = site(() => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(lookup(fetcher)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)('keeps HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = site(() => html('<html></html>', status));
    await expect(lookup(fetcher)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = site(() => html(page('delivered')));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(lookup(flaky)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = site(() => html(page('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED, postcode: POSTCODE }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED, postcode: POSTCODE }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED, postcode: POSTCODE }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await expect(lookup(site(() => new Response(new Uint8Array(1_100_000))))).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under Packs with its postcode to the adapter, and reads only the number from a tracking link', async () => {
    const fetcher = site(() => html(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'packs', postcode: POSTCODE }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'packs', source: 'packs', result: { current_stage: 'delivered' } });
    expect(parseTrackingInput(`https://www.packs.nl/track-trace/?zendingnr=${DELIVERED}&postcode=9999ZZ`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'packs', source: 'link' });
  });

  it('is not claimed or asked by number alone: eight digits are shared and every lookup needs the postcode', () => {
    for (const number of [DELIVERED, REFERENCE]) {
      expect(detectCarrierMatch(number).carrier).not.toBe('packs');
      expect(recognitionAskedCarriers(number)).not.toContain('packs');
    }
    expect(carrier(vi.fn<typeof fetch>())).not.toHaveProperty('recognize');
  });
});

type Entry = { wording: string; stage?: string; confirmedBy: string; unmapped?: boolean };

describe('Packs status vocabulary', () => {
  it('maps every recorded wording to its stage, and leaves the planning notices unmapped on purpose', () => {
    for (const entry of statuses.entries as Entry[]) {
      const wording = normalizeStatusWording(entry.wording);
      if (entry.unmapped) {
        expect(statusMap.stage(null, wording), entry.wording).toBeUndefined();
        expect(packsStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'packs', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
      } else {
        expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'packs', providerCode: null, description: entry.wording }), entry.wording)
          .toEqual({ kind: 'mapped', stage: entry.stage });
      }
    }
    // Every sentence the fixtures hold is recorded.
    const recorded = new Set((statuses.entries as Entry[]).map((entry) => normalizeStatusWording(entry.wording).replace(/[\s.!]+$/, '')));
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', MOVING], ['registered', ANNOUNCED]]) {
      for (const event of parsePacks(page(name!), number!).events!) {
        expect(recorded.has(normalizeStatusWording(event.description!).replace(/[\s.!]+$/, '')), event.description).toBe(true);
      }
    }
    // With or without its full stop.
    expect(packsMappedStage('Uw zending is afgeleverd')).toBe('delivered');
    expect(statusMapAnswer({ carrier: 'packs', providerCode: null, description: 'Er is een nieuw tijdvenster aan deze zending toegekend' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(packsMappedStage('Synthetische status')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'packs', providerCode: null, description: 'Synthetische status' })).toEqual({ kind: 'unknown' });
  });
});
