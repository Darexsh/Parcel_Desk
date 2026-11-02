import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TRANSMISSION_SEARCH, TransmissionTracker } from './adapter.js';
import { normalizeTransmissionNumber, normalizeTransmissionPostcode, parseSearchReply, parseTransmissionPage } from './parser.js';
import { statusMap, transmissionMappedStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'T12345678000001';
const MOVING = 'P45000000000002';
const ANNOUNCED = 'T12345678000003';
const UNKNOWN = 'T00000000000000';
const POSTCODE = '1234AB';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const pageUrl = (number: string, postcode = POSTCODE) => `https://api.trans-mission.nl/tt/${number}/${postcode}`;
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const found = (number: string, postcode = POSTCODE) => new Response(null, { status: 303, headers: { Location: pageUrl(number, postcode) } });
const notice = (text: string, number = UNKNOWN) => fixture('search-unknown')
  .replace('Geen geldig zendingnummer', text).replace(`value="${UNKNOWN}"`, `value="${number}"`);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (fetcher: typeof fetch, number = DELIVERED, postcode: string | null = POSTCODE) => carrier(fetcher).track({ number, postcode });
/** A tracker whose form answers with `search` and whose shipment page answers with `page`. */
const site = (search: (body: URLSearchParams) => Response, page: (url: string) => Response = () => html(fixture('delivered'))) =>
  vi.fn<typeof fetch>().mockImplementation(async (url, init) =>
    String(url) === TRANSMISSION_SEARCH ? search(new URLSearchParams(String(init?.body))) : page(String(url)));
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('TransMission tracking adapter', () => {
  it('posts the number and postcode to the search form, then reads the shipment page it sends the browser to', async () => {
    const fetcher = site(() => found(DELIVERED));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new TransmissionTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' t 12 345678 000001 ', ' 1234 ab ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([TRANSMISSION_SEARCH, pageUrl(DELIVERED)]);
    const [search, page] = fetcher.mock.calls.map(([, init]) => init!);
    expect(search).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(search!.body)))).toEqual({ shipment_id: DELIVERED, zipcode: POSTCODE });
    expect(page).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'transmission', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads every unit’s scans once, in Dutch time, with each depot’s town, and leaves out the people', () => {
    const result = parseTransmissionPage(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Bezorgd', last_update: '2026-09-30T11:40:26+02:00', delivered_at: '2026-09-30T11:40:26+02:00', weight_kg: 6.5 });
    expect(result.events!.map((event) => [event.time, event.location, event.provider_code, event.stage, event.description])).toEqual([
      // The delivery is logged under 39 and again under 0, and each unit logs it: it shows once.
      ['2026-09-30T11:40:26+02:00', 'MONSTERDORP (NL)', '39', 'delivered', 'Bezorgd'],
      ['2026-09-30T08:12:40+02:00', 'MONSTERDORP (NL)', '188', 'out_for_delivery', 'Onderweg met de bezorger'],
      ['2026-09-30T04:39:15+02:00', 'MONSTERDORP (NL)', '30', 'in_transit', 'Aangekomen in uw regio'],
      ['2026-09-29T18:41:11+02:00', 'VOORBEELDSTAD (NL)', '20', 'in_transit', 'Verwerkt in sorteercentrum'],
      // The second unit's own sorting scan.
      ['2026-09-29T18:40:02+02:00', 'VOORBEELDSTAD (NL)', '20', 'in_transit', 'Verwerkt in sorteercentrum'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('expected_delivery');
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toMatch(/Erika|Voorbeeldnaam|Synthetic Shop|proefpad|1234AB|SYNTH|\+316|TESTWEG|PROEFSTRAAT|TRANSPORT B\.V\./i);
  });

  it('reads a parcel on its way from its search codes, with the repeated hour as its first occurrence and the expected day', () => {
    const result = parseTransmissionPage(fixture('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Aangekomen in uw regio',
      last_update: '2026-10-25T02:30:00+02:00', expected_delivery: '2026-10-26', weight_kg: 12.75 });
    expect(result.events!.map((event) => [event.time, event.location, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-10-25T02:30:00+02:00', 'PROEFSTAD', '30', 'in_transit', 'Aangekomen in uw regio'],
      // The sorting scan is worded as the delivery estimate; its code places it.
      ['2026-10-24T18:41:11+02:00', 'PROEFSTAD', '20', 'in_transit', 'Bezorgtijd nog onbekend'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Jan Proef|proefpad|0600000000|1234AB|MONSTERWEG|SAMPLE LOGISTICS/i);
  });

  it('reports an announced shipment without scans as registered', () => {
    expect(parseTransmissionPage(fixture('announced'), ANNOUNCED)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'Zending aangemeld', last_update: null, weight_kg: 18, summary_only: true, events: [] });
    // Without a headline it has still been announced.
    const bare = fixture('announced').replace(/<h2[^>]*>Zending aangemeld<\/h2>/, '<h2></h2>').replace('<p class="body-b2 gray-500">Zending aangemeld</p>', '');
    expect(parseTransmissionPage(bare, ANNOUNCED)).toMatchObject({ current_stage: 'registered', last_status_text: null, summary_only: true });
    // Older scans without a code or a known wording leave the stage to the shared rules.
    const uncoded = fixture('in-transit').replace(/<th>Zoek code<\/th>/, '').replace(/<td>30<\/td>|<td>20<\/td>/g, '')
      .replace('<h2 class=\'gray-900 s-bold \'>Aangekomen in uw regio</h2>', '<h2></h2>').replace('<td>Aangekomen in uw regio</td>', '<td>Bezorgtijd nog onbekend</td>');
    const result = parseTransmissionPage(uncoded, MOVING);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Bezorgtijd nog onbekend' });
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events!.every((event) => !('stage' in event) && !('provider_code' in event))).toBe(true);
  });

  it('reads a shipping unit’s barcode as that unit’s scans, once the page lists it', async () => {
    const unit = `${DELIVERED}002`;
    const result = parseTransmissionPage(fixture('delivered'), unit);
    expect(result.events!.map((event) => [event.time, event.provider_code])).toEqual([
      ['2026-09-30T11:40:26+02:00', '39'], ['2026-09-30T04:39:15+02:00', '30'], ['2026-09-29T18:40:02+02:00', '20'],
    ]);
    expect(result).toMatchObject({ current_stage: 'delivered', weight_kg: 2.5 });
    expect(() => parseTransmissionPage(fixture('delivered'), `${DELIVERED}003`))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'TransMission did not list the shipping unit asked' }));
    // The form takes the barcode and sends it to its shipment's page.
    const fetcher = site((body) => found(body.get('shipment_id')!.slice(0, 15)));
    await expect(lookup(fetcher, unit)).resolves.toMatchObject({ weight_kg: 2.5 });
    expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body)).get('shipment_id')).toBe(unit);
  });

  it('reads the delivery window and a delivery the box gives without a scan', () => {
    const window = fixture('in-transit').replace(/<h4 class='mb-1 gray-500 body-b2 font-weight-500'>Verwacht op:<\/h4>[\s\S]*?<\/address>/,
      '<h4 class=\'mb-1 gray-500 body-b2 font-weight-500\'>Geschat tussen</h4><h6 class=\'mb-1 gray-900 body-b2 font-weight-500 mb-2\'><span><img src="/images/order/Clock.svg" class=""> 26-10-2026 09:08 - 11:08</span> </h6>');
    expect(parseTransmissionPage(window, MOVING)).toMatchObject({
      expected_delivery_from: '2026-10-26T09:08:00+01:00', expected_delivery: '2026-10-26T11:08:00+01:00' });
    const unknown = fixture('announced');
    expect(parseTransmissionPage(unknown, ANNOUNCED)).not.toHaveProperty('expected_delivery');
    const boxOnly = fixture('delivered').replace(/<td>39<\/td>|<td>0<\/td>/g, '<td>77</td>').replace(/<td>Bezorgd<\/td>/g, '<td>Synthetic</td>');
    expect(parseTransmissionPage(boxOnly, DELIVERED)).toMatchObject({ current_stage: 'out_for_delivery' });
    const settled = boxOnly.replace(/<td>188<\/td>/, '<td>77</td>').replace('<td>Onderweg met de bezorger</td>', '<td>Synthetic</td>')
      .replace(/<td>30<\/td>|<td>20<\/td>/g, '<td>77</td>').replace(/<td>(?:Aangekomen in uw regio|Verwerkt in sorteercentrum)<\/td>/g, '<td>Synthetic</td>');
    expect(parseTransmissionPage(settled, DELIVERED)).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-09-30T11:40:00+02:00' });
  });

  it('reads the tracker’s own answer for an unknown number as not found, and a known one under another postcode as needing it', async () => {
    expect(() => parseSearchReply(fixture('search-unknown'), UNKNOWN, POSTCODE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSearchReply(notice('Invalid shipment number'), UNKNOWN, POSTCODE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(lookup(site(() => html(fixture('search-unknown'))), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    for (const text of ['Zending niet gevonden Voor Postcode: 1234AB', 'Shipment not found For Zipcode: 1234 ab']) {
      expect(() => parseSearchReply(notice(text), UNKNOWN, POSTCODE))
        .toThrow(expect.objectContaining({ kind: 'input_required', field: 'postcode', reason: 'postcode_mismatch' }));
    }
    expect(() => parseSearchReply(notice('Zending niet gevonden Voor Postcode: 9999ZZ'), UNKNOWN, POSTCODE))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'TransMission answered for another postcode' }));
    expect(() => parseSearchReply(notice('<br>Postcode is verplicht'), UNKNOWN, POSTCODE)).toThrow(expect.objectContaining({ kind: 'input_required' }));
    // Another notice, two notices, none, or the form for another number is no answer about the shipment.
    for (const reply of [notice('Synthetic notice'), notice('Geen geldig zendingnummer<br>Postcode is verplicht'), notice(''), notice('Geen geldig zendingnummer', DELIVERED)]) {
      expect(() => parseSearchReply(reply, UNKNOWN, POSTCODE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the answer to the whole number and postcode asked', async () => {
    expect(() => parseTransmissionPage(fixture('delivered'), ANNOUNCED)).toThrow(expect.objectContaining({ kind: 'schema', message: 'TransMission answered for another shipment' }));
    await expect(lookup(site(() => found(ANNOUNCED)))).rejects.toMatchObject({ kind: 'schema', message: 'TransMission answered for another shipment' });
    await expect(lookup(site(() => found(DELIVERED, '9999ZZ')))).rejects.toMatchObject({ kind: 'schema', message: 'TransMission answered for another postcode' });
    await expect(lookup(site(() => new Response(null, { status: 303, headers: { Location: 'https://api.trans-mission.nl/Search-shipment' } }))))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(site(() => new Response(null, { status: 303, headers: { Location: `https://example.com/tt/${DELIVERED}/${POSTCODE}` } }))))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    // A shipment page that sends the browser back to the form shows nothing.
    await expect(lookup(site(() => found(DELIVERED), () => html('', 200, { Refresh: '0;url=https://api.trans-mission.nl/Search-shipment' }))))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(site(() => found(DELIVERED), () => new Response(null, { status: 302, headers: { Location: TRANSMISSION_SEARCH } }))))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps a browser check and a changed page apart from a missing shipment', async () => {
    await expect(lookup(site(() => html(CHECK)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => html(CHECK, 403)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => found(DELIVERED), () => html(CHECK)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => html('<html><title>TransMission</title></html>')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(site(() => found(DELIVERED), () => html('')))).rejects.toMatchObject({ kind: 'schema' });
    for (const change of [
      (page: string) => page.replace('<th>Tijd</th>', '<th>Synthetic</th>'),
      (page: string) => page.replace('<td>11:40:26</td>', '<td>24:00:00</td>'),
      (page: string) => page.replace('<td>30-09-2026</td>', '<td>31-09-2026</td>'),
      (page: string) => page.replace('<td>30-09-2026</td>', '<td>2026-09-30</td>'),
      (page: string) => page.replace('<td>Onderweg met de bezorger</td>', '<td></td>'),
      (page: string) => page.replace('<td>188</td>', '<td>A1</td>'),
      (page: string) => page.replace(/(>Historie<\/h4>[\s\S]*?<tbody>)/, `$1${'<tr><td>30-09-2026</td><td>11:40:26</td><td>3400</td><td>30</td><td>Synthetic</td></tr>'.repeat(501)}`),
    ]) {
      expect(() => parseTransmissionPage(change(fixture('delivered')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('cuts the name of whoever took the parcel from a scan', () => {
    const signed = fixture('delivered').replace(/<td>Bezorgd<\/td>/g, '<td>Bezorgd - ontvangen door Voorbeeldnaam</td>');
    const result = parseTransmissionPage(signed, DELIVERED);
    expect(result.events![0]).toMatchObject({ description: 'Bezorgd', stage: 'delivered' });
    expect(JSON.stringify(result)).not.toContain('Voorbeeldnaam');
  });

  it('takes T or P and fourteen digits, or a unit’s seventeen, and the recipient’s postcode, without a request otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['T1234567800000', 'T1234567800000100', 'X12345678000001', '12345678000001', 'T12345678000001001X']) {
      await expect(lookup(fetcher, number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(lookup(fetcher, DELIVERED, null)).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    await expect(lookup(fetcher, DELIVERED, '  ')).rejects.toMatchObject({ kind: 'input_required' });
    await expect(lookup(fetcher, DELIVERED, 'AB')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTransmissionNumber('p 45 000000 000002')).toEqual({ asked: MOVING, shipment: MOVING });
    expect(normalizeTransmissionNumber(`${DELIVERED}001`)).toEqual({ asked: `${DELIVERED}001`, shipment: DELIVERED });
    expect(normalizeTransmissionPostcode(' 1234  ab ')).toBe('1234AB');
    expect(normalizeTransmissionPostcode('1000')).toBe('1000');
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = site(() => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(lookup(fetcher)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'not_found'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s from the shipment page as its kind, without a retry', async (status, kind) => {
      const fetcher = site(() => found(DELIVERED), () => html('', status));
      await expect(lookup(fetcher)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = site(() => found(DELIVERED));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(lookup(flaky)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url]) => String(url))).toEqual([TRANSMISSION_SEARCH, TRANSMISSION_SEARCH, pageUrl(DELIVERED)]);
    const immediate = site(() => found(DELIVERED));
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
    await expect(lookup(site(() => found(DELIVERED), () => new Response(new Uint8Array(3_000_000))))).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under TransMission with its postcode to the adapter, and reads only the number from a tracker link', async () => {
    const fetcher = site(() => found(DELIVERED));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: 'T 12 345678 000001', carrier: 'transmission', postcode: '1234 ab' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'transmission', source: 'transmission', result: { current_stage: 'delivered' } });
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'transmission' }))
      .rejects.toThrow('TransMission requires the delivery postcode');
    expect(parseTrackingInput(pageUrl(DELIVERED))).toMatchObject({ trackingNumber: DELIVERED, carrier: 'transmission', source: 'link' });
  });

  it('is only suggested by number and never asked: every lookup needs the postcode', () => {
    for (const number of [DELIVERED, MOVING]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates).toContain('transmission');
      expect(recognitionAskedCarriers(number)).not.toContain('transmission');
    }
    expect(carrier(vi.fn<typeof fetch>())).not.toHaveProperty('recognize');
  });
});

type Entry = { code?: string; wording: string; stage?: string; confirmedBy: string };

describe('TransMission status vocabulary', () => {
  it('maps every code and wording seen to the stage recorded for it, and leaves the estimate without one', () => {
    for (const entry of statuses.entries as Entry[]) {
      const answer = statusMapAnswer({ carrier: 'transmission', providerCode: entry.code ?? null, description: entry.wording });
      if (entry.stage) {
        expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
        expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      } else {
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
      }
    }
    // Every wording the adapter writes is recorded.
    const recorded = new Set((statuses.entries as Entry[]).map((entry) => normalizeStatusWording(entry.wording)));
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', MOVING]] as const) {
      for (const event of parseTransmissionPage(fixture(name), number).events!) {
        expect(recorded.has(normalizeStatusWording(event.description!)), event.description).toBe(true);
      }
    }
    expect(transmissionMappedStage('99', 'Synthetic status')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'transmission', providerCode: null, description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
  });
});
