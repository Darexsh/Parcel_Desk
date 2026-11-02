import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SeflTracker, seflTracingUrl } from './adapter.js';
import { normalizeSeflNumber, parseSefl, seflWording } from './parser.js';
import { seflStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9100007';
const IN_TRANSIT = '910000009';
const UNKNOWN = '999999999';
// The shipper and consignee, their ZIP codes and the service centers', the signer, the phones and the appointment's hours.
const PRIVATE = /SHIPPERVILLE|CONSIGNEETON|SAMPLE SIGNER|Signed By|Recvd|\b\d{5}\b|1\(000\)|\b(?:SMC|HBT|DSC)\b|08:00 AM|05:00 PM/;
// Cloudflare's browser check, as it stands in for a reply.
const CHALLENGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>'
  + '<script>window._cf_chl_opt={cvId: \'3\'};</script></body></html>';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
/** A fixture with its first match of `from` replaced. */
const edited = (name: string, ...changes: [string | RegExp, string][]) =>
  changes.reduce((xml, [from, to]) => xml.replace(from, to), fixture(name));
const row = (fields: Record<string, string>) => `<detail>${Object.entries({
  date: '10/13/2026', time: '11:30 AM', utcOffset: '-05:00', location: 'HUB TOWN', city: 'HUBVILLE', state: 'TN', zip: '00005',
  message: 'Synthetic note', statusCode: 'ZZZ', ...fields,
}).map(([name, value]) => `<${name}>${value}</${name}>`).join('')}</detail>`;
/** The in-transit reply with a newer scan after its last. */
const withScan = (fields: Record<string, string>) => edited('in-transit', ['</detailInformation>', `${row(fields)}</detailInformation>`]);
const reply = (body: string | Uint8Array<ArrayBuffer>, init?: ResponseInit) => vi.fn<typeof fetch>().mockImplementation(async () => new Response(body, init));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Southeastern Freight Lines Web Connect tracing', () => {
  it('asks the tracing service for the PRO in XML, through the supplied transport', async () => {
    const fetcher = reply(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SeflTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 910-000-009 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`https://www.sefl.com/webconnect/tracing?Type=PN&RefNum1=${IN_TRANSIT}&output=XML`);
    expect(seflTracingUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/xml' } });
    expect(init.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'southeastern-freight-lines', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s clock with its service center’s offset, and the appointment’s day as the estimate', () => {
    const result = parseSefl(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Closed Trailer SOR530004 to HUB TOWN service center Hold for Appointment',
      last_update: '2026-10-13T10:02:00-05:00', expected_delivery: '2026-10-15', weight_kg: 172.365 });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.time, event.stage, event.provider_code, event.location])).toEqual([
      ['2026-10-13T10:02:00-05:00', 'in_transit', 'LOD', 'HUBVILLE, TN'],
      ['2026-10-13T03:58:00-05:00', 'in_transit', 'LOD', 'HUBVILLE, TN'],
      ['2026-10-12T23:50:00-04:00', 'in_transit', 'DIS', 'SAMPLE CITY, SC'],
      ['2026-10-12T20:15:00-04:00', 'in_transit', 'CFD', 'SAMPLE CITY, SC'],
      // The wording, not its code, tells the pickup from an arrival.
      ['2026-10-12T16:05:00-04:00', 'accepted', 'LOD', 'SAMPLE CITY, SC'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('keeps the delivery and the repeated scan once, without the signer, the people or their addresses', () => {
    const result = parseSefl(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-07-08T10:42:00-05:00', delivered_at: '2026-07-08T10:42:00-05:00',
      expected_delivery: null, weight_kg: 566.99 });
    expect(result.events!.map((event) => [event.time, event.stage, event.provider_code])).toEqual([
      ['2026-07-08T10:42:00-05:00', 'delivered', 'DLV'],
      ['2026-07-08T06:30:00-05:00', 'out_for_delivery', 'CDY'],
      ['2026-07-07T07:55:00-05:00', 'in_transit', 'LOD'],
      ['2026-07-07T04:10:00-05:00', 'in_transit', 'DIS'],
      ['2026-07-07T03:45:00-05:00', 'in_transit', 'CFD'],
      ['2026-07-07T00:20:00-05:00', 'in_transit', 'LOD'],
      // The origin's service center keeps its own zone.
      ['2026-07-06T21:05:00-04:00', 'in_transit', 'DIS'],
      ['2026-07-06T18:40:00-04:00', 'in_transit', 'CFD'],
      ['2026-07-06T15:10:00-04:00', 'accepted', 'SPU'],
    ]);
    expect(result.events![6]).toMatchObject({ description: 'Dispatched Trailer 280001F ETA: 07/07/2026 01:30 AM', location: 'SAMPLE CITY, GA' });
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    expect(seflWording('Delivered - Signed By: SAMPLE SIGNER')).toBe('Delivered');
    expect(seflWording('Delivered, Recvd by: SAMPLE SIGNER')).toBe('Delivered');
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'southeastern-freight-lines', steps: ['direct', 'retry'], recognition: { rank: 919 },
      localClocks: true });
  });

  it('takes the location’s word for a delivery, and the newest scan’s for a more precise stage', () => {
    // A delivery the history does not show yet.
    expect(parseSefl(edited('in-transit', ['At destination: HUB TOWN', 'Delivered to Customer']), IN_TRANSIT)).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered to Customer',
      expected_delivery: null });
    expect(parseSefl(edited('in-transit', ['At destination: HUB TOWN', 'Delivered to Customer']), IN_TRANSIT)).not.toHaveProperty('delivered_at');
    expect(parseSefl(withScan({ message: 'Out for Delivery on Trailer 530005', statusCode: 'CDY' }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery on Trailer 530005', expected_delivery: '2026-10-15' });
    // A wording the map does not know falls to its code, then to the shared wording rules.
    expect(parseSefl(withScan({ statusCode: 'OSD' }), IN_TRANSIT)).toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map' });
    const unknown = parseSefl(withScan({}), IN_TRANSIT);
    expect(unknown.events![0]).toEqual({ time: '2026-10-13T11:30:00-05:00', location: 'HUBVILLE, TN', description: 'Synthetic note',
      provider_code: 'ZZZ' });
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note', last_update: '2026-10-13T11:30:00-05:00' });
    expect(parseSefl(withScan({ message: 'Delivered to the sample dock' }), IN_TRANSIT).events![0])
      .toMatchObject({ stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) });
    // A voided record says nothing, whatever its wording.
    expect(parseSefl(withScan({ message: 'Shipment delivered', statusCode: 'VOD' }), IN_TRANSIT).events![0]).not.toHaveProperty('stage');
    // Without a history, the location alone.
    const summaryOnly = edited('in-transit', [/<detailInformation>[\s\S]*<\/detailInformation>/, '<detailInformation></detailInformation>']);
    expect(parseSefl(summaryOnly, IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'At destination: HUB TOWN', last_update: null, summary_only: true, events: [], expected_delivery: '2026-10-15' });
    expect(() => parseSefl(summaryOnly.replace('At destination: HUB TOWN', 'Synthetic place'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // A reply without the history's element reads the same.
    expect(parseSefl(summaryOnly.replace('<detailInformation></detailInformation>', ''), IN_TRANSIT)).toMatchObject({ summary_only: true });
  });

  it('keeps a clock without an offset as a wall clock, and drops a stale estimate and a weight it cannot read', () => {
    const wall = parseSefl(withScan({ utcOffset: '' }), IN_TRANSIT);
    expect(wall).toMatchObject({ last_update: null, last_update_local: '2026-10-13T11:30:00' });
    expect(wall.events![0]).toMatchObject({ local_time: '2026-10-13T11:30:00' });
    expect(wall.events![0]).not.toHaveProperty('time');
    expect(parseSefl(withScan({ time: '' }), IN_TRANSIT).events![0]).toMatchObject({ local_time: '2026-10-13' });
    // Without an appointment, the committed day; a day before the newest scan's is no estimate.
    const committed = edited('in-transit', [/<status>[^<]*<\/status>/, '<status></status>']);
    expect(parseSefl(committed, IN_TRANSIT)).toMatchObject({ expected_delivery: '2026-10-14' });
    expect(parseSefl(committed.replace('<committedDate>10/14/2026', '<committedDate>10/12/2026'), IN_TRANSIT))
      .toMatchObject({ expected_delivery: null });
    expect(parseSefl(committed.replace('<committedDate>10/14/2026', '<committedDate>'), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    for (const weight of ['0', 'heavy', '-5', '']) {
      expect(parseSefl(edited('in-transit', ['<weight>380', `<weight>${weight}`]), IN_TRANSIT), weight).not.toHaveProperty('weight_kg');
    }
    // A town without a state, and a service center without a town.
    expect(parseSefl(withScan({ state: '' }), IN_TRANSIT).events![0]).toMatchObject({ location: 'HUBVILLE' });
    expect(parseSefl(withScan({ city: '', state: '' }), IN_TRANSIT).events![0]).toMatchObject({ location: 'HUB TOWN' });
    expect(parseSefl(withScan({ city: '', state: '', location: '' }), IN_TRANSIT).events![0]).not.toHaveProperty('location');
  });

  it('reads the service’s notice for the PRO asked as not found, and other errors as inconclusive', () => {
    expect(() => parseSefl(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSefl(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Southeastern Freight Lines answered for another PRO' }));
    expect(() => parseSefl('<root><error>Service unavailable</error></root>', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSefl('<root><error></error></root>', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when it names the PRO asked', () => {
    expect(() => parseSefl(fixture('in-transit'), '910000017'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Southeastern Freight Lines answered for another shipment' }));
    const shipment = (name: string) => /<pro>[\s\S]*<\/pro>/.exec(fixture(name))![0];
    const both = `<root>${shipment('delivered')}${shipment('in-transit')}</root>`;
    expect(parseSefl(both, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    expect(parseSefl(both, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseSefl(`<root>${shipment('in-transit')}${shipment('in-transit')}</root>`, IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const [name, xml] of [
      ['not XML', 'Synthetic text'],
      ['another document', '<html><body>Synthetic</body></html>'],
      ['empty root', '<root></root>'],
      ['another element', '<root><shipment/></root>'],
      ['error beside a shipment', fixture('in-transit').replace('<root>', '<root><error>Synthetic</error>')],
      ['error with elements', '<root><error><b>Synthetic</b></error></root>'],
      ['no PRO', edited('in-transit', [/<proNumber>\d+<\/proNumber>/, ''])],
      ['two histories', edited('in-transit', ['</pro>', '<detailInformation></detailInformation></pro>'])],
      ['other rows', edited('in-transit', ['<detailInformation>', '<detailInformation><scan/>'])],
      ['ISO date', withScan({ date: '2026-10-13' })],
      ['impossible date', withScan({ date: '02/30/2026' })],
      ['no date', withScan({ date: '' })],
      ['24-hour time', withScan({ time: '16:05' })],
      ['hour 13', withScan({ time: '13:05 PM' })],
      ['zone name', withScan({ utcOffset: 'CDT' })],
      ['impossible offset', withScan({ utcOffset: '-25:00' })],
      ['empty message', withScan({ message: ' ' })],
      ['signer only', withScan({ message: 'Signed By: SAMPLE SIGNER' })],
      ['repeated field', withScan({ message: 'Synthetic note</message><message>Another note' })],
      ['nested field', withScan({ message: '<b>Synthetic note</b>' })],
      ['too many rows', edited('in-transit', ['</detailInformation>', `${row({}).repeat(300)}</detailInformation>`])],
    ] as const) {
      expect(() => parseSefl(xml, IN_TRANSIT), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A long history keeps its hundred newest scans.
    const rows = Array.from({ length: 120 }, (_, index) => row({ time: `${String(index % 12 + 1).padStart(2, '0')}:${String(index % 60).padStart(2, '0')} AM`,
      message: `Synthetic note ${index}` })).join('');
    const long = parseSefl(edited('in-transit', ['</detailInformation>', `${rows}</detailInformation>`]), IN_TRANSIT);
    expect(long).toMatchObject({ history_truncated: true });
    expect(long.events).toHaveLength(100);
  });

  it('reads a browser check as a challenge, with HTTP 200 or 403', async () => {
    expect(() => parseSefl(CHALLENGE, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(new SeflTracker({ fetcher: reply(CHALLENGE) }).fetch(IN_TRANSIT)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(new SeflTracker({ fetcher: reply(CHALLENGE, { status: 403 }) }).fetch(IN_TRANSIT)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('decodes the reply as windows-1252', async () => {
    const xml = fixture('in-transit').replace('Hold for Appointment', 'Consignee\u0092s dock closed');
    const bytes = Uint8Array.from(xml, (character) => character.charCodeAt(0));
    const result = await new SeflTracker({ fetcher: reply(bytes) }).fetch(IN_TRANSIT);
    expect(result.events![0]!.description).toBe('Closed Trailer SOR530004 to HUB TOWN service center Consignee’s dock closed');
  });

  it('keeps a moved service apart from a missing shipment', async () => {
    for (const status of [301, 302, 307, 404, 410]) {
      const moved = reply('', { status, headers: { Location: '/' } });
      await expect(new SeflTracker({ fetcher: moved }).fetch(IN_TRANSIT), String(status)).rejects.toMatchObject({ kind: 'transport' });
      expect(moved).toHaveBeenCalledOnce();
    }
    await expect(new SeflTracker({ fetcher: reply(fixture('not-found')) }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = reply('', { status });
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known PRO and the unknown-PRO notice, and asks nothing for a number SEFL does not issue', async () => {
    await expect(carrier(reply(fixture('delivered'))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-07-08T15:42:00.000Z' });
    await expect(carrier(reply(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('91000071')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => new Response(fixture('delivered')));
    await expect(new SeflTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    // Other lengths, letters, a terminal code, two PROs and an oversized paste.
    for (const number of ['91000071', '910000', '9100000091', 'PRO9100007', '910-00009-01', `${IN_TRANSIT};${DELIVERED}`, '', '9'.repeat(65)]) {
      await expect(new SeflTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new SeflTracker({ fetcher: unused }).fetch(IN_TRANSIT, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    expect(normalizeSeflNumber(' 910 000.009 ')).toBe(IN_TRANSIT);
    // The service keeps a leading zero.
    expect(normalizeSeflNumber('0100007')).toBe('0100007');
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new SeflTracker({ fetcher: hanging }).fetch(IN_TRANSIT, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    const huge = reply('x'.repeat(300_000));
    await expect(new SeflTracker({ fetcher: huge }).fetch(IN_TRANSIT)).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under Southeastern Freight Lines to the adapter', async () => {
    const fetcher = reply(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'southeastern-freight-lines' }, { budgetMs: 3000 })).resolves.toMatchObject({
      carrier: 'southeastern-freight-lines', source: 'southeastern-freight-lines', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === seflTracingUrl(DELIVERED))).toBe(true);
  });
});

describe('Southeastern Freight Lines status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const wording = normalizeStatusWording(entry.wording);
      const label = `${entry.code ?? ''} ${entry.wording}`;
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code ?? null, wording), label).toBeUndefined();
        expect(seflStage(entry.code ?? '', entry.wording), label).toBeNull();
        expect(statusMapAnswer({ carrier: 'southeastern-freight-lines', providerCode: entry.code ?? null, description: entry.wording }), label)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, wording), label).toBe(entry.stage);
      expect(seflStage(entry.code ?? '', entry.wording), label).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'southeastern-freight-lines', providerCode: 'LOD', description: 'Arrive Trailer 280009F' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'southeastern-freight-lines', providerCode: 'ZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'southeastern-freight-lines', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // The wording decides before the code.
    expect(statusMap.stage('LOD', 'shipment pickup using trailer 530009')).toBe('accepted');
    expect(statusMap.stage('dlv', 'synthetic note')).toBe('delivered');
    expect(seflStage('ZZZ', 'Synthetic note')).toBeNull();
  });
});
