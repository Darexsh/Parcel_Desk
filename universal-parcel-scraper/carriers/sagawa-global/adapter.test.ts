import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SAGAWA_GLOBAL_TRACKER, SagawaGlobalTracker, sagawaGlobalLookupUrl } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeSagawaGlobalNumber, parseSagawaGlobal } from './parser.js';
import { sagawaGlobalStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000000004';
const IN_TRANSIT = '200000000001';
const UNKNOWN = '300000000005';
const LOS_ANGELES = 'IDA000000000017';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, from: string | RegExp, to: string) => {
  const page = fixture(name);
  const edited = page.replace(from, to);
  if (edited === page) throw new Error(`fixture ${name} has no ${String(from)}`);
  return edited;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const FOOTER_LABEL = '<span>LOCAL TRACKING#</span>';
const FOOTER_LINK = `http://k2k.sagawa-exp.co.jp/cgi-bin/mall.mmcgi?oku01=${DELIVERED}`;

describe('SGH Global Japan HTTP adapter', () => {
  it('asks the SGX tracker for the whole air waybill once, in English, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SagawaGlobalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2000-0000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SAGAWA_GLOBAL_TRACKER}?ENC=ENG&CAT=AWB&AWB=${IN_TRANSIT}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sagawa-global', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(sagawaGlobalLookupUrl(LOS_ANGELES)).toBe(`${SAGAWA_GLOBAL_TRACKER}?ENC=ENG&CAT=AWB&AWB=${LOS_ANGELES}`);
  });

  it('keeps each scan’s wall clock and drops the flight’s forecast, the stamp and the repeated scan', () => {
    const result = parseSagawaGlobal(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-05-08T16:45:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage ?? null, event.location ?? null])).toEqual([
      // Sagawa Express's scans carry the destination station, which the adapter leaves out.
      ['2026-05-08T16:45:00', 'Delivered', 'delivered', null],
      ['2026-05-07T11:30:00', 'ABSENCE', 'failed_attempt', null],
      ['2026-05-06T10:22:00', 'Out For Delivery', 'in_transit', 'SAMPLE AIRPORT, JAPAN'],
      ['2026-05-06T10:20:00', 'CLEARANCE RELEASE', 'in_transit', 'SAMPLE AIRPORT, JAPAN'],
      ['2026-05-06T10:20:00', 'Arrived At Destination / Customs Clearance', 'customs', 'SAMPLE AIRPORT, JAPAN'],
      ['2026-05-05T17:45:00', 'In transit to our bonded warehouse', 'in_transit', 'SAMPLE AIRPORT, JAPAN'],
      ['2026-05-05T15:10:00', 'Arrrived at Destination Airport', 'in_transit', 'SAMPLE AIRPORT, JAPAN'],
      ['2026-05-03T23:40:00', 'On Board Aircraft', 'in_transit', 'SAMPLE CITY, U.S.A'],
      ['2026-05-02T09:15:00', 'Preparing for dispatch', 'accepted', 'SAMPLE CITY, U.S.A'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE-REF|SMP|NRT|STAMP|Estimated|contact\.asp/);
  });

  it('names the Sagawa Express waybill the footer gives once the parcel is handed over', () => {
    expect(parseSagawaGlobal(fixture('delivered'), DELIVERED)).toMatchObject({ delivery_carrier: 'sagawa', delivery_tracking_number: DELIVERED });
    const japanese = changed('delivered', FOOTER_LABEL, '<span>国内伝票番号</span>');
    expect(parseSagawaGlobal(japanese, DELIVERED)).toMatchObject({ delivery_carrier: 'sagawa', delivery_tracking_number: DELIVERED });
    // An air waybill from Los Angeles hands over under a Sagawa Express number of its own.
    const angeles = changed('delivered', `<span class='info_value'>${DELIVERED}</span>`, `<span class='info_value'>${LOS_ANGELES}</span>`);
    expect(parseSagawaGlobal(angeles, LOS_ANGELES)).toMatchObject({ delivery_carrier: 'sagawa', delivery_tracking_number: DELIVERED });
    for (const page of [
      changed('delivered', FOOTER_LABEL, '<span>REF#</span>'),
      changed('delivered', FOOTER_LINK, 'https://sample.example/track'),
      changed('delivered', FOOTER_LINK, `https://k2k.sagawa-exp.co.jp.sample.example/?oku01=${DELIVERED}`),
      changed('delivered', `<span>${DELIVERED}</span></td><td><span class='Highlight'>`, `<span>SAMPLE</span></td><td><span class='Highlight'>`),
      changed('delivered', `href='${FOOTER_LINK}'`, ''),
      changed('delivered', /<tfoot>[\s\S]*<\/tfoot>/, ''),
    ]) {
      const result = parseSagawaGlobal(page, DELIVERED);
      expect(result).not.toHaveProperty('delivery_carrier');
      expect(result).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads a parcel in customs before the hand-off', () => {
    const result = parseSagawaGlobal(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived At Destination / Customs Clearance', last_update: null, last_update_local: '2026-06-04T09:50:00' });
    expect(result.events!.map((event) => [event.local_time, event.location])).toEqual([
      ['2026-06-04T09:50:00', 'SAMPLE AIRPORT, JAPAN'],
      ['2026-06-03T14:05:00', 'SAMPLE AIRPORT, JAPAN'],
      ['2026-06-02T22:10:00', 'SAMPLE TOWN, KOREA'],
      ['2026-06-01T08:30:00', 'SAMPLE TOWN, KOREA'],
    ]);
    expect(result).not.toHaveProperty('delivery_carrier');
    // Wording the map does not know falls to the shared rules, else stays without a stage.
    const strange = parseSagawaGlobal(changed('in-transit', 'Arrived At Destination / Customs Clearance', 'Sample notice'), IN_TRANSIT);
    expect(strange).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample notice' });
    expect(strange.events![0]).not.toHaveProperty('stage');
  });

  it('reads No Record. as not found, a list of air waybills as inconclusive and a forecast alone as no history', () => {
    expect(() => parseSagawaGlobal(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSagawaGlobal(fixture('list'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SGX listed air waybills for this number instead of one shipment' }));
    const forecast = changed('in-transit', /<tbody>[\s\S]*<\/tbody>/, '<tbody><tr><td><span>20260603&nbsp;&nbsp;1200</span></td>'
      + "<td><span class='DarkBlue'>Estimated Arrival date at airport</span></td><td><a href='contact.asp' target='country4'>SAMPLE</a></td></tr></tbody>");
    expect(() => parseSagawaGlobal(forecast, IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseSagawaGlobal(changed('in-transit', /<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it echoes the air waybill asked', () => {
    expect(() => parseSagawaGlobal(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SGX answered for another air waybill' }));
    expect(() => parseSagawaGlobal(changed('in-transit', `<span class='info_value'>${IN_TRANSIT}</span>`, `<span class='info_value'>${IN_TRANSIT}0</span>`), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseSagawaGlobal(changed('in-transit', `<span class='info_value'>${IN_TRANSIT}</span>`, "<span class='info_value'>2000 0000 0001</span>"), IN_TRANSIT).events)
      .toHaveLength(4);
  });

  it('rejects a changed page', () => {
    const row = /<tr><td><span>20260601[\s\S]*?<\/tr>/;
    for (const page of [
      changed('in-transit', "<select id='cat'", "<select id='category'"),
      changed('in-transit', "<div id='ShipmentDetail'>", "<div id='Shipment'>"),
      changed('in-transit', "<div id='ShipmentDetail'>", "<div id='ShipmentDetail'></div><div id='ShipmentDetail'>"),
      changed('in-transit', "<div id='info_awb'>", "<div id='info_number'>"),
      changed('in-transit', "<div id='ShipmentInfo'>", "<div id='Info'>"),
      changed('in-transit', '<span>COUNTRY</span>', '<span>PLACE</span>'),
      changed('in-transit', '20260601&nbsp;&nbsp;0830', '2026/06/01 08:30'),
      changed('in-transit', '20260601&nbsp;&nbsp;0830', '20260230&nbsp;&nbsp;0830'),
      changed('in-transit', '20260601&nbsp;&nbsp;0830', '20260601&nbsp;&nbsp;2460'),
      changed('in-transit', "<span class='DarkBlue'>Preparing for dispatch</span>", "<span class='DarkBlue'></span>"),
      changed('in-transit', "<td><span class='DarkBlue'>Preparing for dispatch</span></td>", ''),
      changed('in-transit', row, (fixture('in-transit').match(row)![0]).repeat(501)),
    ]) {
      expect(() => parseSagawaGlobal(page, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown air waybill, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker reports an unknown air waybill on a 200 page: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.sgh-globalj.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="g-recaptcha"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Shipment Tracking SGX</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
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

  it('recognizes a known air waybill and the unknown answer, and asks nothing for a number SGX does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-08T16:45:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('100000000005')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers SGX does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['100000000005', '10000000004', '1000000000040', 'IDA00000000001', 'IDB000000000017', 'SAMPLE', '', `1${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSagawaGlobalNumber(' 1000.0000-0004 ')).toBe(DELIVERED);
    expect(normalizeSagawaGlobalNumber('ida 000 000 000 017')).toBe(LOS_ANGELES);
    // Every air waybill in the corpus passes.
    for (const record of numbers.records) expect(normalizeSagawaGlobalNumber(record.number), record.number).toBe(record.number);
  });

  it('routes an air waybill filed under SGH Global Japan to the adapter and proposes the Sagawa Express hand-off', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: DELIVERED, carrier: 'sagawa-global' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'sagawa-global', source: 'sagawa-global', result: { current_stage: 'delivered' } });
    expect(answer.handoff).toMatchObject({ carrier: 'sagawa', number: DELIVERED, basis: 'partner' });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(SAGAWA_GLOBAL_TRACKER))).toBe(true);
    // No rule claims an SGX air waybill, so detection leaves its layouts to other carriers.
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, LOS_ANGELES]) {
      expect(detectCarrierMatch(number).candidates as readonly string[], number).not.toContain('sagawa-global');
    }
  });
});

describe('SGH Global Japan status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, and the forecasts as gaps', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.stage) {
        expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'sagawa-global', description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(sagawaGlobalStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'sagawa-global', description: 'ABSENCE' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'sagawa-global', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(sagawaGlobalStage('Synthetic note')).toBeNull();
    expect(sagawaGlobalStage('Shipment delivered')).toMatchObject({ stage: 'delivered' });
  });
});
