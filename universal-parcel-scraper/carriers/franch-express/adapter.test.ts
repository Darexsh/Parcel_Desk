import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FranchExpressTracker } from './adapter.js';
import {
  FRANCH_EXPRESS_LOOKUP, FRANCH_EXPRESS_RESULT, franchExpressWording, normalizeFranchExpressNumber, parseFranchExpress,
} from './parser.js';
import { franchExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The fixtures' consignment; the page has no consignment for the other number.
const NUMBER = '12340678902';
const UNKNOWN = '00000000000';
const TOKEN = 'synthetic-token-aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const edited = (name: string, change: (body: string) => string) => change(page(name));
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

/**
 * The AWB History page: the lookup answers a token for the form's query, and
 * the page opened with it shows the consignment, else the not-found answer.
 */
function site(result: (number: string) => Response = (number) => html(page(number === NUMBER ? 'in-transit' : 'not-found')),
  lookup: () => Response = () => html(TOKEN)) {
  let asked = '';
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) === FRANCH_EXPRESS_LOOKUP) {
      asked = new URLSearchParams(new URLSearchParams(String(init!.body)).get('url')!).get('keyword')!;
      return lookup();
    }
    if (String(input) !== `${FRANCH_EXPRESS_RESULT}?data=${TOKEN}`) throw new Error(`unexpected request ${String(input)}`);
    return result(asked);
  });
}

describe('Franch Express tracking adapter', () => {
  it('posts the form’s query to the lookup, then opens the AWB History page with its token, through the supplied transport', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FranchExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 0678 902 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[lookupUrl, lookupInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(lookupUrl).toBe('https://www.erpfranchexpress.com/inc/cis_ajax/jquery_encryption.php');
    expect(lookupInit).toMatchObject({ method: 'POST', body: `url=keyword%3D${NUMBER}`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(`https://www.erpfranchexpress.com/api-tracking.php?data=${TOKEN}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'franch-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivery at UTC+5:30, newest first, without names, phones, staff, weights or the proof of delivery', async () => {
    const result = await carrier(site(() => html(page('delivered')))).track({ number: NUMBER });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-05T14:39:00Z', delivered_at: '2026-03-05T14:39:00Z',
      expected_delivery: null, timezone: 'Asia/Kolkata' });
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.description, event.stage])).toEqual([
      ['2026-03-05T14:39:00Z', null, 'Delivered', 'delivered'],
      // Just after midnight in India, the evening before in UTC; the repeated scan is kept once.
      ['2026-03-03T18:45:00Z', null, 'Forwarded to DELHIVERY - Sample State', 'in_transit'],
      ['2026-03-03T18:10:00Z', 'Samplepur hub, TN', 'Received at Hub', 'in_transit'],
      ['2026-03-02T04:00:00Z', 'Exampleton hub, KA', 'Holding at Hub', 'exception'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time)).toBe(true);
    // The partner's waybill is not of a shape Delhivery issues, so it names no partner.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECIPIENT|SAMPLE STAFF|00000 00000|sample-pod|Kgs|Pcs|InScan|TNSMP|KAEXM|Reason|Waybill/);
  });

  it('reads a parcel in transit and the partner it was forwarded to, with the partner’s waybill', async () => {
    const result = await carrier(site()).track({ number: NUMBER });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Forwarded to Blue Dart - Sample State',
      last_update: '2026-10-21T06:46:00Z', delivery_carrier: 'blue-dart', delivery_tracking_number: '00000000000' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location ?? null])).toEqual([
      ['2026-10-21T06:46:00Z', null],
      ['2026-10-20T15:33:00Z', 'Samplepur hub, TN'],
      ['2026-10-20T05:00:00Z', 'Exampleton hub, KA'],
    ]);
  });

  it('names a partner only when the scan names it, carries its waybill and links no other carrier', () => {
    const partner = (body: string) => {
      const result = parseFranchExpress(body, NUMBER);
      return [result.delivery_carrier ?? null, result.delivery_tracking_number ?? null];
    };
    expect(partner(page('in-transit'))).toEqual(['blue-dart', '00000000000']);
    // A link to another carrier's tracker, a partner the catalog does not know, or a place instead of the waybill.
    expect(partner(edited('in-transit', (body) => body.replace('www.bluedart.com/tracking', 'www.dtdc.com/tracking')))).toEqual([null, null]);
    expect(partner(edited('in-transit', (body) => body.replace('Forwarded to Blue Dart', 'Forwarded to Sample Partner')))).toEqual([null, null]);
    expect(partner(edited('in-transit', (body) => body.replace(/Waybill No : 00000000000 - <a[^>]*>Track Now<\/a>/, 'Samplepur  hub, TN'))))
      .toEqual([null, null]);
    // A waybill that is the consignment's own number, or one of another shape.
    expect(partner(edited('in-transit', (body) => body.replace('Waybill No : 00000000000', `Waybill No : ${NUMBER}`)))).toEqual([null, null]);
    expect(partner(edited('in-transit', (body) => body.replace('Waybill No : 00000000000', 'Waybill No : 0000000000')))).toEqual([null, null]);
  });

  it('reads a hold at the hub as an exception, and keeps only a branch or hub with its state as the place', () => {
    const held = parseFranchExpress(edited('in-transit', (body) => body.replace('Forwarded to Blue Dart - Sample State', 'Holding at Hub')
      .replace(/Waybill No : 00000000000 - <a[^>]*>Track Now<\/a>/, 'Samplepur  hub, TN')), NUMBER);
    expect(held).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Holding at Hub' });
    expect(held).not.toHaveProperty('delivery_carrier');
    const unplaced = parseFranchExpress(edited('in-transit', (body) => body.replace('Samplepur  hub, TN', 'SAMPLE PERSON')), NUMBER);
    expect(unplaced.events!.map((event) => event.location ?? null)).toEqual([null, null, 'Exampleton hub, KA']);
    expect(franchExpressWording('Forwarded to Sample Partner 00000 00000')).toBe('Forwarded to Sample Partner');
    expect(franchExpressWording('Delivered to SAMPLE PERSON')).toBe('Delivered');
  });

  it('reads the page’s not-found answer as not found, and a page without a lookup or with another notice as inconclusive', async () => {
    await expect(carrier(site()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const notice = (text: string) => site(() => html(edited('not-found', (body) => body.replace('Consignment Number / Reference Number not found..!', text))));
    await expect(carrier(notice('Please enter AWB number..!')).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(notice('Sample notice')).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    const blank = edited('not-found', (body) => body.replace(/<div class="alert[^"]*">[^<]*<\/div>/, ''));
    await expect(carrier(site(() => html(blank))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('binds the page to the whole number asked', async () => {
    await expect(carrier(site(() => html(page('delivered')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parseFranchExpress(edited('delivered', (body) => body.replace(`font-normal">${NUMBER}`, `font-normal">${NUMBER}1`)), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFranchExpress(edited('delivered', (body) => body.replace('<ul class="list-group">',
      `<h2>Status of AWB No. ${UNKNOWN}</h2><ul class="list-group">`)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a consignment without scans as no history, and keeps the newest hundred of a long one', () => {
    expect(() => parseFranchExpress(edited('in-transit', (body) => body.replace(/<li class='list-group-item'>[\s\S]*?<\/li>/g, '')), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const row = page('in-transit').match(/<li class='list-group-item'>[\s\S]*?<\/li>/g)!.find((item) => item.includes('Exampleton'))!;
    const rows = Array.from({ length: 120 }, (_, index) => row.replace('Oct 20, 2026 10:30 AM', `Sep ${String(1 + (index % 28)).padStart(2, '0')}, 2026 ${String(1 + Math.floor(index / 28)).padStart(2, '0')}:00 AM`));
    const long = parseFranchExpress(edited('in-transit', (body) => body.replace(row, rows.join(''))), NUMBER);
    expect(long.events).toHaveLength(100);
    expect(long.history_truncated).toBe(true);
    const oversized = Array.from({ length: 301 }, () => row).join('');
    expect(() => parseFranchExpress(edited('in-transit', (body) => body.replace(row, oversized)), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a bot check in place of the token or the page, or a refusal, as a challenge', async () => {
    const checked = site(undefined, () => html(CHECK));
    await expect(carrier(checked).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    expect(checked).toHaveBeenCalledTimes(1);
    await expect(carrier(site(() => html(CHECK))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => html('<html><head><title>Sample firewall</title></head><body>Blocked by Wordfence</body></html>'))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => html('<html><body>Forbidden</body></html>', { status: 403 }))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(undefined, () => html('', { status: 403 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reports a rate limit', async () => {
    await expect(carrier(site(() => html('Too Many Requests', { status: 429, headers: { 'Retry-After': '30' } }))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(site(undefined, () => html('Too Many Requests', { status: 429 }))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('keeps a moved route or a missing page apart from an unknown number', async () => {
    await expect(carrier(site(undefined, () => new Response('', { status: 302, headers: { Location: 'https://www.erpfranchexpress.com/' } })))
      .track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(() => new Response('', { status: 302, headers: { Location: 'https://www.erpfranchexpress.com/' } })))
      .track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(() => html('', { status: 404 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('rejects malformed tokens and pages', async () => {
    for (const reply of ['', '<html><body>Error</body></html>', 'short', `${TOKEN}=`, `${TOKEN} ${TOKEN}`]) {
      await expect(carrier(site(undefined, () => html(reply))).track({ number: NUMBER }), reply).rejects.toMatchObject({ kind: 'schema' });
    }
    await expect(carrier(site(() => html('<html><title>Franch Express</title></html>'))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    for (const body of [
      edited('delivered', (text) => text.replace('Mar 05, 2026 08:09 PM', 'Mar 32, 2026 08:09 PM')),
      edited('delivered', (text) => text.replace('Mar 05, 2026 08:09 PM', 'Mar 05, 2026 20:09')),
      edited('delivered', (text) => text.replace('Mar 05, 2026 08:09 PM', '05-03-2026 20:09')),
      edited('delivered', (text) => text.replace('<h4 class="tracking-title m-b-0">Received at Hub</h4>', '<h4 class="tracking-title m-b-0"> </h4>')),
      edited('delivered', (text) => text.replace('<h4 class="tracking-title m-b-0">Received at Hub</h4>', '')),
    ]) expect(() => parseFranchExpress(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses numbers the tracker does not take before any request', async () => {
    const fetcher = site();
    for (const number of ['', '1234567890', '123456789012', 'A2345678901', '12345678901,00000000000', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFranchExpressNumber('123-4067-8902')).toBe(NUMBER);
  });

  it('tries once more after a network failure', async () => {
    const answers = site();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(answers);
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([FRANCH_EXPRESS_LOOKUP, FRANCH_EXPRESS_LOOKUP, `${FRANCH_EXPRESS_RESULT}?data=${TOKEN}`]);
  });

  it('ends a hanging lookup inside the caller’s budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('routes a number filed under Franch Express to the adapter, and leaves eleven digits to the caller', async () => {
    const answer = await createTracker({ fetcher: site(() => html(page('delivered'))), providers: [], env: {} })
      .track({ number: NUMBER, carrier: 'franch-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'franch-express', source: 'franch-express', result: { current_stage: 'delivered' } });
    expect(carrier(site()).recognize).toBeUndefined();
    for (const number of [NUMBER, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('franch-express');
      expect(recognitionAskedCarriers(number), number).not.toContain('franch-express');
    }
  });
});

describe('Franch Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      if (!entry.stage) continue;
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(franchExpressStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'franch-express', providerCode: null, description: 'Received at Hub' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(franchExpressStage('RTO Delivered')?.stage).toBe('returned');
    expect(franchExpressStage('RTO In Transit')?.stage).toBe('exception');
    expect(statusMapAnswer({ carrier: 'franch-express', providerCode: null, description: 'SAMPLE NOTE' })).toEqual({ kind: 'unknown' });
  });
});
