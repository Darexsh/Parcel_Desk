import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LeopardsTracker } from './adapter.js';
import { LEOPARDS_LOOKUP, LEOPARDS_VIEW, normalizeLeopardsNumber, parseLeopards, readLeopardsLookup } from './parser.js';
import { leopardsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'ZZ0000000011';
const IN_TRANSIT = 'ZZ0000000022';
const PENDING = 'ZZ0000000033';
const UNKNOWN = 'ZZ0000000044';
const SESSION = 'leopards_official_session=syntheticSession';
const FOUND = '{"success":true}';

type Details = { request?: unknown; diagnostics?: unknown };

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const json = (body: string) => new Response(body, { headers: [['content-type', 'application/json'],
  ['set-cookie', 'XSRF-TOKEN=syntheticXsrf; path=/; samesite=lax'], ['set-cookie', `${SESSION}; path=/; httponly; samesite=lax`]] });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseLeopards>) =>
  result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage ?? null]);

interface Site {
  lookup?: (number: string) => Response | Promise<Response>;
  view?: (cookie: string | null) => Response | Promise<Response>;
}

/** Leopards' site: the lookup keeps a known consignment in a new session, and the tracking page shows it. */
function site({ lookup, view }: Site = {}) {
  let kept = '';
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` === LEOPARDS_LOOKUP) {
      const number = url.searchParams.get('cn_number')!;
      kept = number;
      if (lookup) return lookup(number);
      return number === UNKNOWN ? html(page('not-found')) : json(FOUND);
    }
    const cookie = new Headers(init?.headers).get('cookie');
    if (view) return view(cookie);
    const name = { [DELIVERED]: 'delivered', [IN_TRANSIT]: 'in-transit', [PENDING]: 'pending' }[kept];
    return html(cookie === SESSION && name ? page(name) : page('not-found').replaceAll(UNKNOWN, ''));
  });
}

describe('Leopards HTTP adapter', () => {
  it('looks the whole number up and reads the tracking page in the session the lookup opened, through the supplied transport', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LeopardsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 0000-000-022 ', { budgetMs: 2000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[lookupUrl, lookupInit], [viewUrl, viewInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(lookupUrl).toBe(`${LEOPARDS_LOOKUP}?cn_number=${IN_TRANSIT}`);
    expect(lookupInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'X-Requested-With': 'XMLHttpRequest' } });
    expect(new Headers(lookupInit.headers).has('cookie')).toBe(false);
    expect(viewUrl).toBe(LEOPARDS_VIEW);
    // Only the session cookie goes back.
    expect(viewInit).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0', Cookie: SESSION } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'leopards-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery in Karachi time with its cities, without who took the parcel, and a repeated scan once', () => {
    const result = parseLeopards(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered at SOUTHPORT', last_update: '2026-03-14T16:40:00+05:00', expected_delivery: null,
      delivered_at: '2026-03-14T16:40:00+05:00' });
    expect(rows(result)).toEqual([
      ['2026-03-14T16:40:00+05:00', 'Delivered at SOUTHPORT', 'SOUTHPORT', 'delivered'],
      ['2026-03-14T11:05:00+05:00', 'Assigned to Leopards in SOUTHPORT', 'SOUTHPORT', 'out_for_delivery'],
      ['2026-03-12T21:15:00+05:00', 'Inter Transfer at NORTHVILLE', 'NORTHVILLE', 'in_transit'],
    ]);
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/FICTIVE|SIGNER|STAFF|~/);
  });

  it('keeps only the wording before the city when the receiver is not the signatory the page names', () => {
    const unsigned = parseLeopards(page('delivered').replace('FICTIVE SIGNER - ', ''), DELIVERED);
    expect(unsigned.events![0]).toEqual({ time: '2026-03-14T16:40:00+05:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    const other = parseLeopards(page('delivered').replace('FICTIVE SIGNER - ', 'ANOTHER PERSON - '), DELIVERED);
    expect(other).toMatchObject({ last_status_text: 'Delivered', delivered_at: '2026-03-14T16:40:00+05:00' });
    // Without a city, only the first word is kept.
    const placeless = parseLeopards(page('delivered').replace('Delivered at SOUTHPORT FICTIVE SIGNER ~ STAFF \n',
      'Delivered FICTIVE SIGNER ~ SELF \n'), DELIVERED);
    expect(placeless.events![0]).toMatchObject({ description: 'Delivered', stage: 'delivered' });
    for (const result of [unsigned, other, placeless]) expect(JSON.stringify(result)).not.toMatch(/FICTIVE|SIGNER|ANOTHER|PERSON|STAFF|SELF/);
  });

  it('reads a consignment on its way without its booking details', () => {
    const result = parseLeopards(page('in-transit'), IN_TRANSIT);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Inter Transfer at NORTHVILLE', last_update: '2026-04-10T02:30:00+05:00', expected_delivery: null, events: [
        { time: '2026-04-10T02:30:00+05:00', description: 'Inter Transfer at NORTHVILLE', location: 'NORTHVILLE', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-09T18:45:00+05:00', description: 'Shipment Picked in NORTHVILLE', location: 'NORTHVILLE', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|FICTIVE|ORDER-0001|SOUTHPORT/);
  });

  it('reads a delivery left pending for its reason', () => {
    const result = parseLeopards(page('pending'), PENDING);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Pending WRONG/INCORRECT ADDRESS' });
    expect(result.events![0]).toEqual({ time: '2026-05-06T19:20:00+05:00', description: 'Pending WRONG/INCORRECT ADDRESS',
      stage: 'failed_attempt', stage_source: 'carrier_map' });
  });

  it('takes nine digits as the tracker does, with a leading zero', async () => {
    expect(normalizeLeopardsNumber('zz-000-000-011')).toBe(DELIVERED);
    expect(normalizeLeopardsNumber('ZZ000000011')).toBe(DELIVERED);
    const fetcher = site();
    await expect(carrier(fetcher).track({ number: 'ZZ000000011' })).resolves.toMatchObject({ status: 'delivered',
      canonical_tracking_number: DELIVERED });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${LEOPARDS_LOOKUP}?cn_number=${DELIVERED}`);
  });

  it('reads the site’s notice for the whole number as not found, and other answers as inconclusive', async () => {
    expect(() => readLeopardsLookup(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => readLeopardsLookup(FOUND, UNKNOWN)).not.toThrow();
    expect(() => readLeopardsLookup(page('not-found'), 'ZZ0000000045'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Leopards answered for another consignment' }));
    expect(() => readLeopardsLookup('{"success":false}', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(site()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A page for another consignment, or the page without the session's consignment, says nothing about this one.
    expect(() => parseLeopards(page('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Leopards answered for another consignment' }));
    await expect(carrier(site({ view: () => html(page('not-found').replaceAll(UNKNOWN, '')) })).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(carrier(site({ lookup: () => new Response(FOUND, { headers: { 'Content-Type': 'application/json' } }) })).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
  });

  it('keeps a moved route, a bot check and a broken reply apart from a missing consignment', async () => {
    const lookup = (reply: () => Response) => carrier(site({ lookup: reply })).track({ number: DELIVERED });
    const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>';
    await expect(lookup(() => html(challenge))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site({ view: () => html(challenge) })).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('<!DOCTYPE html><html><head><title>Leopards</title></head><body>Welcome</body></html>')))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(site({ view: () => html('<html><body>Maintenance</body></html>') })).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('{"success":'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('{"status":1}'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://pk.leopardscourier.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site({ view: () => html('', { status: 302, headers: { Location: '/' } }) })).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('rejects a changed tracking page', () => {
    const delivered = page('delivered');
    for (const [index, body] of [
      delivered.replace('14 March, 2026\n', '31 February, 2026\n'),
      delivered.replace('14 March, 2026\n', '2026-03-14\n'),
      delivered.replace('<span>(16:40)</span>', '<span>16:40</span>'),
      delivered.replace('<span>(16:40)</span>', '<span>(24:00)</span>'),
      delivered.replace('<span>(16:40)</span>', ''),
      delivered.replace('Inter Transfer at NORTHVILLE  ', ' '),
      delivered.replace('<div class="tracking-content">', '<div class="tracking-text">'),
      delivered.replace('Consignment No. : ZZ0000000011', 'Consignment No. : ZZ0000000011</td><td>Consignment No. : ZZ0000000011'),
      delivered.replace(/<div class="tracking-list">[\s\S]*<\/div>\n/, (list) => list.repeat(301)),
    ].entries()) {
      expect(() => parseLeopards(body, DELIVERED), `change ${index}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLeopards(delivered.replace(/<div class="tracking-list">[\s\S]*<\/div>\n/, ''), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without the session', async (status, kind) => {
      const fetcher = site({ view: () => new Response('', { status }) });
      const failure = await carrier(fetcher).track({ number: DELIVERED }).catch((error: unknown) => error as Details);
      expect(failure).toMatchObject({ kind, status });
      expect(failure.request).toBeUndefined();
      expect(failure.diagnostics).toBeUndefined();
      await expect(carrier(site({ lookup: () => new Response('', { status }) })).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('recognizes a consignment with scans, and neither an unknown one nor a number Leopards does not issue', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-14T11:40:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ZZ00000000111')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Leopards does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000011', 'Z0000000011', 'ZZ00000011', 'ZZ00000000111', 'ZZ000000001O', '1Z0000000011', 'Z'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Leopards to the adapter', async () => {
    const fetcher = site();
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'leopards-courier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'leopards-courier', source: 'leopards-courier', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(LEOPARDS_LOOKUP))).toBe(true);
  });
});

describe('Leopards status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(leopardsStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'leopards-courier', providerCode: null, description: 'Inter Transfer at MIDHUB' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'leopards-courier', providerCode: null, description: 'Synthetic checkpoint' })).toEqual({ kind: 'unknown' });
    // A wording the map does not know falls to the shared wording rules.
    expect(leopardsStage('Returned to shipper')).toMatchObject({ stage: 'returned', source: expect.stringMatching(/^wording:/) });
    expect(leopardsStage('Synthetic checkpoint')).toBeNull();
  });
});
