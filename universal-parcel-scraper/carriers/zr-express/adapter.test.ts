import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ZR_EXPRESS_TRACK_URL, ZrExpressTracker } from './adapter.js';
import { parseZrExpress, zrExpressRequestNumber } from './parser.js';
import { statusMap, zrExpressStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '12-345679-ZR';
const IN_TRANSIT = '12-3456789012-ZR';
const UNKNOWN = '00-000000-ZR';
const COMPONENT = 'text/x-component';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.rsc`, import.meta.url), 'utf8');
const bytes = (body: string) => new TextEncoder().encode(body);
const parse = (body: string, number: string, type = COMPONENT) => parseZrExpress(bytes(body), type, number);
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': COMPONENT, ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookupUrl = (number: string) => `${ZR_EXPRESS_TRACK_URL}?tn=${number}`;

describe('ZR Express HTTP adapter', () => {
  it('asks the tracking page for its server components once, with the number in its dashed blocks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ZrExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 123456789012zr ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lookupUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { RSC: '1', Accept: COMPONENT, 'Accept-Language': 'fr', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zr-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, with UTC instants, offices and state codes, and without remarks', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    const sorting = 'Tri Exempleville 12 مركز فرز تجريبي';
    const step = (time: string, description: string, code: string, stage: string, location?: string) =>
      ({ time, description, ...(location ? { location } : {}), provider_code: code, stage, stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Encaissé', last_update: '2026-01-15T07:05:49.848Z',
      // The delivery, not the cash collected the next day.
      delivered_at: '2026-01-14T08:59:44.303Z', expected_delivery: null,
      events: [
        step('2026-01-15T07:05:49.848Z', 'Encaissé', 'encaisse', 'delivered'),
        step('2026-01-14T08:59:44.303Z', 'Livré', 'livre', 'delivered', sorting),
        step('2026-01-14T07:47:56.703Z', 'Sortie en livraison', 'sortie_en_livraison', 'out_for_delivery', sorting),
        step('2026-01-14T07:44:36.672Z', 'En livraison', 'en_livraison', 'in_transit', sorting),
        // Back at the office after a run that did not deliver: still in transit.
        step('2026-01-14T07:06:24.249Z', 'Confirmé au bureau', 'confirme_au_bureau', 'in_transit', sorting),
        step('2026-01-13T07:15:14.771Z', 'Sortie en livraison', 'sortie_en_livraison', 'out_for_delivery', sorting),
        step('2026-01-13T07:12:32.853Z', 'En livraison', 'en_livraison', 'in_transit', sorting),
        step('2026-01-13T06:13:54.724Z', 'Confirmé au bureau', 'confirme_au_bureau', 'in_transit', sorting),
        step('2026-01-12T18:52:25.579Z', 'Dispatch dans une autre wilaya', 'vers_wilaya', 'in_transit'),
        // The first check-in at an office accepts the parcel.
        step('2026-01-12T17:58:58.232Z', 'Confirmé au bureau', 'confirme_au_bureau', 'accepted', 'Hub Exempleville 12 مكتب تجريبي'),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Scanné|confirmed_in|janv\./);
  });

  it('reads a parcel in its delivery stage, whose steps the page renders lazily', () => {
    const result = parse(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'En livraison',
      last_update: '2026-01-13T07:12:32.853Z', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['en_livraison', 'in_transit'], ['confirme_au_bureau', 'in_transit'], ['vers_wilaya', 'in_transit'], ['confirme_au_bureau', 'accepted'],
    ]);
  });

  it('reads the unknown-number box as not found, the format message as invalid input and another number as inconclusive', () => {
    expect(() => parse(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('invalid'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parse(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ZR Express answered for another number' }));
    expect(() => parse(fixture('delivered'), '12-3456789-ZR'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ZR Express answered for another number' }));
    // A longer echo that starts with the number is still another number.
    expect(() => parse(fixture('delivered').replace(`"children":"${DELIVERED}"`, `"children":"${DELIVERED} ${IN_TRANSIT}"`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    const delivered = fixture('delivered');
    for (const body of [
      // The steps are gone, or keyed another way.
      delivered.replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z-([a-z_]+)-(\d+)"/g, '"$1-$2"'),
      // A step without its shown clock.
      delivered.replace(/"\d\d janv\., \d\d:\d\d"/g, '"—"'),
      // A step whose key holds no real instant.
      delivered.replace('2026-01-14T08:59:44.303Z-livre', '2026-01-14T25:59:44.303Z-livre'),
      // No answer box at all.
      delivered.replace(/"className":"chip[^"]*",/g, ''),
      // An unknown number with a history.
      delivered.replace('["● ","ENCAISSÉ"]', '"● INTROUVABLE"'),
      // A truncated text row.
      delivered.slice(0, delivered.indexOf(':T') + 40),
      // Lines that are not Flight rows.
      'not a flight reply\n',
    ]) {
      expect(() => parse(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parse('{"tn":"12-345679-ZR"}', DELIVERED, 'application/json')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse('', DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a failed render as inconclusive and Next’s redirect as a changed route', () => {
    const page = fixture('not-found').replace(/"className":"chip[^"]*",/g, '');
    expect(() => parse(`${page}1f:E{"digest":"1234567890"}\n`, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(`${page}1f:E{"digest":"NEXT_REDIRECT;replace;/suivi;307;"}\n`, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved page, a browser check and an HTML page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // An unknown number is a 200 page naming it: a 404 or a redirect is a moved page.
    await expect(lookup('<html><body>404: This page could not be found.</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 307, headers: { Location: 'https://www.zrexpress.net/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // A web page served instead of the page's components.
    await expect(lookup('<!DOCTYPE html><html><head><title>Checking your browser</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its last instant and the unknown-number box, and asks nothing for a number ZR Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-15T07:05:49.848Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A reply about another parcel is no answer either way.
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('12-34567-ZR')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers ZR Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12-34567-ZR', '12-34567890-ZR', '12-345678-ZZ', '1A-345678-ZR', '12-3456-78-ZR-ZR', `12-${'0'.repeat(70)}-ZR`, '']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(zrExpressRequestNumber('12 345 679 zr')).toBe(DELIVERED);
    expect(zrExpressRequestNumber('12-3456789-zr')).toBe('12-3456789-ZR');
    expect(zrExpressRequestNumber('123456789012ZR')).toBe(IN_TRANSIT);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under ZR Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'zr-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'zr-express', source: 'zr-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([lookupUrl(DELIVERED)]);
  });
});

describe('ZR Express numbers', () => {
  it('takes exactly the dashed numbers zr-express-1 claims', () => {
    for (const number of [DELIVERED, '12-3456789-ZR', IN_TRANSIT]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'zr-express', confidence: 'high' });
      expect(zrExpressRequestNumber(number)).toBe(number);
    }
    for (const number of ['12-34567-ZR', '12-34567890-ZR', '12-345678-ZZ']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('zr-express');
      expect(() => zrExpressRequestNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('ZR Express status vocabulary', () => {
  it('stages every recorded state by its code, a first check-in as accepted and a later one as in transit', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(zrExpressStage(entry.code, entry.wording, false)?.stage, entry.code).toBe(entry.stage);
      if (entry.code !== 'confirme_au_bureau') expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    }
    expect(zrExpressStage('confirme_au_bureau', 'Confirmé au bureau', true)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'zr-express', providerCode: 'livre', description: 'Livré' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    // A check-in's stage depends on the steps before it.
    expect(statusMapAnswer({ carrier: 'zr-express', providerCode: 'confirme_au_bureau', description: 'Confirmé au bureau' })).toEqual({ kind: 'unknown' });
  });
});
