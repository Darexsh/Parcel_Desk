import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TstCfTracker } from './adapter.js';
import { checkTstCfLookup, parseTstCf, TST_CF_LOOKUP, TST_CF_ORIGIN, TST_CF_RESULTS, tstCfLookupUrl } from './parser.js';
import { statusMap, tstCfMappedStage, tstCfStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const KNOWN = '1234067891';
const OTHER = '0000000000';
const SAIA = '12345678901';
const SESSION = 'PHPSESSID=syntheticsession000000000000';
const ACCEPTED = '[{"errType":"fstatus","finalMsg":"","valStatus":true}]';
const REFUSED = '[{"errType":"msg","finalMsg":"","errMsg":"Please enter at least 1 tracing number"},{"errType":"fstatus","finalMsg":"","valStatus":false}]';
const REFRESH = `<!DOCTYPE html>\n<html>\n<head><meta http-equiv="refresh" content="0;url=${TST_CF_RESULTS}" /></head>\n<body>Redirecting</body>\n</html>\n`;
const BLOCKS = ['<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
  '<html><head><title>Sucuri WebSite Firewall - Access Denied</title></head><body>sucuri_cloudproxy</body></html>'];
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, status = 200, headers: [string, string][] = []) => new Response(body, { status,
  headers: [['content-type', 'text/html; charset=UTF-8'], ...headers] });
// The lookup's answer opens the session and sends the browser on with a refresh.
const opened = (body = ACCEPTED + REFRESH, status = 200, location?: string) => html(body, status, [
  ['set-cookie', `${SESSION}; path=/; Httponly; Secure`], ['set-cookie', 'tstLanguage=en; path=/; domain=.tst-cfexpress.com; secure; HttpOnly'],
  ...(location ? [['location', location] as [string, string]] : [])]);
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const failure = (run: () => unknown) => {
  try { run(); }
  catch (error) { return error as { kind?: string; reason?: string }; }
  throw new Error('no failure');
};

type Details = { request?: unknown; diagnostics?: unknown };

interface Site {
  lookup?: (number: string) => Response | Promise<Response>;
  results?: () => Response | Promise<Response>;
}

/** TST-CF's site: the URL tracing address opens a session, whose results page shows the lookup. */
function site({ lookup, results }: Site = {}, answer = page('delivered')) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` === TST_CF_LOOKUP) return lookup ? lookup(url.searchParams.get('PRO')!) : opened();
    if (String(input) === TST_CF_RESULTS) return results ? results() : html(answer);
    return html('<html><body>Unavailable</body></html>', 503);
  });
}

describe('TST-CF Express tracking adapter', () => {
  it('sends the whole PRO to the URL tracing address and reads its session’s results page', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TstCfTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 123 406 7891 ', { budgetMs: 3000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[lookupUrl, lookupInit], [resultsUrl, resultsInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(lookupUrl).toBe(`${TST_CF_LOOKUP}?lang=e&PRO=${KNOWN}`);
    expect(lookupUrl).toBe(tstCfLookupUrl(KNOWN));
    expect(lookupInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(lookupInit.headers).has('cookie')).toBe(false);
    expect(resultsUrl).toBe(TST_CF_RESULTS);
    expect(resultsInit).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0', Cookie: SESSION } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tst-cf-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads delivered freight as a summary on wall clocks, with its weight and Saia’s PRO, and nobody’s details', () => {
    const result = parseTstCf(page('delivered'), KNOWN);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered on 01/15/2026 at 14:05', last_update: null, last_update_local: '2026-01-15T14:05:00',
      expected_delivery: null, weight_kg: 226.796, service_name: 'Road', destination_country: 'US',
      delivery_carrier: 'saia', delivery_tracking_number: SAIA, summary_only: true,
      events: [
        { local_time: '2026-01-15T14:05:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-01-12T08:30:00', description: 'Customs Release', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-01-06', description: 'Shipped', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // Only the status line names places: the terminals of an in-transit lane.
    for (const name of ['delivered', 'in-transit', 'pickup']) {
      expect(JSON.stringify({ ...parseTstCf(page(name), KNOWN), last_status_text: null }), name)
        .not.toMatch(/SAMPLETON|EXAMPLE|555-0100|Skids|Pieces/);
    }
  });

  it('hands freight to Saia only when it is delivered in the United States under an ID of Saia’s shape', () => {
    const canadian = parseTstCf(page('delivered').replace('EXAMPLE CITY, OH', 'EXAMPLE CITY, ON'), KNOWN);
    expect(canadian).toMatchObject({ destination_country: 'CA' });
    expect(canadian.delivery_carrier).toBeUndefined();
    for (const html of [page('delivered').replace('EXAMPLE CITY, OH', 'Not Available'),
      page('delivered').replace('EXAMPLE CITY, OH', 'EXAMPLE CITY, ZZ'),
      page('delivered').replace(SAIA, '1234067891'),
      page('delivered').replace('Saia Shipment ID', 'Partner Shipment ID')]) {
      expect(parseTstCf(html, KNOWN).delivery_tracking_number).toBeUndefined();
    }
  });

  it('reads freight between terminals, whose estimate can be a note to call', () => {
    const result = parseTstCf(page('in-transit'), KNOWN);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In transit between SAMPLETON, QC and EXAMPLE TOWN, ON', last_update: null, expected_delivery: null,
      weight_kg: 54.431, service_name: 'Road', destination_country: 'CA', summary_only: true,
      events: [{ local_time: '2026-01-12', description: 'Shipped', stage: 'accepted', stage_source: 'carrier_map' }],
    });
    const call = /<a href="[^"]*">Please call [^<]*<\/a>/;
    expect(parseTstCf(page('in-transit').replace(call, '01/16/2026'), KNOWN)).toMatchObject({ expected_delivery: '2026-01-16' });
    expect(parseTstCf(page('in-transit').replace(call, 'Not Available'), KNOWN)).toMatchObject({ expected_delivery: null });
    // A delivery appointment comes before the estimate.
    const booked = page('in-transit').replace('<label>Estimated Delivery:</label>', '<label>Appointment:</label>01/19/2026 @ 09:00</td></tr><tr><td><label>Estimated Delivery:</label>');
    expect(parseTstCf(booked, KNOWN)).toMatchObject({ expected_delivery: '2026-01-19' });
    const docked = parseTstCf(page('in-transit').replace(/In transit between [^<]*/, 'Currently on EXAMPLE TOWN ON dock'), KNOWN);
    expect(docked).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
  });

  it('binds a completed pickup through the PRO its status names', () => {
    expect(parseTstCf(page('pickup'), KNOWN)).toEqual({
      status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Pickup completed, pro 123-4067891 assigned', last_update: null, expected_delivery: null,
      weight_kg: 362.874, service_name: 'Road', summary_only: true, events: [],
    });
    for (const html of [page('pickup').replace('pro 123-4067891 assigned', 'pro 000-0000000 assigned'),
      page('pickup').replace(', pro 123-4067891 assigned', '')]) {
      expect(failure(() => parseTstCf(html, KNOWN))).toMatchObject({ kind: 'indeterminate' });
    }
  });

  it('stages new wording through the shared rules, else by the newest milestone', () => {
    const shared = parseTstCf(page('in-transit').replace(/In transit between [^<]*/, 'Out for delivery'), KNOWN);
    expect(shared).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(shared.current_stage_source).toMatch(/^wording:/);
    const unread = parseTstCf(page('in-transit').replace(/In transit between [^<]*/, 'Zzyzx'), KNOWN);
    expect(unread).toMatchObject({ current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: 'Zzyzx' });
    const bare = parseTstCf(page('in-transit').replace(/In transit between [^<]*/, 'Zzyzx').replace('01/12/2026', 'Not Available'), KNOWN);
    expect(bare).toMatchObject({ status: 'unknown', last_status_text: 'Zzyzx', events: [] });
    expect(bare.current_stage).toBeUndefined();
  });

  it('binds the page to the whole requested PRO', () => {
    for (const html of [page('delivered').replace(`<td>${KNOWN}</td>  \t`, `<td>${OTHER}</td>  \t`),
      page('delivered').replace(`<td>${KNOWN}</td>\n`, `<td>${OTHER}</td>\n`),
      page('delivered').replace(`<td>${KNOWN}</td>\n`, '<td></td>\n'),
      page('not-found').replace(KNOWN, OTHER)]) {
      expect(failure(() => parseTstCf(html, KNOWN))).toMatchObject({ kind: 'indeterminate' });
    }
  });

  it('reads only the tracer’s own notice as a missing PRO', () => {
    expect(failure(() => parseTstCf(page('not-found'), KNOWN))).toMatchObject({ kind: 'not_found' });
    for (const html of [page('not-found').replace('Invalid Tracking Number', 'Service temporarily unavailable'),
      page('not-found').replace('>Not Available<', `>${KNOWN}<`)]) {
      expect(failure(() => parseTstCf(html, KNOWN))).toMatchObject({ kind: 'indeterminate' });
    }
    const empty = page('in-transit').replace(/<table class="status-detail">[\s\S]*<\/table><\/td>/, '<table class="status-detail"><tr><td><label>Ship Weight:</label>120 LBS</td></tr></table></td>');
    expect(failure(() => parseTstCf(empty, KNOWN))).toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    for (const html of BLOCKS) {
      expect(failure(() => parseTstCf(html, KNOWN))).toMatchObject({ kind: 'challenge' });
      expect(failure(() => checkTstCfLookup(html))).toMatchObject({ kind: 'challenge' });
    }
  });

  it('rejects pages it cannot read', () => {
    const table = /<table class="tfi-table-results">[\s\S]*<\/table>\n<\/div>/.exec(page('delivered'))![0];
    const row = /\s*<tr>\s*<td>&nbsp;<\/td>\s*<td colspan="2"><label>Saia[\s\S]*?<\/tr>/.exec(page('delivered'))![0];
    for (const html of ['', '<html><body>Under maintenance</body></html>',
      page('delivered').replace(table, table + table),
      page('delivered').replace('<th>Pro#</th>', '<th>Numéro</th>'),
      page('delivered').replace('<td colspan="2"><label>Saia', '<td colspan="2">x</td><td><label>Saia'),
      page('delivered').replace('<td>&nbsp;</td>', '<td>Other</td>'),
      page('delivered').replace(/(<tr class="fs-14">\s*<td>1234067891<\/td>[\s\S]*?<\/tr>)/, '$1$1'),
      page('delivered').replace('01/06/2026', '02/31/2026'),
      page('delivered').replace('01/12/2026 @ 08:30', '01/12/2026 @ 24:30'),
      page('delivered').replace('01/12/2026 @ 08:30', '2026-01-12 08:30'),
      page('delivered').replace(row, row.repeat(101))]) {
      expect(failure(() => parseTstCf(html, KNOWN)), html.slice(0, 80)).toMatchObject({ kind: 'schema' });
    }
  });

  it('reads the lookup’s own answer before the results', () => {
    expect(() => checkTstCfLookup(ACCEPTED + REFRESH)).not.toThrow();
    expect(() => checkTstCfLookup(ACCEPTED)).not.toThrow();
    for (const body of [REFUSED + REFRESH, '', REFRESH, '{"errType":"fstatus","valStatus":true}', '[{"errType":"fstatus"}]',
      '[{"errType":"fstatus","valStatus":"true"}]', '[{"errType":"fstatus","valStatus":true},{"errType":"fstatus","valStatus":true}]',
      '[{"errType":"msg"}]', '[1]']) {
      expect(failure(() => checkTstCfLookup(body)), body).toMatchObject({ kind: 'schema' });
    }
  });

  it('takes ten-digit PROs and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456789', '12345678901', OTHER, '012345678', 'ABCDEFGHIJ', '', 'x'.repeat(100)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
    await expect(carrier(site({}, page('not-found'))).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('follows the lookup’s redirect only to the results page, and needs its session', async () => {
    const redirected = site({ lookup: () => opened('', 302, '/tracing/results') });
    await expect(carrier(redirected).track({ number: KNOWN })).resolves.toMatchObject({ status: 'delivered' });
    expect(redirected).toHaveBeenCalledTimes(2);
    for (const location of [`${TST_CF_ORIGIN}/tracing`, 'https://example.com/tracing/results', `${TST_CF_RESULTS}?PRO=${OTHER}`]) {
      const fetcher = site({ lookup: () => opened('', 302, location) });
      await expect(carrier(fetcher).track({ number: KNOWN }), location).rejects.toMatchObject({ kind: 'schema' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const refused = site({ lookup: () => opened(REFUSED + REFRESH) });
    await expect(carrier(refused).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'schema' });
    const sessionless = site({ lookup: () => html(ACCEPTED + REFRESH, 200, [['set-cookie', 'tstLanguage=en; path=/']]) });
    await expect(carrier(sessionless).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(sessionless).toHaveBeenCalledTimes(1);
    const lost = site({ results: () => html('', 302, [['location', `${TST_CF_ORIGIN}/tracing`]]) });
    await expect(carrier(lost).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    for (const body of BLOCKS) {
      await expect(carrier(site({ lookup: () => opened(body) })).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'challenge' });
      await expect(carrier(site({ results: () => html(body) })).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s at every step, without a retry or the session in the error', async (status, kind) => {
      for (const step of ['lookup', 'results'] as const) {
        const fetcher = site({ [step]: () => html('<html><body>Unavailable</body></html>', status) });
        const error = await carrier(fetcher).track({ number: KNOWN }).catch((caught: unknown) => caught);
        expect(error, step).toMatchObject({ kind });
        expect(fetcher).toHaveBeenCalledTimes({ lookup: 1, results: 2 }[step]);
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/syntheticsession/);
        expect([(error as Details).request, (error as Details).diagnostics], step).toEqual([undefined, undefined]);
      }
    });

  it('tries once more in a new session after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const flaky = site({ results: () => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return html(page('delivered'));
    } });
    await expect(carrier(flaky).track({ number: KNOWN })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url]) => String(url).split('?')[0])).toEqual([TST_CF_LOOKUP, TST_CF_RESULTS, TST_CF_LOOKUP, TST_CF_RESULTS]);
    expect(new Headers(flaky.mock.calls[2]![1]!.headers).has('cookie')).toBe(false);
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const error = await carrier(down).track({ number: KNOWN }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'transport' });
    expect((error as Details).request).toBeUndefined();
    expect(down).toHaveBeenCalledTimes(2);
    const immediate = site();
    await expect(carrier(immediate).track({ number: KNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: KNOWN }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: KNOWN }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('bounds the size of each reply', async () => {
    const large = site({ results: () => new Response(new Uint8Array(600_000)) });
    await expect(carrier(large).track({ number: KNOWN })).rejects.toThrow('unexpectedly large');
  });

  it('routes a PRO filed under TST-CF Express to the adapter and proposes Saia’s PRO for confirmation', async () => {
    const fetcher = site();
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: KNOWN, carrier: 'tst-cf-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'tst-cf-express', source: 'tst-cf-express', result: { current_stage: 'delivered' },
      handoff: { carrier: 'saia', number: SAIA, basis: 'partner' } });
    expect(fetcher.mock.calls.slice(0, 2).every(([url]) => String(url).startsWith(`${TST_CF_ORIGIN}/`))).toBe(true);
  });
});

describe('TST-CF Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries.filter((item) => !('code' in item))) {
      // The recorded wordings name a delivery's day and clock and a pickup's PRO as placeholders.
      const wording = entry.wording.replace('<date>', '01/15/2026').replace('<time>', '14:05').replace('<pro>', '123-4567890');
      expect(tstCfMappedStage(wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, wording.toLowerCase())).toBe(entry.stage);
    }
    expect(tstCfMappedStage('  Delivered   on 1/5/2026 ')).toBe('delivered');
    expect(tstCfMappedStage('Pickup completed, pro 1234567890 assigned')).toBe('accepted');
    for (const wording of ['constructor', 'Delivered to terminal', 'Currently on', 'In transit']) {
      expect(tstCfMappedStage(wording), wording).toBeUndefined();
    }
    expect(tstCfStage('Delivered on 01/15/2026 at 14:05')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(statusMap.stage('CRLS', 'awaiting canada customs release')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'tst-cf-express', description: 'Currently on EXAMPLE TOWN ON dock' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
