import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DOHRN_TRACE, DohrnTracker } from './adapter.js';
import { normalizeDohrnNumber, parseDohrn } from './parser.js';
import { dohrnMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '61234570';
const IN_TRANSIT = '7012345678';
const UNKNOWN = '51230009';
const QUOTE = '9012300004';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
const reply = (body: string | Uint8Array<ArrayBuffer>, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/xml' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseDohrn>) =>
  result.events!.map(event => [event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The references, parties, terminals, ZIP codes, delivery clock and the signer.
const PRIVATE = /55501|PO-7700|9010000001|BOL-0042|60000|53000|SMP|EXV|FCV|SPF|SIGNER|Signed|14:20|DOK|Manifested|En-route|LAST @/i;

describe('Dohrn Transfer tracking adapter', () => {
  it('asks the XML trace once for the whole PRO through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DohrnTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 4)}-${DELIVERED.slice(4)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://facts.dohrn.com/scripts/cgiip.exe/protracexml.htm?pronum=${DELIVERED}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/xml' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dohrn-transfer', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the history newest first, as wall clocks, without the rows the tracking page hides or anything private', () => {
    const result = parseDohrn(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-11T14:31:00', expected_delivery: null, weight_kg: 453.592 });
    expect(rows(result)).toEqual([
      ['2026-03-11T14:31:00', 'Exampleville, WI', 'Delivered', 'delivered'],
      ['2026-03-11T07:45:00', 'Testburg, WI', 'Out For Delivery', 'out_for_delivery'],
      ['2026-03-10T15:10:00', 'Exampleville, WI', 'Attempted - No Frt On Truck', 'failed_attempt'],
      ['2026-03-10T08:02:00', 'Testburg, WI', 'Out For Delivery', 'out_for_delivery'],
      // Remarks that name no place leave the row without one.
      ['2026-03-10T06:15:00', null, 'Appointment Set: 03/10/26', 'in_transit'],
      // Repeated rows appear once.
      ['2026-03-10T05:20:00', null, 'Trailer Arrived', 'in_transit'],
      ['2026-03-09T23:40:00', 'Midtown, IL', 'Trailer Departed For Testburg, Wi', 'in_transit'],
      ['2026-03-09T21:05:00', 'Midtown, IL', 'Loaded On Trailer', 'in_transit'],
      ['2026-03-09T19:30:00', 'Midtown, IL', 'Freight Unloaded', 'in_transit'],
      ['2026-03-09T16:12:00', 'Sampleton, IL', 'Picked Up', 'accepted'],
      ['2026-03-09T09:03:00', null, 'Pickup Request Received', 'registered'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    for (const field of ['summary_only', 'delivered_at', 'sender_name', 'receiver_name', 'provider_code']) expect(result).not.toHaveProperty(field);
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseDohrn(fixture(name), number)), name).not.toMatch(PRIVATE);
    }
    // A list the other way round is turned round.
    const body = fixture('delivered');
    const list = /<shiphists>([\s\S]*)<\/shiphists>/.exec(body)![1]!;
    const listed = list.split('</shiphist>').slice(0, -1).map(row => `${row}</shiphist>`);
    expect(parseDohrn(body.replace(list, [...listed].reverse().join('')), DELIVERED).events).toEqual(result.events);
  });

  it('follows the newest row of a shipment on its way and keeps its estimate', () => {
    const result = parseDohrn(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Trailer Departed For Sample Falls, Mn', last_update_local: '2026-11-03T02:10:00',
      expected_delivery: '2026-11-05', weight_kg: 113.398 });
    expect(rows(result)).toEqual([
      ['2026-11-03T02:10:00', 'Midtown, IA', 'Trailer Departed For Sample Falls, Mn', 'in_transit'],
      // A time without digits leaves the day.
      ['2026-11-02', 'Fictionville, MO', 'Scanned On Dock', 'in_transit'],
      ['2026-11-02T15:40:00', 'Fictionville, MO', 'Picked Up', 'accepted'],
    ]);
    // Without an estimate the newest appointment gives the day, unless it is past.
    const appointment = (day: string) => fixture('in-transit').replace('2026-11-05', '')
      .replace('<shiphists>', `<shiphists><shiphist><histcode>Appointment Set: ${day}</histcode><histdate>2026-11-03</histdate>`
        + '<histtime>03:00</histtime><histremarks>Delivering Terminal</histremarks></shiphist>');
    expect(parseDohrn(appointment('11/04/26'), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2026-11-04' });
    expect(parseDohrn(appointment('11/02/26'), IN_TRANSIT).expected_delivery).toBeNull();
    expect(parseDohrn(fixture('in-transit').replace('2026-11-05', '2026-11-31'), IN_TRANSIT).expected_delivery).toBeNull();
    expect(parseDohrn(fixture('in-transit').replace('<weight>250</weight>', '<weight>0</weight>'), IN_TRANSIT)).not.toHaveProperty('weight_kg');
  });

  it('lets the lifecycle settle a delivery the history has not shown yet', () => {
    const lifecycle = '<lifecycle></lifecycle>\n  <lifecyclestatuscode></lifecyclestatuscode>';
    const delivered = parseDohrn(fixture('in-transit').replace(lifecycle, '<lifecycle>Delivered</lifecycle><lifecyclestatuscode>80</lifecyclestatuscode>'), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', expected_delivery: null });
    // The older reply has no lifecycle; its delivery flag decides.
    const flagged = parseDohrn(fixture('delivered').replace(/\s*<lifecycle>.*<\/lifecyclestatuscode>/s, ''), DELIVERED);
    expect(flagged).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
    // A lifecycle the map does not know falls to the shared wording rules and settles only a final stage.
    const returned = parseDohrn(fixture('in-transit').replace(lifecycle, '<lifecycle>Returned to Shipper</lifecycle><lifecyclestatuscode>85</lifecyclestatuscode>'), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:returned' });
    const moving = parseDohrn(fixture('in-transit').replace(lifecycle, '<lifecycle>In Transit</lifecycle><lifecyclestatuscode>50</lifecyclestatuscode>'), IN_TRANSIT);
    expect(moving).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Trailer Departed For Sample Falls, Mn' });
    // Without rows, a known lifecycle is the summary.
    const summary = parseDohrn(fixture('delivered').replace(/<shiphists>[\s\S]*<\/shiphists>/, '<shiphists></shiphists>'), DELIVERED);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', summary_only: true, events: [] });
    expect(summary).not.toHaveProperty('last_update_local');
  });

  it('stages new wording through the shared rules and keeps unknown wording without a stage', () => {
    const shared = parseDohrn(fixture('in-transit').replace('<histcode>Picked Up</histcode>', '<histcode>Shipment delivered</histcode>'), IN_TRANSIT);
    expect(shared.events!.at(-1)).toMatchObject({ description: 'Shipment delivered', stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseDohrn(fixture('in-transit').replace('Trailer Departed For Sample Falls, Mn', 'Trailer Sealed'), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Trailer Sealed' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-11-03T02:10:00', location: 'Midtown, IA', description: 'Trailer Sealed' });
  });

  it('binds the reply to the requested PRO and rejects replies it cannot read', () => {
    // The trace can find a shipment by another reference; only the PRO asked counts.
    expect(() => parseDohrn(fixture('delivered'), '61234571')).toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('another shipment') }));
    expect(() => parseDohrn(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('another PRO') }));
    expect(() => parseDohrn(fixture('quote'), QUOTE)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('rate quote') }));
    const empty = fixture('in-transit').replace(/<shiphists>[\s\S]*<\/shiphists>/, '<shiphists></shiphists>');
    expect(() => parseDohrn(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    for (const xml of ['<html><body>Maintenance</body></html>', '{"status":"Delivered"}', '<protrace><pronumb>61234570</pronumb>',
      '<?xml version="1.0"?><shipment><pronumb>61234570</pronumb></shipment>',
      fixture('delivered').replace('<pronumb>61234570</pronumb>', '<pronumb></pronumb>'),
      fixture('delivered').replace('<pronumb>61234570</pronumb>', '<pronumb>61234570</pronumb><pronumb>61234570</pronumb>'),
      fixture('delivered').replace('<histdate>2026-03-11</histdate>', '<histdate>03/11/2026</histdate>'),
      fixture('delivered').replace('<histdate>2026-03-11</histdate>', '<histdate>2026-02-30</histdate>'),
      fixture('delivered').replace('<histtime>14:31</histtime>', '<histtime>24:31</histtime>'),
      fixture('delivered').replace('<histtime>14:31</histtime>', '<histtime>2:31 PM</histtime>'),
      fixture('delivered').replace('<histcode>Delivered</histcode>', '<histcode></histcode>'),
      fixture('delivered').replace('<histcode>Delivered</histcode>', '<histcode><b>Delivered</b></histcode>'),
      fixture('delivered').replace('<shiphists>', '<shiphists><note>Sample</note>'),
      fixture('not-found').replace('Invalid pronumber 51230009', 'Database unavailable'),
      fixture('not-found').replace('</errormessage>', '</errormessage><errormessage>Sample</errormessage>')]) {
      expect(() => parseDohrn(xml, DELIVERED), xml.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = fixture('delivered').replace('<shiphists>', `<shiphists>${Array.from({ length: 301 }, (_, minute) =>
      `<shiphist><histcode>Trailer Arrived</histcode><histdate>2026-03-12</histdate><histtime>${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}</histtime><histremarks></histremarks></shiphist>`).join('')}`);
    expect(() => parseDohrn(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only "Invalid pronumber" with the PRO as a missing shipment, a block page as a challenge and a WebSpeed error as inconclusive', () => {
    expect(() => parseDohrn(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDohrn(fixture('not-found').replace(` ${UNKNOWN}`, ' '), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><body><iframe src="/_Incapsula_Resource?SWUDNSAI=1"></iframe></body></html>']) {
      expect(() => parseDohrn(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(() => parseDohrn('<html><body>WebSpeed error from messenger process (6019)</body></html>', UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes PROs of eight to ten digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['6123457', '61234570123', '6123457X', 'ABCDEFGH', '01234570', '0000000000', '1Z9999999999999999', '6'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDohrnNumber('6123 4570')).toBe(DELIVERED);
    expect(normalizeDohrnNumber('701-234-5678')).toBe(IN_TRANSIT);
    expect(normalizeDohrnNumber('512300091')).toBe('512300091');
  });

  it('recognizes a PRO with history as known, an unknown one as unknown and a rate quote as inconclusive', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(known).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-11T14:31:00' });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')));
    await expect(carrier(unknown).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const quote = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('quote')));
    await expect(carrier(quote).recognize!(QUOTE)).rejects.toMatchObject({ kind: 'indeterminate' });
    const other = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(other).recognize!('61234571')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/scripts/cgiip.exe/facts.htm' } })
        : reply(status === 500 ? '' : fixture('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps empty replies and oversized ones apart from missing shipments, and reads the reply as windows-1252', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).track({ number: UNKNOWN }), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
    const latin = Uint8Array.from(fixture('in-transit').replace('Midtown, IA', 'Santé City, IA'), char => char.charCodeAt(0));
    const accented = vi.fn<typeof fetch>().mockResolvedValue(reply(latin));
    await expect(carrier(accented).track({ number: IN_TRANSIT })).resolves.toMatchObject({ events: [{ location: 'Santé City, IA' }, {}, {}] });
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a PRO filed under Dohrn to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'dohrn-transfer' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dohrn-transfer', source: 'dohrn-transfer', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${DOHRN_TRACE}?`))).toBe(true);
  });
});

describe('Dohrn Transfer numbers', () => {
  it('leaves eight to ten digits unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, '512300091']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('dohrn-transfer');
    }
  });
});

describe('Dohrn Transfer status vocabulary', () => {
  it('records every wording and lifecycle code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const code = ('code' in entry ? entry.code : undefined) ?? null;
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(stage);
      if (!code) expect(dohrnMappedStage(entry.wording), entry.wording).toBe(stage);
    }
    expect(dohrnMappedStage('  Out   FOR delivery ')).toBe('out_for_delivery');
    expect(dohrnMappedStage('Trailer Departed For Janesville, Wi')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Trailer Departed For', 'Appointment Set:', 'Picked', 'DELIVERED OK']) {
      expect(dohrnMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'dohrn-transfer', description: 'Loaded On Trailer For Delivery' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'dohrn-transfer', description: 'Manifested' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'dohrn-transfer', providerCode: '0', description: 'Quote' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
