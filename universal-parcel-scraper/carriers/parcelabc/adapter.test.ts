import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, parcelAbcTrackingUrl } from './adapter.js';
import { normalizeParcelAbcNumber, parseParcelAbc, parseParcelAbcHome } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'GBDE900000017';
const TRANSIT = 'GBIT900000028';
const UNKNOWN = 'GBES900000039';
const SESSION = 'PHPSESSID=syntheticsession0000';
const BALANCER = 'AWSALB=SyntheticBalancer+aaaa/bbbb==';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const redirect = (location = 'https://www.parcelabc.com/', cookies = [`${BALANCER}; Expires=Sat, 07 Nov 2026 16:00:00 GMT; Path=/`,
  `${SESSION}; path=/; secure; HttpOnly`]) => {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
};
const carrier = (fetcher: typeof fetch, userAgent?: string) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent });
const rows = (result: ReturnType<typeof parseParcelAbc>) => result.events!.map(({ local_time, description, location, stage }) => [local_time, description, location, stage]);
/** The delivered order with its second parcel's delivery replaced by a scan in transit. */
const splitOrder = () => {
  const page = text('delivered.html');
  const second = page.indexOf('#2');
  return page.slice(0, second) + page.slice(second).replace(/14 05 2026 11:42([\s\S]*?)Delivered" ([\s\S]*?)alt="Delivered" \/><\/div> Delivered/,
    '14 05 2026 09:30$1In transit" $2alt="In transit" /></div> In transit');
};

describe('ParcelABC order codes', () => {
  it('takes four letters and nine digits, with or without the hyphen, and asks with it', () => {
    expect(normalizeParcelAbcNumber(' gbde-900000017 ')).toBe(DELIVERED);
    expect(parcelAbcTrackingUrl(DELIVERED)).toBe('https://www.parcelabc.com/track/GBDE-900000017');
    for (const other of ['GBD900000017', 'GBDE90000001', 'GBDE9000000171', '1234900000017', 'GBDE-90000001X', 'X'.repeat(70)]) {
      expect(() => normalizeParcelAbcNumber(other), other).toThrow('four letters and nine digits');
    }
  });

  it('leaves the shape to the user, which other networks share, and reads a link to the tracking page', () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('parcelabc');
    expect(parseTrackingInput(parcelAbcTrackingUrl(DELIVERED))).toMatchObject({ carrier: 'parcelabc' });
  });
});

describe('ParcelABC tracking adapter', () => {
  it('asks the tracking page once with the hyphen, the host\'s User-Agent and no session', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(text('delivered.html')));
    await expect(carrier(fetcher, 'SyntheticHost/1.0').track({ number: DELIVERED.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.parcelabc.com/track/GBDE-900000017');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(carrier(fetcher)).toMatchObject({ id: 'parcelabc', recordsSteps: true, steps: ['direct', 'retry'] });
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('reads a delivered order of two parcels: their shared rows once, on wall clocks, without who took it or contact details', () => {
    const result = parseParcelAbc(text('delivered.html'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered: Delivered to the front door', last_update: null, last_update_local: '2026-05-14T11:42:00', expected_delivery: null,
    });
    expect(rows(result)).toEqual([
      ['2026-05-14T11:42:00', 'Delivered: Delivered to the front door', 'Example Town', 'delivered'],
      ['2026-05-14T07:15:00', 'In transit: Out for delivery, driver phone', undefined, 'in_transit'],
      ['2026-05-13T22:03:00', 'Arrived at a transit hub: Arrived at Facility', 'Example Hub', 'in_transit'],
      // A row one parcel lists twice stays twice, as the page shows it.
      ['2026-05-13T05:10:00', 'In transit: Departed from Facility', undefined, 'in_transit'],
      ['2026-05-13T05:10:00', 'In transit: Departed from Facility', undefined, 'in_transit'],
      ['2026-05-12T16:20:00', 'Picked up: Pickup Scan', undefined, 'accepted'],
      ['2026-05-12T09:05:00', 'Carrier notified: Collection reference: 7Q3K9X2M1', undefined, 'registered'],
      ['2026-05-11T18:40:00', 'More information required', undefined, 'exception'],
      ['2026-05-11T18:31:00', 'Info received', undefined, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|EX1|07700|Synthetic|#1/);
  });

  it('keeps an order of several parcels where its least advanced parcel is', () => {
    const result = parseParcelAbc(splitOrder(), DELIVERED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In transit: Delivered to the front door',
      last_update_local: '2026-05-14T09:30:00' });
    expect(rows(result).slice(0, 3).map(([time, , , stage]) => [time, stage])).toEqual([
      ['2026-05-14T11:42:00', 'delivered'], ['2026-05-14T09:30:00', 'in_transit'], ['2026-05-14T07:15:00', 'in_transit'],
    ]);
    expect(result.events).toHaveLength(10);
  });

  it('reads an order in transit, whose newest note moves nothing', () => {
    const result = parseParcelAbc(text('in-transit.html'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Information: Contact us at', last_update_local: '2026-07-03T10:12:00' });
    expect(rows(result).map(([time, description, , stage]) => [time, description, stage])).toEqual([
      ['2026-07-03T10:12:00', 'Information: Contact us at', 'pending'],
      ['2026-07-02T21:48:00', 'In transit: Departed from Facility', 'in_transit'],
      ['2026-07-02T14:06:00', 'Arrived at a transit hub: Pickup Scan', 'in_transit'],
      ['2026-07-01T16:30:00', 'Carrier notified', 'registered'],
      ['2026-07-01T16:25:00', 'Info received', 'registered'],
    ]);
  });

  it('reads an unknown code by the notice its redirect leaves in the new session', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockResolvedValueOnce(html(text('not-found.html')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://www.parcelabc.com/');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(init!.headers).get('cookie')).toBe(`${BALANCER}; ${SESSION}`);
  });

  it('leaves any other redirect or home page open, without the session in the failure', async () => {
    const first: [Response, string][] = [
      [redirect('https://www.parcelabc.com/login'), 'transport'],
      [redirect('https://www.parcelabc.com/', [`${BALANCER}; Path=/`]), 'indeterminate'],
    ];
    for (const [response, kind] of first) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(carrier(fetcher).track({ number: UNKNOWN }), kind).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const homes: [Response, string][] = [
      [html(text('not-found.html').replace('is not valid', 'could not be checked')), 'indeterminate'],
      [html(text('not-found.html').replace(/<div id="flashes">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '')), 'indeterminate'],
      [redirect(), 'indeterminate'],
      [html('<html><title>403 Forbidden</title></html>', 403), 'challenge'],
      [html('Busy', 429), 'rate_limited'],
      [html('<html><head><script>window.gokuProps = {}</script></head></html>'), 'challenge'],
    ];
    for (const [response, kind] of homes) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockResolvedValueOnce(response);
      const error = await carrier(fetcher).track({ number: UNKNOWN }).catch((caught: unknown) => caught);
      expect(error, kind).toMatchObject({ kind });
      expect((error as { request?: unknown }).request).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('syntheticsession');
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    expect(() => parseParcelAbcHome(text('not-found.html'))).toThrow('no order under this code');
  });

  it('reads a block page as a challenge, a rate limit as such, and a moved page or reply as no answer', async () => {
    const cases: [Response, string][] = [
      [html('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [html('<html><title>403 Forbidden</title></html>', 403), 'challenge'],
      [html('Too many requests', 429), 'rate_limited'],
      [html('Not Found', 404), 'transport'],
      [html('<html><body>Synthetic maintenance</body></html>'), 'schema'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(carrier(fetcher).track({ number: DELIVERED }), kind).rejects.toMatchObject({ kind });
    }
    const page = text('in-transit.html');
    expect(() => parseParcelAbc(page.replace('03 07 2026 10:12', '2026-07-03 10:12'), TRANSIT)).toThrow('invalid scan time');
    expect(() => parseParcelAbc(page.replace('03 07 2026 10:12', '31 02 2026 10:12'), TRANSIT)).toThrow('invalid scan time');
    expect(() => parseParcelAbc(page.replace('<td class="col-xs-7 tac visible-lg">', ''), TRANSIT)).toThrow('invalid scan');
    expect(() => parseParcelAbc(page.replace('Track your order - "GBIT-900000028"', 'Track your order'), TRANSIT)).toThrow('without the order code');
    expect(() => parseParcelAbc(page.replace('class="statuses-wrapper"', 'class="other"'), TRANSIT)).toThrow('without its history');
    expect(() => parseParcelAbc(page.replaceAll('<div class="visible-lg">', '<div class="wide">'), TRANSIT)).toThrow('unexpected history');
    expect(() => parseParcelAbc(page.replace(/<div class="status-wrapper[\s\S]*<\/table>\s*<\/div>\s*<\/div>/, ''), TRANSIT)).toThrow('no history');
  });

  it('refuses an answer for another code', () => {
    expect(() => parseParcelAbc(text('in-transit.html'), DELIVERED)).toThrow('another code');
    expect(() => parseParcelAbc(text('in-transit.html'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes ParcelABC order codes only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['GBD900000017', '1234567890123', 'GBDE9000000', 'X'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends the lookup once more after a network failure, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(html(text('in-transit.html')));
    await expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('maps every status by its label, with or without the comment after it, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(`${entry.wording}: Synthetic comment`)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'parcelabc', providerCode: null, description: 'Attempt Fail: The receiver refused the delivery.' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'parcelabc', providerCode: null, description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
  });
});
