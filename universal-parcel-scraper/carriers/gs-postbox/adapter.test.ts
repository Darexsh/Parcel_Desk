import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { cjStage } from '../cj-logistics/status.js';
import { adapter, GS_POSTBOX_TRACKER, GsPostboxTracker } from './adapter.js';
import { normalizeGsPostboxNumber, parseGsPostboxPage } from './parser.js';
import { gsPostboxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = '000000000000';
const DELIVERED = '000000000001';
const IN_TRANSIT = '000000000002';
const HANDOFF = '000000000003';

type Row = Record<string, unknown>;
type Info = Row & { trackingDetails: Row[] };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DATA = /var trackingInfo = (\{.*\});/g;
/** A fixture page whose tracking data is changed the same way in both of the script's copies. */
const changed = (name: string, change: (info: Info) => void) => fixture(name).replace(DATA, (_line, json: string) => {
  const info = JSON.parse(json) as Info;
  change(info);
  return `var trackingInfo = ${JSON.stringify(info)};`;
});
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (name: string, number: string) => parseGsPostboxPage(fixture(name), number).events!
  .map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null]);
// A firewall's check in place of the page.
const CHECK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt = {};</script></body></html>';

describe('GS Postbox HTTP adapter', () => {
  it('asks the tracking page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GsPostboxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000-0000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GS_POSTBOX_TRACKER}?invoice_no=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gs-postbox', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a half-price parcel’s scans on Korean time, up to its collection at the destination store', () => {
    const result = parseGsPostboxPage(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '고객에게 전달', last_update: '2026-04-05T10:15:38+09:00', delivered_at: '2026-04-05T10:15:38+09:00',
      expected_delivery: null, pickup_point: 'GS25샘플공원점', service_name: '반값택배' });
    expect(rows('delivered', DELIVERED)).toEqual([
      ['2026-04-05T10:15:38+09:00', 'C11', 'delivered', 'GS25샘플공원점'],
      ['2026-04-04T21:47:15+09:00', 'C10', 'ready_for_pickup', 'GS25샘플공원점'],
      ['2026-04-04T18:31:09+09:00', 'C095', 'in_transit', 'GS25샘플공원점'],
      ['2026-04-04T11:02:57+09:00', 'C09', 'in_transit', '샘플2저온센터'],
      // The repeated hub scan is kept once.
      ['2026-04-03T09:12:30+09:00', 'C07', 'in_transit', '샘플허브센터(C2C)'],
      ['2026-04-02T13:20:44+09:00', 'C03', 'in_transit', '샘플저온센터'],
      ['2026-04-01T21:40:03+09:00', 'C015', 'in_transit', 'GS25샘플역점'],
      ['2026-04-01T16:05:12+09:00', 'C01', 'accepted', 'GS25샘플역점'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events![3]!.description).toBe('출고센터 배송준비중 입니다.');
    // GS Networks carries the parcel itself: there is no hand-off.
    expect(result).not.toHaveProperty('delivery_carrier');
    // The sender, the recipient, their masked phones and the goods are not read.
    expect(JSON.stringify(result)).not.toMatch(/가\*다|나\*라|000\*{4}0000|잡화|GS네트웍스|SLOW/);
  });

  it('reads a parcel on its way with no pickup point yet', () => {
    const result = parseGsPostboxPage(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '허브센터에 도착',
      last_update: '2026-05-13T08:55:19+09:00', service_name: '반값택배' });
    expect(result.events).toHaveLength(4);
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('delivered_at');
    // A parcel at its destination store has its pickup point.
    const waiting = parseGsPostboxPage(changed('delivered', (info) => { info.trackingDetails.pop(); }), DELIVERED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'GS25샘플공원점' });
    expect(waiting).not.toHaveProperty('delivered_at');
  });

  it('relays CJ Logistics’ scans of a home delivery and names CJ Logistics for the same number', () => {
    const result = parseGsPostboxPage(fixture('handoff'), HANDOFF);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: '배송출발', last_update: '2026-06-02T12:01:46+09:00', service_name: '국내택배', delivery_carrier: 'cj-logistics' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(rows('handoff', HANDOFF)).toEqual([
      // A direct route's label loses the driver it names.
      ['2026-06-02T12:01:46+09:00', '82', 'out_for_delivery', '샘플직영'],
      ['2026-06-02T09:46:35+09:00', '42', 'in_transit', '샘플'],
      ['2026-06-02T01:19:07+09:00', '41', 'in_transit', '샘플Hub'],
      ['2026-06-02T01:13:26+09:00', '42', 'in_transit', '샘플Hub'],
      ['2026-06-01T20:41:10+09:00', '11', 'accepted', '샘플대리점'],
    ]);
    expect(deliveryHandoff('gs-postbox', HANDOFF, result)).toEqual({ carrier: 'cj-logistics', number: HANDOFF, basis: 'partner' });
    // A departure scan recorded after the delivery leaves the parcel delivered.
    const late = parseGsPostboxPage(changed('handoff', (info) => {
      info.trackingDetails.push({ transTime: '2026-06-02T15:30:00', level: 6, transWhere: '샘플', transCode: '91', transKind: '배송완료' },
        { transTime: '2026-06-02T15:35:00', level: 7, transWhere: '샘플', transCode: '82', transKind: '배송출발' });
    }), HANDOFF);
    expect(late).toMatchObject({ current_stage: 'delivered', last_update: '2026-06-02T15:30:00+09:00', delivered_at: '2026-06-02T15:30:00+09:00' });
    expect(late).not.toHaveProperty('pickup_point');
  });

  it('keeps another network’s wall clocks and names it when the catalog knows its name', () => {
    const result = parseGsPostboxPage(changed('in-transit', (info) => {
      Object.assign(info, { carrierType: 'SAMPLE_EXPRESS', carrierName: 'Sample Courier' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-05-13T08:55:19', current_stage: 'in_transit' });
    expect(result.events!.every((event) => event.time === undefined && /^2026-05-1\dT\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(result).not.toHaveProperty('delivery_carrier');
    const named = parseGsPostboxPage(changed('in-transit', (info) => {
      Object.assign(info, { carrierType: 'SAMPLE_EXPRESS', carrierName: 'CJ대한통운' });
    }), IN_TRANSIT);
    expect(named).toMatchObject({ delivery_carrier: 'cj-logistics' });
  });

  it('reads an unknown number as not found, another code as inconclusive and a record without scans as no history', () => {
    expect(() => parseGsPostboxPage(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGsPostboxPage(changed('handoff', (info) => { info.code = 500; }), HANDOFF))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GS Postbox did not complete the lookup' }));
    expect(() => parseGsPostboxPage(changed('handoff', (info) => { info.trackingDetails = []; info.latestTrackingDetail = null; }), HANDOFF))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts an answer only when it names the number asked', () => {
    expect(() => parseGsPostboxPage(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GS Postbox answered for another number' }));
    expect(() => parseGsPostboxPage(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GS Postbox answered for another number' }));
  });

  it('rejects a changed page', () => {
    for (const body of [
      '<html><body>조회결과</body></html>',
      fixture('delivered').replace(DATA, 'var trackingInfo = {"code":200,;'),
      fixture('delivered').replace(DATA, 'var trackingInfo = [];'),
      changed('delivered', (info) => { delete info.code; }),
      changed('delivered', (info) => { info.code = '200'; }),
      changed('delivered', (info) => { delete info.invoiceNo; }),
      changed('delivered', (info) => { delete info.carrierType; }),
      changed('delivered', (info) => { info.trackingDetails = 'scans' as never; }),
      changed('delivered', (info) => { info.trackingDetails = Array.from({ length: 501 }, () => info.trackingDetails[0]!); }),
      changed('delivered', (info) => { info.trackingDetails[0] = 'scan' as never; }),
      changed('delivered', (info) => { info.trackingDetails[0]!.transTime = '2026-04-01 16:05'; }),
      changed('delivered', (info) => { info.trackingDetails[0]!.transTime = '2026-04-01T24:00:00'; }),
      changed('delivered', (info) => { info.trackingDetails[0]!.transTime = '2026-02-30T10:00:00'; }),
      changed('delivered', (info) => { info.trackingDetails[0]!.transCode = 1; }),
      changed('delivered', (info) => { info.trackingDetails[0]!.transKind = ''; }),
      changed('delivered', (info) => { delete info.trackingDetails[0]!.transWhere; }),
    ]) {
      expect(() => parseGsPostboxPage(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.cvsnet.co.kr/main/index.do' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>GS Postbox</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a read that fails to reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(page(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number GS Postbox does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(fixture('delivered')))
      .mockResolvedValueOnce(page(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-05T01:15:38.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('GS0000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers GS Postbox does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000000', '00000000000000', 'GS0000000001', `${'0'.repeat(65)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGsPostboxNumber('0000 0000 0001')).toBe(DELIVERED);
    expect(normalizeGsPostboxNumber('0000000000')).toBe('0000000000');
    expect(normalizeGsPostboxNumber('0000000000001')).toBe('0000000000001');
  });

  it('routes a number filed under GS Postbox to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'gs-postbox' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gs-postbox', source: 'gs-postbox', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(GS_POSTBOX_TRACKER))).toBe(true);
  });
});

describe('GS Postbox status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      // GS Networks' own codes, and CJ Logistics' codes the tracker relays.
      const staged = entry.code?.startsWith('C') || !entry.code ? gsPostboxStage(entry.code ?? '', entry.wording) : cjStage(entry.code, entry.wording);
      expect(staged?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'gs-postbox', providerCode: 'C10', description: '점포에 도착' })).toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'gs-postbox', providerCode: '91', description: '배송완료' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'gs-postbox', providerCode: 'C99', description: '샘플' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules, which read no Korean.
    expect(gsPostboxStage('C99', '샘플')).toBeNull();
    expect(gsPostboxStage('C99', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(gsPostboxStage('c11', '고객에게 전달')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
