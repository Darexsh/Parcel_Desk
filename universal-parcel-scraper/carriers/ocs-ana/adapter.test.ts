import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, ocsHistoryUrl, ocsLookupUrl, OcsTracker } from './adapter.js';
import { normalizeOcsNumber, OCS_LOOKUP, ocsRoute, ocsWording, parseOcs } from './parser.js';
import { ocsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000000004';
const EXPORT = '20000000005';
const UNKNOWN = '100000000015';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, change: (html: string) => string) => change(fixture(name));
// What the lookup answers: a refresh to OCS's history page, or to a delivery company's tracker.
const toHistory = (number: string) => `<HEAD><META HTTP-EQUIV=refresh CONTENT="0;URL=https://webcsw.ocs.co.jp/csw/ECSWG0201R00003P.do?cwbno=${number}"></HEAD>`;
const toSagawa = (number: string) => `<HEAD><META HTTP-EQUIV=refresh CONTENT="0;URL=\thttps://k2k.sagawa-exp.co.jp/cgi-bin/mall.mmcgi?oku01=${number}"></HEAD>`;
const toYamatoIntro = (number: string, partner = number) => '<HEAD><META HTTP-EQUIV=refresh CONTENT="0;URL=intro20171204.php?'
  + `Cwbno=${number}&DCode=127&DName=%83%84%83%7D%83g&VNo=${partner}&Rdo1=ON&COUrl=http%3A%2F%2Ftoi.kuronekoyamato.co.jp%2Fcgi-bin%2Ftneko&LiPTN="></HEAD>`;
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
/** A site whose lookup and history page answer with these, anew for each request. */
const site = (lookup: () => Response, history: () => Response) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url).startsWith(OCS_LOOKUP) ? lookup() : history()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseOcs>) => result.events!.map((event) => [event.local_time, event.stage, event.location, event.description]);

describe('OCS HTTP adapter', () => {
  it('reads the English history page and asks the lookup at the same time, through the supplied transport', async () => {
    const fetcher = site(() => html(toHistory(DELIVERED)), () => html(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OcsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000-0000-0004 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([ocsHistoryUrl(DELIVERED), ocsLookupUrl(DELIVERED)].sort());
    expect(ocsLookupUrl(DELIVERED)).toBe('https://www2.ocsworldwide.net/ExpTracking/cwbCheck.php?cwbno=100000000004');
    expect(ocsHistoryUrl(DELIVERED)).toBe('https://webcsw.ocs.co.jp/csw/ECSWG0201R00003P.do?cwbno=100000000004');
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ocs-ana', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps an import’s wall clocks, its stations and the contracted delivery company’s scans, newest first', () => {
    const result = parseOcs(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered: Delivery Completed, Delivered', last_update: null, last_update_local: '2026-01-05T14:20:00',
      expected_delivery: null, weight_kg: 1.2, destination_country: 'JP' });
    expect(rows(result)).toEqual([
      ['2026-01-05T14:20:00', 'delivered', undefined, 'Delivered: Delivery Completed, Delivered'],
      ['2026-01-05T09:10:00', 'out_for_delivery', undefined, 'Status Updated by Delivery Contracted Company: Out for Delivery'],
      ['2026-01-04T19:45:00', 'in_transit', undefined, 'Status Updated by Delivery Contracted Company: In Transit'],
      ['2026-01-04T17:30:00', 'in_transit', undefined, 'Status Updated by Delivery Contracted Company: Pickup'],
      ['2026-01-04T13:15:00', 'in_transit', 'SAMPLE GATEWAY, JAPAN', 'Delivery Route Fix'],
      ['2026-01-04T13:15:00', 'in_transit', 'SAMPLE GATEWAY, JAPAN', 'Ready to Hand Over to Contracted Company'],
      ['2026-01-04T13:14:00', 'in_transit', 'SAMPLE GATEWAY, JAPAN', 'Arrived at Facility: Arrived at Service Center'],
      ['2026-01-04T12:40:00', 'in_transit', undefined, 'Released from Customs: Manifest Permission'],
      ['2026-01-04T12:40:00', 'customs', undefined, 'Importation Entry: Manifest Declaration'],
      ['2026-01-04T12:40:00', 'in_transit', 'SAMPLE GATEWAY, JAPAN', 'Arrived at Facility: Arrived at Warehouse'],
      ['2026-01-04T08:00:00', 'customs', undefined, 'Importation Entry: Manifest Declaration (Z)'],
      ['2026-01-04T01:10:00', 'in_transit', 'Example Hub Office, HONG KONG', 'In Transit'],
      ['2026-01-03T22:05:00', 'in_transit', 'TESTVILLE SVC, CHINA', 'In Transit'],
      ['2026-01-03T19:00:00', 'in_transit', 'TESTVILLE SVC, CHINA', 'Arrived at Facility: Arrived at Service Center'],
      ['2026-01-03T16:20:00', 'registered', undefined, 'Shipment Data Entry'],
      ['2026-01-03T15:55:00', 'accepted', undefined, 'Pickup'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The receiver's town and the shipper's place are not kept, nor is the slip number in the delivery memo.
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE KU|SAMPLE CITY|100000000004/);
    expect(result).not.toHaveProperty('delivery_carrier');
  });

  it('reads an export still on its way, up to its flight', () => {
    const result = parseOcs(fixture('export'), EXPORT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Flight Departure',
      last_update_local: '2026-02-11T18:30:00', weight_kg: 2.4, destination_country: 'US' });
    expect(rows(result).slice(3, 7)).toEqual([
      ['2026-02-10T10:25:00', 'in_transit', undefined, 'Export Authorization'],
      ['2026-02-10T10:25:00', 'customs', undefined, 'Export Declaration: Declaration (MEC)'],
      ['2026-02-10T10:20:00', 'in_transit', 'SAMPLE GATEWAY, JAPAN', 'Arrived at Facility: Arrived at Warehouse'],
      ['2026-02-09T21:00:00', 'customs', undefined, 'Export Declaration: Preliminary Declaration(MEC)'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ stage: 'registered',
      description: 'Shipment Information entered at customer site: EDI: International : IEC' });
    expect(JSON.stringify(result)).not.toMatch(/Exampleville|SAMPLE-SHI/);
  });

  it('names the delivery company the lookup hands the waybill to, beside OCS’s own history', async () => {
    const sagawa = await carrier(site(() => html(toSagawa(DELIVERED)), () => html(fixture('delivered')))).track({ number: DELIVERED });
    expect(sagawa).toMatchObject({ current_stage: 'delivered', delivery_carrier: 'sagawa', delivery_tracking_number: DELIVERED });
    expect(sagawa.events).toHaveLength(16);
    expect(ocsRoute(toYamatoIntro(DELIVERED, '200000000004'), DELIVERED))
      .toEqual({ delivery_carrier: 'yamato', delivery_tracking_number: '200000000004' });
    expect(ocsRoute(toYamatoIntro(DELIVERED).replaceAll('&', '&amp;'), DELIVERED))
      .toEqual({ delivery_carrier: 'yamato', delivery_tracking_number: DELIVERED });
    expect(ocsRoute(toHistory(DELIVERED).replace(/URL=[^"]+/, `URL=https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number01=${DELIVERED}`), DELIVERED))
      .toEqual({ delivery_carrier: 'yamato', delivery_tracking_number: DELIVERED });
    expect(ocsRoute(toHistory(DELIVERED), DELIVERED)).toEqual({});
  });

  it('hands over a waybill OCS’s page does not hold, when the lookup names the company and its number', async () => {
    const result = await carrier(site(() => html(toSagawa(UNKNOWN)), () => html(fixture('not-found')))).track({ number: UNKNOWN });
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Handed over to Sagawa Express', last_update: null, expected_delivery: null,
      delivery_carrier: 'sagawa', delivery_tracking_number: UNKNOWN, summary_only: true, events: [] });
    // Without a company and a number of its shape, nothing is handed over.
    for (const lookup of [
      toSagawa('12345'),
      toYamatoIntro(UNKNOWN, '10000000001'),
      toYamatoIntro(UNKNOWN).replace(/COUrl=[^&]+/, 'COUrl=https%3A%2F%2Fexample.com%2Ftrack'),
      toHistory(UNKNOWN).replace(/URL=[^"]+/, `URL=https://example.com/track?no=${UNKNOWN}`),
    ]) {
      expect(ocsRoute(lookup, UNKNOWN), lookup).toEqual({});
      await expect(carrier(site(() => html(lookup), () => html(fixture('not-found')))).track({ number: UNKNOWN }))
        .rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('asks a delivery company the lookup names for its own answer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).startsWith(OCS_LOOKUP)) return html(toSagawa(DELIVERED));
      if (String(url).startsWith('https://webcsw.ocs.co.jp/')) return html(fixture('delivered'));
      return new Response('', { status: 500 });
    });
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'ocs-ana' }, { budgetMs: 5000 });
    expect(answer).toMatchObject({ carrier: 'ocs-ana', source: 'ocs-ana', result: { current_stage: 'delivered', delivery_carrier: 'sagawa' },
      handoff: { carrier: 'sagawa', number: DELIVERED, confirmed: false } });
  });

  it('keeps an unknown waybill, a browser check and a broken page apart', async () => {
    const lookup = (history: () => Response) => carrier(site(() => html(toHistory(UNKNOWN)), history)).track({ number: UNKNOWN });
    await expect(lookup(() => html(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => html(changed('not-found', (page) => page
      .replace('No items were found for the search condition.', '条件に一致する情報がありません。'))))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => html(changed('not-found', (page) => page
      .replace('No items were found for the search condition.', 'The system is busy. Please try again later.'))))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://www.ocs.co.jp/' } }))).rejects.toMatchObject({ kind: 'transport' });
    const check = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    await expect(lookup(() => html(check))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('<html><body>OCS</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('leaves the history page’s answer without a delivery company when the lookup fails', async () => {
    const check = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    for (const failed of [
      () => html('', { status: 404 }),
      () => html('', { status: 302, headers: { Location: 'https://www.ocs.co.jp/' } }),
      () => html('', { status: 503 }),
      () => html(check),
      () => html('<html><body>OCS</body></html>'),
      // A refresh for another waybill names no company for this one.
      () => html(toHistory('100000000011')),
      () => html(toYamatoIntro('100000000011')),
      () => { throw new TypeError('fetch failed'); },
    ]) {
      const result = await carrier(site(failed, () => html(fixture('delivered')))).track({ number: DELIVERED });
      expect(result).toMatchObject({ current_stage: 'delivered' });
      expect(result).not.toHaveProperty('delivery_carrier');
      await expect(carrier(site(failed, () => html(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('waits for the lookup three seconds at most', async () => {
    const clock = fakeBudgetClock();
    const ended: Record<string, number> = {};
    const fetcher = vi.fn<typeof fetch>().mockImplementation((url, init) => new Promise<Response>((resolve, reject) => {
      const page = String(url).startsWith(OCS_LOOKUP) ? 'lookup' : 'history';
      init!.signal!.addEventListener('abort', () => { ended[page] = performance.now(); reject(init!.signal!.reason as Error); }, { once: true });
      // The lookup hangs; the history page answers after half a second.
      if (page === 'history') setTimeout(() => { ended[page] = performance.now(); resolve(html(fixture('delivered'))); }, 500);
    }));
    const started = performance.now();
    const result = await clock.settle(carrier(fetcher).track({ number: DELIVERED }));
    expect(result).toMatchObject({ current_stage: 'delivered' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect({ history: ended.history! - started, lookup: ended.lookup! - started }).toEqual({ history: 500, lookup: 3000 });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s from the history page, during retrieval and recognition', async (status, kind) => {
      const fetcher = site(() => html(toHistory(DELIVERED)), () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('counts a page only when it is about the waybill asked', async () => {
    expect(() => parseOcs(fixture('delivered'), '100000000011')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => ocsRoute(toHistory('100000000011'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => ocsRoute(toHistory(`${DELIVERED},100000000011`), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => ocsRoute(toYamatoIntro('100000000011'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The detail table names the waybill too.
    expect(() => parseOcs(changed('delivered', (page) => page.replace(/(<span id='0' \/>\s*)100000000004/, '$1100000000011')), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'OCS answered for another waybill' }));
    // Two shipments under one waybill are not one history.
    const twice = changed('delivered', (page) => page.replace(/(<!-- record start -->[\s\S]*?<!-- record end -->)/, '$1$1'));
    expect(() => parseOcs(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(site(() => html(toHistory(DELIVERED)), () => html(fixture('delivered')))).track({ number: '100000000011' }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects a changed page', () => {
    const firstScan = /(<!-- record start -->\s*<tr>\s*<td style="border-width:0px 0px 1px 0px;">[\s\S]*?<\/td>)/;
    for (const change of [
      (page: string) => page.replace('>Activity</td>', '>Event</td>'),
      (page: string) => page.replace('>Latest Tracking Record<', '>Latest<'),
      // A summary or a detail without its record.
      (page: string) => page.replace(/<!-- record start -->[\s\S]*?<!-- record end -->/, ''),
      (page: string) => page.replace(/(<span id='0' \/>\s*100000000004\s*<\/td>)[\s\S]*?<\/td>/, '$1'),
      // A scan with an extra cell, an impossible day or time, or no wording.
      (page: string) => page.replace(firstScan, '$1<td></td>'),
      (page: string) => page.replaceAll('05Jan2026', '32Jan2026'),
      (page: string) => page.replaceAll('14:20', '24:20'),
      (page: string) => page.replace(firstScan, '<!-- record start --><tr><td></td>')
        .replace('value="Delivery Completed100000000004, Delivered" style="width:230px;"', 'value="" style="width:230px;"'),
      (page: string) => page.replace('name="PCSWG0201RForm"', 'name="Other"'),
    ]) {
      expect(() => parseOcs(changed('delivered', change), DELIVERED), String(change)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => ocsRoute('<HEAD><META HTTP-EQUIV=refresh CONTENT="0;URL=https://[::1"></HEAD>', DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a scan’s wording without long digit runs or who took the shipment', () => {
    expect(ocsWording('Delivered', 'Delivery Completed100000000004, Delivered')).toBe('Delivered: Delivery Completed, Delivered');
    expect(ocsWording('Delivered', 'Delivered, received by Sample Person')).toBe('Delivered');
    expect(ocsWording('Arrived at Facility', 'Call 03-0000-0000')).toBe('Arrived at Facility: Call');
    expect(ocsWording('In Transit', 'In Transit')).toBe('In Transit');
    expect(ocsWording('', 'Memo only')).toBe('Memo only');
  });

  it('sends a read that failed to reach OCS once more, and never a reply', async () => {
    let failures = 1;
    const fetcher = site(() => html(toHistory(DELIVERED)), () => {
      if (failures-- > 0) throw new TypeError('fetch failed');
      return html(fixture('delivered'));
    });
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const answered = site(() => html(toHistory(UNKNOWN)), () => html(fixture('not-found')));
    await expect(carrier(answered).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(answered).toHaveBeenCalledTimes(2);
  });

  it('recognizes a known waybill, and asks nothing for a number OCS does not issue', async () => {
    const known = site(() => html(toHistory(DELIVERED)), () => html(fixture('delivered')));
    await expect(carrier(known).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    const missing = site(() => html(toHistory(UNKNOWN)), () => html(fixture('not-found')));
    await expect(carrier(missing).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(missing).recognize!('1000000000')).resolves.toEqual({ known: false });
    expect(known).toHaveBeenCalledTimes(2);
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers OCS does not issue, several waybills at once and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1000000000', '1000000000045', 'A0000000004', '100000000004,100000000011', '100000000004 100000000011']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeOcsNumber('2000-0000-005')).toBe(EXPORT);
  });
});

describe('OCS status vocabulary', () => {
  it('records every wording seen with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(ocsStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ocs-ana', providerCode: null, description: 'Status Updated by Delivery Contracted Company: Pickup' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'ocs-ana', providerCode: null, description: 'Pickup' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'ocs-ana', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A delivery company's scan the map does not know is read by its memo; its activity alone says nothing.
    expect(ocsStage('Status Updated by Delivery Contracted Company: Delivery attempted')).toMatchObject({ stage: 'failed_attempt' });
    expect(ocsStage('Status Updated by Delivery Contracted Company')).toBeNull();
    expect(ocsStage('Synthetic note')).toBeNull();
  });
});
