import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, XpoLtlTracker, xpoLtlHistoryUrl, xpoLtlSummaryUrl } from './adapter.js';
import { normalizeXpoLtlNumber, parseXpoLtlHistory, parseXpoLtlSummary, xpoLtlElevenDigitPro, xpoLtlResult } from './parser.js';
import { statusMap, xpoLtlEventStage, xpoLtlSummaryStatus } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic PROs with a valid check digit.
const MOVING = '990000001';
const DELIVERED = '990000012';
const UNKNOWN = '990000023';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'latin1');
const reply = (body: string, contentType = 'text/html;charset=ISO-8859-1') =>
  new Response(Buffer.from(body, 'latin1'), { headers: { 'Content-Type': contentType } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const mexico = (html: string) => html.replace('<th align=center>PRO Tracking', '<th align=center>MX: PRO Tracking');

/** A transport that answers each page from its own list, in order. */
function site(pages: { summary?: string[]; mexico?: string[]; history?: string[] }) {
  const queues = { summary: [...pages.summary ?? []], mexico: [...pages.mexico ?? []], history: [...pages.history ?? []] };
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const queue = url.pathname.endsWith('/ShipmentHistory.jsp') ? queues.history
      : url.searchParams.get('rptMX') === 'MX' ? queues.mexico : queues.summary;
    const body = queue.shift();
    if (body === undefined) throw new Error(`unexpected request ${url}`);
    return reply(body);
  });
}

describe('XPO HTTP adapter', () => {
  it('reads the summary, then its history, through the supplied transport', async () => {
    const fetcher = site({ summary: [fixture('summary-in-transit.html')], history: [fixture('history-in-transit.html')] });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new XpoLtlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 990-000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://ltl.xpo.com/webapp/manifestrpts_p_app/Tracking/TrackingRS.jsp?PRO=990000001',
      'https://ltl.xpo.com/webapp/manifestrpts_p_app/Tracking/ShipmentHistory.jsp?proNbr=990000001&rptMX=&intlMXShipmentHistNote=N',
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal),
        headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xpo-ltl', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the service centers’ wall clocks, drops lookups and saves, and reads no party or reference', () => {
    const result = xpoLtlResult(parseXpoLtlSummary(fixture('summary-in-transit.html'), MOVING),
      parseXpoLtlHistory(fixture('history-in-transit.html'), MOVING));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'At interim', provider_code: '43', last_update: null, last_update_local: '2026-03-04T09:05:00',
      expected_delivery: '2026-03-06', weight_kg: 566.99 });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage ?? null])).toEqual([
      ['2026-03-04T09:05:00', 'Hubville, NE', 'Unloaded from trailer', 'in_transit'],
      ['2026-03-04T08:58:00', 'Hubville, NE', 'Held on trap trailer - Customer Requested Consolidated Delivery from XHB', 'in_transit'],
      ['2026-03-04T08:52:00', 'Hubville, NE', 'Designated as Trap Trailer', 'in_transit'],
      ['2026-03-04T08:44:00', 'Hubville, NE', 'Unloading at dock', 'in_transit'],
      // The page repeats this row; it is one scan.
      ['2026-03-03T06:29:00', 'Hubville, NE', 'Schedule arrived from XSA to XHB', 'in_transit'],
      ['2026-03-02T20:47:00', 'Sampleton, IL', 'Schedule departed from XSA to XHB', 'in_transit'],
      ['2026-03-02T20:11:00', 'Sampleton, IL', 'Closed to XHB', 'in_transit'],
      ['2026-03-02T19:36:00', 'Sampleton, IL', 'Loaded on trailer', 'in_transit'],
      ['2026-03-02T18:02:00', 'Sampleton, IL', 'Staged to dock location', 'in_transit'],
      ['2026-03-02T18:02:00', 'Sampleton, IL', 'Unloaded from trailer', 'in_transit'],
      ['2026-03-02T17:21:00', 'Sampleton, IL', 'Unloading at dock', 'in_transit'],
      ['2026-03-02T16:58:00', 'Sampleton, IL', 'City arrived', 'in_transit'],
      ['2026-03-02T14:17:00', 'Sampleton, IL', 'Reported picked up from XSA', 'accepted'],
      ['2026-03-02T14:17:00', 'Sampleton, IL', 'Loaded on trailer', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(result.summary_only).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Placeholder|Fictional|Synthetic Supply|Payables|Example Way|60999|80999|43999|5550001|7770001|Prepaid|Mockford/);
  });

  it('clears the estimate once delivered, cuts the delivery route and leaves out the system unload', () => {
    const result = xpoLtlResult(parseXpoLtlSummary(fixture('summary-delivered.html'), DELIVERED),
      parseXpoLtlHistory(fixture('history-delivered.html'), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered by', provider_code: '23',
      last_update_local: '2026-11-19T12:16:00', expected_delivery: null, weight_kg: 217.724 });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.slice(0, 5).map((event) => [event.local_time, event.description, event.stage ?? null])).toEqual([
      ['2026-11-19T12:16:00', 'Arrived at Customer', 'out_for_delivery'],
      ['2026-11-19T12:05:00', 'Final delivered from UMK', 'delivered'],
      ['2026-11-19T07:48:00', 'Dispatched on P&D run', 'out_for_delivery'],
      ['2026-11-19T07:48:00', 'Out for delivery from UMK', 'out_for_delivery'],
      ['2026-11-19T07:25:00', 'Closed for delivery', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/P&D route|ZZ 9/);
  });

  it('lets the rows decide when the summary code is a notice, a final delivery over a later arrival', () => {
    const notice = fixture('summary-delivered.html').replace('statusCode=23', 'statusCode=30')
      .replace('<b>Delivered by</b>', '<b>Delivery Receipt Image available</b>');
    const delivered = xpoLtlResult(parseXpoLtlSummary(notice, DELIVERED), parseXpoLtlHistory(fixture('history-delivered.html'), DELIVERED));
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: '30', expected_delivery: null });
    const parent = fixture('summary-in-transit.html').replace('statusCode=43', 'statusCode=24');
    expect(xpoLtlResult(parseXpoLtlSummary(parent, MOVING), parseXpoLtlHistory(fixture('history-in-transit.html'), MOVING)))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: '2026-03-06' });
    const bare = xpoLtlResult(parseXpoLtlSummary(parent, MOVING), null);
    expect(bare).toMatchObject({ status: 'unknown', summary_only: true, events: [] });
    expect(bare.current_stage).toBeUndefined();
  });

  it('gives the summary alone when the history is not available', async () => {
    const fetcher = site({ summary: [fixture('summary-in-transit.html')], history: [fixture('history-not-available.html')] });
    await expect(carrier(fetcher).track({ number: MOVING })).resolves.toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      summary_only: true, events: [], last_update_local: '2026-03-04T09:05:00' });
  });

  it('reads twelve o’clock both ways and rejects an impossible clock', () => {
    const history = fixture('history-in-transit.html');
    const midnight = parseXpoLtlHistory(history.replaceAll('3/3/26 6:29 AM', '3/3/26 12:29 AM'), MOVING)!;
    expect(midnight.find((scan) => scan.description.startsWith('Schedule arrived'))?.localTime).toBe('2026-03-03T00:29:00');
    for (const clock of ['3/3/26 13:29 PM', '2/30/26 6:29 AM', '3/3/26 6:29']) {
      expect(() => parseXpoLtlHistory(history.replaceAll('3/3/26 6:29 AM', clock), MOVING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('is not found only when the Mexico system the notice links to says so too', async () => {
    const fetcher = site({ summary: [fixture('summary-not-found.html')],
      mexico: [mexico(fixture('summary-not-found.html')).replace('<b>09900000023</b>', `<b>${UNKNOWN}</b>`)] });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([xpoLtlSummaryUrl(UNKNOWN), xpoLtlSummaryUrl(UNKNOWN, true)]);
    expect(xpoLtlSummaryUrl(UNKNOWN, true)).toBe('https://ltl.xpo.com/webapp/manifestrpts_p_app/Tracking/TrackingRS.jsp?rptMX=MX&PRO=990000023');
  });

  it('reads a shipment the Mexico system knows, with its own history', async () => {
    const notFound = fixture('summary-not-found.html').replaceAll('09900000023', xpoLtlElevenDigitPro(MOVING));
    const fetcher = site({ summary: [notFound], mexico: [mexico(fixture('summary-in-transit.html'))], history: [fixture('history-in-transit.html')] });
    await expect(carrier(fetcher).track({ number: MOVING })).resolves.toMatchObject({ status: 'in_transit', provider_code: '43' });
    expect(String(fetcher.mock.calls[2]![0])).toBe(xpoLtlHistoryUrl(MOVING, true));
    expect(xpoLtlHistoryUrl(MOVING, true)).toContain('?proNbr=990000001&rptMX=MX&intlMXShipmentHistNote=N');
  });

  it('binds both pages to the PRO asked for', () => {
    expect(() => parseXpoLtlSummary(fixture('summary-in-transit.html'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXpoLtlHistory(fixture('history-in-transit.html'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXpoLtlSummary(fixture('summary-not-found.html'), MOVING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const html = fixture('summary-in-transit.html');
    const block = /<tr><td class=stdDisplayText valign='top' align='left' colspan='2'><TABLE width=640 [\s\S]*?height=3><\/td><\/tr>\n/.exec(html)![0];
    expect(() => parseXpoLtlSummary(html.replace(block, block + block), MOVING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const history = fixture('history-in-transit.html');
    expect(() => parseXpoLtlHistory(history.replace('<b>PRO Number: 990000001</b>', '<b>PRO Number: 990000001</b><b>PRO Number: 990000012</b>'), MOVING))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXpoLtlSummary(html.replace('<th align=center>PRO Tracking', '<th>Maintenance'), MOVING))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXpoLtlHistory(history.replace('<b>Service Center</b>', '<b>Terminal</b>'), MOVING))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the firewall’s rejection, an invalid PRO and other errors apart', async () => {
    await expect(carrier(site({ summary: [fixture('rejected.txt')] })).track({ number: MOVING })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site({ summary: [fixture('summary-in-transit.html')], history: [fixture('rejected.txt')] })).track({ number: MOVING }))
      .rejects.toMatchObject({ kind: 'challenge' });
    const errors = (message: string) => fixture('summary-not-found.html').replace(/<tr><td class=stdDisplayText valign='top' align='left' colspan='2'>[\s\S]*?height=3><\/td><\/tr>\n/,
      () => '').replace('<table border=0 width=100% cellpadding=0 cellspacing=0 class=stdTableAsGroupBox>',
      () => `<table border=0 width=100% cellpadding=0 cellspacing=0 class=stdTableAsGroupBox><tr><td class=stdDisplayText valign=top align=left colspan=2><font color=#ff0000><b>Please correct the following error(s)<ul><li>${message}</ul></b></font></td></tr>`);
    expect(() => parseXpoLtlSummary(errors(`The PRO ${MOVING} format is invalid.`), MOVING)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseXpoLtlSummary(errors(`The PRO ${DELIVERED} format is invalid.`), MOVING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXpoLtlSummary(errors('No reference numbers were entered.'), MOVING)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: MOVING })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(MOVING)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known PRO from its summary alone, and an unknown one from both systems', async () => {
    const fetcher = site({ summary: [fixture('summary-in-transit.html'), fixture('summary-not-found.html')],
      mexico: [mexico(fixture('summary-not-found.html'))] });
    await expect(carrier(fetcher).recognize!(MOVING)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T09:05:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('990000002')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('ShipmentHistory'))).toBe(false);
  });

  it('rejects numbers XPO does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['990000002', '99000001', '9900000012', '09900000001', 'ABC000001', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: MOVING }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeXpoLtlNumber('990-000012')).toBe(DELIVERED);
    expect(xpoLtlElevenDigitPro(UNKNOWN)).toBe('09900000023');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const pages = site({ summary: [fixture('summary-in-transit.html'), fixture('summary-in-transit.html')], history: [fixture('history-in-transit.html')] });
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      calls += 1;
      if (calls === 2) throw new TypeError('fetch failed');
      return pages(input, init);
    });
    await expect(carrier(fetcher).track({ number: MOVING }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: MOVING }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('decodes the pages as Latin-1 unless they say UTF-8', async () => {
    const accented = fixture('history-in-transit.html').replaceAll('Hubville, NE', 'Querétaro, QA');
    const latin = await carrier(site({ summary: [fixture('summary-in-transit.html')], history: [accented] })).track({ number: MOVING });
    expect(latin.events![0]!.location).toBe('Querétaro, QA');
    const utf8 = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('summary-in-transit.html')))
      .mockResolvedValueOnce(new Response(accented, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }));
    const result = await carrier(utf8).track({ number: MOVING });
    expect(result.events![0]!.location).toBe('Querétaro, QA');
  });

  it('routes a shipment filed under XPO to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      reply(fixture(String(input).includes('ShipmentHistory') ? 'history-delivered.html' : 'summary-delivered.html')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'xpo-ltl' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'xpo-ltl', source: 'xpo-ltl', result: { current_stage: 'delivered' } });
  });

  it('proves each declared capability', () => {
    const result = xpoLtlResult(parseXpoLtlSummary(fixture('summary-in-transit.html'), MOVING),
      parseXpoLtlHistory(fixture('history-in-transit.html'), MOVING));
    const checks: Record<string, boolean> = {
      history: Boolean(result.events?.length), location: Boolean(result.events?.some((event) => event.location)),
      eta: Boolean(result.expected_delivery), weight: typeof result.weight_kg === 'number', provider_code: Boolean(result.provider_code),
    };
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { capabilities: string[] };
    for (const capability of metadata.capabilities) expect(checks[capability], capability).toBe(true);
  });
});

describe('XPO status vocabulary', () => {
  it('records every code and row wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      const wording = entry.wording.replaceAll('[service center]', 'XZZ');
      if (entry.code) {
        expect(xpoLtlSummaryStatus(entry.code)?.stage, entry.code).toBe(entry.stage);
        expect(statusMap.stage(entry.code, wording.toLowerCase()), entry.code).toBe(entry.stage);
      } else {
        expect(xpoLtlEventStage(wording), wording).toBe(entry.stage);
        expect(statusMap.stage(null, wording.toLowerCase()), wording).toBe(entry.stage);
      }
    }
  });

  it('answers the app by the summary code or the row wording', () => {
    expect(statusMapAnswer({ carrier: 'xpo-ltl', providerCode: '23', description: 'Delivered by' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'xpo-ltl', providerCode: '31', description: 'BOL Image available' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'xpo-ltl', providerCode: null, description: 'Schedule departed from XAA to XBB' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'xpo-ltl', providerCode: null, description: 'Shortage reported at destination' })).toEqual({ kind: 'unknown' });
  });
});
