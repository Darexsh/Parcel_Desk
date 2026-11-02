import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, IDS_MAINTENANCE_API, IDS_PARTNERS_API, IDS_STATUS_API, IdsLogistikTracker } from './adapter.js';
import { normalizeIdsNumber, normalizeIdsPostcode, parseIdsPartners, parseIdsReply } from './parser.js';
import { idsMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9000000000000001';
const MOVING = '9000000000000002';
const UNKNOWN = '9000000000000003';
const POSTCODE = '00000';
type Row = Record<string, unknown>;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Row => JSON.parse(text(name)) as Row;
const record = (payload: Row) => payload.result as Row;
const edited = (name: string, change: (result: Row, payload: Row) => void): Row => {
  const payload = fixture(name);
  change(record(payload), payload);
  return payload;
};
const towns = parseIdsPartners(fixture('partners'));
const reply = (body: string | null, status = 200, type = 'application/json') =>
  new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (fetcher: typeof fetch, number = DELIVERED) => carrier(fetcher).track({ number, postcode: POSTCODE });
/** A site answering the status lookup with this reply, and the partner list and maintenance flag as given. */
const site = (status: (body: Row) => Response, side: { partners?: () => Response; maintenance?: () => Response } = {}) =>
  vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url) === IDS_PARTNERS_API) return side.partners?.() ?? reply(text('partners'));
    if (String(url) === IDS_MAINTENANCE_API) return side.maintenance?.() ?? reply('{"text":"Synthetic notice","single":[],"active":false}');
    return status(JSON.parse(String(init?.body)) as Row);
  });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('IDS Logistik tracking adapter', () => {
  it('posts the number and postcode to the page’s lookup, then reads the partner list once for the depots’ towns', async () => {
    const fetcher = site((body) => reply(text(body.trackingNumber === DELIVERED ? 'delivered' : 'in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new IdsLogistikTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 9000 0000 0000 0001 ', ' 00000 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([IDS_STATUS_API, IDS_PARTNERS_API]);
    const [, init] = fetcher.mock.calls[0]!;
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ trackingNumber: DELIVERED, zipCode: POSTCODE });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ids-logistik', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    // The list is kept for later lookups.
    await tracker.fetch(MOVING, POSTCODE);
    expect(fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url === IDS_PARTNERS_API)).toHaveLength(1);
  });

  it('reads a delivery after a failed attempt as the page shows it, from German wall clocks, with each depot’s town', () => {
    const result = parseIdsReply(fixture('delivered'), DELIVERED, POSTCODE, towns);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Ihre Sendung wurde zugestellt.', last_update: '2026-03-26T10:15:00+01:00', delivered_at: '2026-03-26T10:15:00+01:00' });
    expect(result.events!.map((event) => [event.time, event.location, event.stage, event.provider_code])).toEqual([
      ['2026-03-26T10:15:00+01:00', 'Beispielhausen', 'delivered', '27'],
      ['2026-03-26T08:00:00+01:00', 'Beispielhausen', 'out_for_delivery', '40'],
      ['2026-03-25T11:20:00+01:00', 'Beispielhausen', 'failed_attempt', '22'],
      ['2026-03-25T07:30:00+01:00', 'Beispielhausen', 'out_for_delivery', '40'],
      // The appointment is filed at the delivering depot, as the page files it.
      ['2026-03-24T07:00:00+01:00', 'Beispielhausen', 'in_transit', '25'],
      ['2026-03-24T06:10:00+01:00', 'Beispielhausen', 'in_transit', undefined],
      // The linehaul manifest, at the collecting depot.
      ['2026-03-23T21:30:00+01:00', 'Musterstadt', 'in_transit', undefined],
      // The pickup repeated two minutes later shows once; the scan without a sentence not at all.
      ['2026-03-23T15:42:10+01:00', 'Musterstadt', 'accepted', undefined],
    ]);
    expect(result.events!.map((event) => event.description)).toEqual([
      'Ihre Sendung wurde zugestellt.',
      'Ihre Sendung befindet sich in der Zustellung.',
      'Wir konnten Sie nicht antreffen oder Ihre Warenannahme war bereits geschlossen. Bei Sendungen mit vereinbartem Liefertermin melden wir uns erneut bei Ihnen.',
      'Ihre Sendung befindet sich in der Zustellung.',
      'Die Zustellung Ihrer Sendung ist zum angekündigten Zustelltermin geplant.',
      'Ihre Sendung ist im Zustelldepot eingetroffen und wird für die Zustellung vorbereitet.',
      'Ihre Sendung befindet sich auf dem Weg zu unserem Zustelldepot.',
      'Ihre Sendung wurde abgeholt und befindet sich in unserem Versanddepot.',
    ]);
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|Erika|SYNTHETIC|38\.5|00001/);
  });

  it('reads a parcel on its way with the repeated hour as its first occurrence, and only the depot’s own arrival', () => {
    const result = parseIdsReply(fixture('in-transit'), MOVING, POSTCODE, towns);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-10-25T02:30:00+02:00' });
    expect(result.events!.map((event) => [event.time, event.location, event.stage])).toEqual([
      ['2026-10-25T02:30:00+02:00', 'Beispielhausen', 'in_transit'],
      ['2026-10-24T21:00:00+02:00', 'Musterstadt', 'in_transit'],
      ['2026-10-24T16:05:00+02:00', 'Musterstadt', 'accepted'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    // Without the partner list the scans have no town.
    expect(parseIdsReply(fixture('in-transit'), MOVING, POSTCODE).events!.every((event) => !('location' in event))).toBe(true);
  });

  it('keeps an offset the reply gives, a clock without seconds, and the manifest before a scan on its clock', () => {
    const result = parseIdsReply(edited('in-transit', (shipment) => {
      const rows = shipment.history as Row[];
      rows[0]!.time = '2026-10-24T14:05:00Z';
      rows[2]!.time = '2026-10-24 21:00';
      (shipment.header as Row).bordered = '2026-10-24 21:00:00.000000';
    }), MOVING, POSTCODE);
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-10-24T21:00:00+02:00', 'in_transit'],
      ['2026-10-24T21:00:00+02:00', 'in_transit'],
      ['2026-10-24T14:05:00Z', 'accepted'],
    ]);
    expect(result.events![0]!.description).toMatch(/^Ihre Sendung ist im Zustelldepot/);
  });

  it('reports a shipment without a scan the page shows at its first step, and lets the rail settle a delivery', () => {
    const held = parseIdsReply(edited('not-found', (shipment) => { (shipment.header as Row).id = 'SYNTHETIC-0003'; }), UNKNOWN, POSTCODE);
    expect(held).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Daten übermittelt.', last_update: null, summary_only: true, events: [] });
    // The page shows the first step whatever the status says, as long as no scan is shown.
    expect(parseIdsReply(edited('not-found', (shipment) => { (shipment.header as Row).id = 7; shipment.status = 6; }), UNKNOWN, POSTCODE))
      .toMatchObject({ current_stage: 'registered', summary_only: true });
    // Scans the page hides still show the shipment exists.
    expect(parseIdsReply(edited('not-found', (shipment) => { shipment.history = [{ depotId: '0001', time: '2026-03-23 15:42:10.000000', code: 'XX', mp: '' }]; }),
      UNKNOWN, POSTCODE)).toMatchObject({ current_stage: 'registered', last_status_text: 'Daten übermittelt.', summary_only: true });
    const settled = parseIdsReply(edited('in-transit', (shipment) => { shipment.status = '6'; }), MOVING, POSTCODE);
    expect(settled).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Ihre Sendung ist im Zustelldepot eingetroffen und wird für die Zustellung vorbereitet.' });
    expect(settled).not.toHaveProperty('delivered_at');
    expect(parseIdsReply(edited('in-transit', (shipment) => { shipment.status = 9; }), MOVING, POSTCODE)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads the lookup’s empty record as not found, unless the page’s maintenance flag is up', async () => {
    expect(() => parseIdsReply(fixture('not-found'), UNKNOWN, POSTCODE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = () => reply(text('not-found'));
    const quiet = site(empty);
    await expect(lookup(quiet, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(quiet.mock.calls.map(([url]) => String(url))).toEqual([IDS_STATUS_API, IDS_MAINTENANCE_API]);
    await expect(lookup(site(empty, { maintenance: () => reply('{"text":"Synthetic notice","active":true}') }), UNKNOWN))
      .rejects.toMatchObject({ kind: 'maintenance' });
    // A flag that cannot be read leaves the answer.
    await expect(lookup(site(empty, { maintenance: () => reply('', 500) }), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(site(empty, { maintenance: () => reply('<html></html>', 200, 'text/html') }), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // An error the lookup reports, or an empty list, is no answer about the shipment.
    expect(() => parseIdsReply(edited('not-found', (shipment) => { shipment.errors = ['synthetic']; }), UNKNOWN, POSTCODE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIdsReply(edited('not-found', (_shipment, payload) => { payload.result = []; }), UNKNOWN, POSTCODE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the reply to the whole number and postcode asked', () => {
    expect(() => parseIdsReply(fixture('delivered'), MOVING, POSTCODE)).toThrow(expect.objectContaining({ kind: 'schema', message: 'IDS Logistik answered for another shipment' }));
    expect(() => parseIdsReply(edited('delivered', (shipment) => { shipment.shipmentId = MOVING; }), DELIVERED, POSTCODE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseIdsReply(edited('delivered', (_shipment, payload) => { payload.zipCode = '00009'; }), DELIVERED, POSTCODE))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'IDS Logistik answered for another postcode' }));
    expect(() => parseIdsReply(edited('delivered', (_shipment, payload) => { delete payload.trackingNumber; }), DELIVERED, POSTCODE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // A number echoed as a JSON number, and a reply without its postcode or shipment id, still bind.
    expect(parseIdsReply(edited('delivered', (shipment, payload) => {
      payload.trackingNumber = 9000000000000001; delete payload.zipCode; shipment.shipmentId = null;
    }), DELIVERED, POSTCODE).events).toHaveLength(8);
  });

  it('rejects changed replies', () => {
    expect(() => parseIdsReply(['record'], DELIVERED, POSTCODE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (shipment: Row) => { shipment.history = {}; },
      (shipment: Row) => { shipment.history = Array.from({ length: 501 }, () => ({ time: '2026-03-23 15:42:10' })); },
      (shipment: Row) => { shipment.header = null; },
      (shipment: Row) => { shipment.errors = 'synthetic'; },
      (shipment: Row) => { shipment.status = 'delivered'; },
      (shipment: Row) => { shipment.status = 2.5; },
      (shipment: Row) => { (shipment.header as Row).start = 'Synthetic'; },
      (shipment: Row) => { (shipment.header as Row).bordered = 1774864800; },
      (shipment: Row) => { (shipment.history as Row[])[0] = 'scan' as unknown as Row; },
      (shipment: Row) => { (shipment.history as Row[])[0]!.time = null; },
      (shipment: Row) => { (shipment.history as Row[])[0]!.time = '23.03.2026 15:42'; },
      (shipment: Row) => { (shipment.history as Row[])[0]!.time = '2026-02-30 15:42:10'; },
      (shipment: Row) => { (shipment.history as Row[])[0]!.time = '2026-03-23 24:00:00'; },
      (shipment: Row) => { (shipment.history as Row[])[0]!.time = '2026-03-23T15:42:10+25:00'; },
      (shipment: Row) => { (shipment.history as Row[])[0]!.code = { id: '27' }; },
      (shipment: Row) => { (shipment.history as Row[])[0]!.mp = -2; },
    ]) {
      expect(() => parseIdsReply(edited('delivered', change), DELIVERED, POSTCODE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseIdsPartners({ partner: {} })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect([...parseIdsPartners({ partner: [{ depot: '0004, 0005', city: ' Synthetic  Town ' }, 'row'] })]).toEqual([['0004', 'Synthetic Town'], ['0005', 'Synthetic Town']]);
  });

  it('keeps a browser check, a moved route and a broken reply apart from a missing shipment', async () => {
    await expect(lookup(site(() => reply(CHECK, 200, 'text/html')))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => reply(CHECK, 403, 'text/html')))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => reply('<html><title>IDS Logistik</title></html>', 200, 'text/html')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(site(() => reply('')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(site(() => new Response(null, { status: 302, headers: { Location: 'https://www.ids-logistik.de/' } }))))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('answers without towns when the partner list cannot be read, and reads it again next time', async () => {
    const fetcher = site(() => reply(text('delivered')), { partners: () => reply('', 500) });
    const tracker = carrier(fetcher);
    const result = await tracker.track({ number: DELIVERED, postcode: POSTCODE });
    expect(result.events).toHaveLength(8);
    expect(result.events!.every((event) => !('location' in event))).toBe(true);
    await tracker.track({ number: DELIVERED, postcode: POSTCODE });
    expect(fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url === IDS_PARTNERS_API)).toHaveLength(2);
  });

  it('takes 13 to 16 digits and the recipient’s postcode, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['900000000000', '90000000000000001', '900000000000A', 'ABCD00000000001']) {
      await expect(lookup(fetcher, number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    await expect(carrier(fetcher).track({ number: DELIVERED, postcode: '  ' })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(carrier(fetcher).track({ number: DELIVERED, postcode: 'ABC' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeIdsNumber('9000.0000.0000.0001')).toBe(DELIVERED);
    expect(normalizeIdsNumber('9000000000002')).toBe('9000000000002');
    // The page's form drops a hyphen; letters and spaces stay.
    expect(normalizeIdsPostcode('l-1234')).toBe('L1234');
    expect(normalizeIdsPostcode(' 1234  ab ')).toBe('1234 AB');
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = site(() => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(lookup(fetcher)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)('keeps HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = site(() => reply('{}', status));
    await expect(lookup(fetcher)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = site(() => reply(text('delivered')));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(lookup(flaky)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url]) => String(url))).toEqual([IDS_STATUS_API, IDS_STATUS_API, IDS_PARTNERS_API]);
    const immediate = site(() => reply(text('delivered')));
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
    await expect(lookup(site(() => new Response(new Uint8Array(300_000))))).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under IDS with its postcode to the adapter, and reads only the number from a tracking link', async () => {
    const fetcher = site(() => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'ids-logistik', postcode: POSTCODE }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ids-logistik', source: 'ids-logistik', result: { current_stage: 'delivered' } });
    expect(parseTrackingInput(`https://www.ids-logistik.de/de/sendungsverfolgung?trackingNumber=${DELIVERED}&zipCode=${POSTCODE}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'ids-logistik', source: 'link' });
  });

  it('is not claimed or asked by number alone: its lengths are shared and every lookup needs the postcode', () => {
    for (const number of [DELIVERED, '9000000000002']) {
      expect(detectCarrierMatch(number).carrier).not.toBe('ids-logistik');
      expect(recognitionAskedCarriers(number)).not.toContain('ids-logistik');
    }
    expect(carrier(vi.fn<typeof fetch>())).not.toHaveProperty('recognize');
  });
});

type Entry = { code?: string; wording: string; stage?: string; confirmedBy: string };

describe('IDS Logistik status vocabulary', () => {
  it('maps every code and wording the page shows to the stage recorded for it', () => {
    for (const entry of (statuses.entries as Entry[]).filter((item) => item.confirmedBy === 'bundle')) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(entry.code ?? null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ids-logistik', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Every sentence the adapter writes is recorded.
    const recorded = new Set((statuses.entries as Entry[]).map((entry) => normalizeStatusWording(entry.wording)));
    for (const name of ['delivered', 'in-transit']) {
      for (const event of parseIdsReply(fixture(name), name === 'delivered' ? DELIVERED : MOVING, POSTCODE).events!) {
        expect(recorded.has(normalizeStatusWording(event.description!)), event.description).toBe(true);
      }
    }
    expect(idsMappedStage('99', 'Synthetic status')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'ids-logistik', providerCode: null, description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
  });
});
