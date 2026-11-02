import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { dateLocalClocks } from '../../places/index.js';
import { adapter, FIC_TRACKER, FicTracker } from './adapter.js';
import { normalizeFicNumber, parseFic } from './parser.js';
import { ficStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZZ0000GB00000000017';
const TRANSIT = 'ZZZ0000US00000000025';
const UNKNOWN = 'ZZZ0000GB00000000033';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const schema = expect.objectContaining({ kind: 'schema' });

describe('FedEx International Connect HTTP adapter', () => {
  it('asks the tracker for the whole number in capitals through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FicTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzz0000gb 00000000017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(`${FIC_TRACKER}?MyFICNumber=${DELIVERED}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fedex-international-connect', step: 'direct', outcome: 'ok' }));
  });

  it('reads the wall clocks, the partner the tracker’s button opens, and none of the shipper’s reference or local number', () => {
    const result = parseFic(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-03-03T13:05:00', service_name: 'FIC - Tracked',
      weight_kg: 1.25, destination_country: 'GB', delivery_carrier: 'royal-mail', delivery_tracking_number: 'OJ000000014GB' });
    expect(result).not.toHaveProperty('delivered_at');
    // The depot scan listed twice is one scan.
    expect(result.events!.map((event) => [event.local_time, event.provider_code ?? null, event.stage, event.location ?? null])).toEqual([
      ['2026-03-03T13:05:00', null, 'delivered', null],
      ['2026-03-03T07:40:00', '340', 'out_for_delivery', null],
      ['2026-03-02T21:15:00', '210', 'in_transit', null],
      ['2026-02-27T18:02:11', '222', 'in_transit', 'BASILDON, GB'],
      ['2026-02-27T09:31:45', '217', 'in_transit', 'BASILDON, GB'],
      ['2026-02-26T23:10:02', '198', 'accepted', 'BASILDON, GB'],
      ['2026-02-26T16:00:00', '218', 'accepted', null],
      ['2026-02-25T10:12:30', '218', 'registered', null],
    ]);
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/REF-PRIVATE|LOCAL0000000PRIVATE|Total Pieces/);
  });

  it('dates the scans on the zone of their place or leg', () => {
    const dated = dateLocalClocks('fedex-international-connect', parseFic(page('in-transit'), TRANSIT));
    expect(dated.events!.map((event) => [event.time_zone, event.time_zone_basis])).toEqual([
      ['Asia/Seoul', 'place'],
      ['America/New_York', 'place'],
      ['America/New_York', 'place'],
      ['America/New_York', 'place'],
      ['America/New_York', 'neighbour'],
      ['America/New_York', 'neighbour'],
    ]);
  });

  it('reads the partner\'s scans without a place on the destination\'s clock, and FIC\'s own on their place\'s', () => {
    const handover = "<tr  valign=top>\n\t<td>27th Feb 2026 12:20:00</td>\n\t<td><span class='description'>RECEIVED BY PARTNER CARRIER</span></td>\n"
      + '\t<td>212</td>\n\t<td></td>\n</tr>\n';
    const value = (destination: string) => page('delivered').replaceAll('<td nowrap>UNITED KINGDOM</td>', `<td nowrap>${destination}</td>`)
      .replace('<tr  valign=top>\n\t<td>27th Feb 2026 09:31:45</td>', `${handover}<tr  valign=top>\n\t<td>27th Feb 2026 09:31:45</td>`);
    const result = parseFic(value('HUNGARY'), DELIVERED);
    expect(result.last_update).toBe('2026-03-03T13:05:00+01:00');
    expect(dateLocalClocks('fedex-international-connect', result).events!.map((event) => [event.time, event.time_zone_basis])).toEqual([
      ['2026-03-03T13:05:00+01:00', 'destination'],
      ['2026-03-03T07:40:00+01:00', 'destination'],
      ['2026-03-02T21:15:00+01:00', 'destination'],
      ['2026-02-27T18:02:11+00:00', 'place'],
      ['2026-02-27T12:20:00+01:00', 'destination'],
      ['2026-02-27T09:31:45+00:00', 'place'],
      ['2026-02-26T23:10:02+00:00', 'place'],
      ['2026-02-26T16:00:00+00:00', 'neighbour'],
      ['2026-02-25T10:12:30+00:00', 'neighbour'],
    ]);
    // A destination on several clocks leaves them to the scans around them.
    expect(parseFic(value('UNITED STATES'), DELIVERED).events!.every((event) => !('time' in event))).toBe(true);
  });

  it('names no partner for a button to another site or another number', () => {
    const result = parseFic(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', destination_country: 'KR', weight_kg: 0.4 });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const delivered = page('delivered');
    for (const changed of [
      delivered.replaceAll('tracking-results\\/OJ000000014GB', 'tracking-results\\/OJ000000028GB'),
      delivered.replaceAll('https:\\/\\/www.royalmail.com\\/track-your-item#\\/tracking-results\\/', 'https:\\/\\/www.example.com\\/track?id='),
      delivered.replaceAll("window.open('https:", "window.open('not a link:"),
      delivered.replaceAll('<th nowrap>Tracking Number:</th><td nowrap>OJ000000014GB</td>', '<th nowrap>Tracking Number:</th><td nowrap></td>'),
    ]) {
      const other = parseFic(changed, DELIVERED);
      expect(other).toMatchObject({ status: 'delivered' });
      expect(other).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads the no-record page as not found, and any other page as a schema failure', async () => {
    expect(() => parseFic(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const delivered = page('delivered');
    const second = delivered.slice(delivered.indexOf("<div class='BodyBlock'>"), delivered.indexOf("<div id='Footer'>"));
    for (const value of [
      page('not-found').replace(UNKNOWN, DELIVERED).replace('Sorry we have no record', 'Please try again'),
      page('not-found'),
      delivered.replace(`<td nowrap>${DELIVERED}</td>\n\t<th nowrap>Shippers Ref`, '<td nowrap>ZZZ0000GB00000000041</td>\n\t<th nowrap>Shippers Ref'),
      delivered.replace("</div>\n<div id='Footer'>", `${second}</div>\n<div id='Footer'>`),
      delivered.replace('3rd Mar 2026 13:05:00', '31st Feb 2026 13:05:00'),
      delivered.replace('<td>340</td>', '<td>OUT</td>'),
      delivered.replace("<td><span class='description'>SITE SCAN</span></td>", ''),
      '<html><body>Service unavailable</body></html>',
    ]) expect(() => parseFic(value, DELIVERED)).toThrow(schema);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads a parcel with an empty history as one with no scans yet', () => {
    const delivered = page('delivered');
    const empty = delivered.replace(/<tr [^>]*valign=top>\n\t<td>[\s\S]*?<\/tr>\n/g, '');
    expect(() => parseFic(empty, DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('leaves wording it has not recorded without a stage', () => {
    const value = page('delivered').replace('>DELIVERED<', '>DELIVERY EXCEPTION<').replace('>LABEL CREATED<', '>LABEL VOIDED<');
    const result = parseFic(value, DELIVERED);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'DELIVERY EXCEPTION' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(ficStage('218', 'LABEL VOIDED')).toBeNull();
    expect(ficStage('222', 'DEPARTED Example Shop')).toBeNull();
    expect(ficStage(null, 'OUT FOR DELIVERY')).toBeNull();
  });

  it('refuses numbers outside FIC’s layout without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZZ0000GB0000000001', 'ZZ00000GB00000000017', 'OJ000000014GB', `ZZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFicNumber('zzz-0000-gb-00000000017')).toBe(DELIVERED);
  });

  it('sends a read that fails to connect once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(html(page('in-transit')));
    await expect(carrier(flaky).track({ number: TRANSIT })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('answers through the facade with deduced zones when the partner does not answer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(FIC_TRACKER)
      ? html(page('delivered')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'fedex-international-connect' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'fedex-international-connect', source: 'fedex-international-connect', result: { current_stage: 'delivered' } });
    expect(answer.result.events.find((event) => event.location === 'BASILDON, GB')).toMatchObject({ time_zone: 'Europe/London', time_zone_basis: 'place' });
  });
});

describe('FedEx International Connect status vocabulary', () => {
  it('maps every scan it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && entry.code ? entry.code : null;
      const wording = entry.wording.replace('<shipper>', 'Example Shop');
      expect(statusMap.stage(code, wording), wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'fedex-international-connect', providerCode: code, description: wording }), wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'fedex-international-connect', providerCode: '999', description: 'Sample Status' })).toEqual({ kind: 'unknown' });
  });
});
