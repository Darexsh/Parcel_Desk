import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CARRIERS } from '../../core/catalog/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NOEST_TRACKING, NoestTracker } from './adapter.js';
import { noestRequestNumber } from './number.js';
import { noestFormToken, parseNoest } from './parser.js';
import { noestStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ABC-123-12345678';
const IN_TRANSIT = 'ABC-ABC-00000000';
const UNKNOWN = 'ABC-000-00000000';
const TOKEN = `SyntheticFormToken${'0'.repeat(22)}`;
const SESSION = 'noest_express_session=eyJpdiI6IlN5bnRoZXRpYyJ9%3D';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const page = () => html(fixture('page'), { headers: { 'Set-Cookie': `${SESSION}; expires=Sun, 01 Mar 2026 10:00:00 GMT; Max-Age=7200; path=/; httponly; samesite=lax` } });
/** The page, then the given answer to the form. */
const flow = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async (_url, init) => (init?.method === 'POST' ? answer() : page()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('NOEST HTTP adapter', () => {
  it('reads the page’s token and session, then posts the one number with them, through the supplied transport', async () => {
    const fetcher = flow(() => html(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NoestTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' abc12312345678 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [formUrl, formInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([String(pageUrl), String(formUrl)]).toEqual([NOEST_TRACKING, NOEST_TRACKING]);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(formInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: SESSION, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(formInit.body)))).toEqual({ _token: TOKEN, tracking: DELIVERED });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'noest', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, in Algerian time, without the notes or who acted', () => {
    const result = parseNoest(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Montant transmis au partenaire', last_update: '2026-03-09T10:00:00+01:00',
      delivered_at: '2026-03-04T11:45:27+01:00', expected_delivery: null,
    });
    expect(result.events).toHaveLength(10);
    expect(result.events!.slice(0, 4)).toEqual([
      { time: '2026-03-09T10:00:00+01:00', description: 'Montant transmis au partenaire' },
      { time: '2026-03-04T11:45:27+01:00', description: 'Livré', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-03-04T09:10:00+01:00', description: 'En livraison', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-03-03T14:02:19+01:00', description: 'Tentative de livraison', stage: 'failed_attempt', stage_source: 'carrier_map' },
    ]);
    // Two rows of one second keep the page's order, turned round.
    expect(result.events!.slice(4, 6).map((event) => event.description)).toEqual(['En livraison', 'Enlevé par le livreur']);
    expect(result.events!.at(-1)).toEqual({ time: '2026-03-02T09:15:00+01:00', description: 'Uploadé sur le système',
      stage: 'registered', stage_source: 'carrier_map' });
    const text = JSON.stringify(result);
    for (const dropped of ['Livreur Exemple', 'injoignable', 'PARTENAIRE', 'NOEST']) expect(text).not.toContain(dropped);
  });

  it('reads a parcel received at a hub as in transit', () => {
    const result = parseNoest(fixture('in-transit'), 'abc abc 00000000');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Reception validé',
      last_update: '2026-03-03T07:48:30+01:00' });
    expect(result.events!.map((event) => event.stage)).toEqual(['in_transit', 'accepted', 'registered', 'registered']);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps a wording no rule reads without a stage, and a box without events as no history', () => {
    const unread = parseNoest(fixture('in-transit').replace('Reception validé', 'Xyzzy'), IN_TRANSIT);
    expect(unread).toMatchObject({ current_stage: 'accepted', last_status_text: 'Xyzzy' });
    expect(unread.events![0]).toEqual({ time: '2026-03-03T07:48:30+01:00', description: 'Xyzzy' });
    const empty = fixture('in-transit').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(() => parseNoest(empty, IN_TRANSIT)).toThrow(NoHistoryError);
  });

  it('reads the form showing the number back without a box as not found, and nothing else', async () => {
    expect(() => parseNoest(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The form without the number asked, or the empty page, is no answer about it.
    expect(() => parseNoest(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseNoest(fixture('page'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    await expect(carrier(flow(() => html(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('binds the answer to the box for the whole number asked', () => {
    // A box for another number is no answer about the one asked.
    expect(() => parseNoest(fixture('delivered'), 'ABC-123-12345670')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseNoest(fixture('delivered').replace(`<span>\n                                ${DELIVERED}`,
      `<span>\n                                ${DELIVERED.toLowerCase()}`), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const box = /<div class="border bg-white[\s\S]*?<\/table>\s*<\/div>\n/.exec(fixture('in-transit'))![0];
    const twice = fixture('in-transit').replace(box, `${box}${box}`);
    expect(() => parseNoest(twice, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = fixture('delivered').replace(/(<div class="col-12">\n)/, `$1${box}`);
    expect(parseNoest(other, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('refuses a changed page, table or clock', () => {
    expect(() => parseNoest('<html><body><h1>NOEST</h1></body></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseNoest(fixture('delivered').replace('Date et heure', 'Heure'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseNoest(fixture('delivered').replace('<td>2026-03-04 11:45:27</td>', ''), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const clock of ['2026-02-30 11:45:27', '2026-03-04 24:00:00', '04/03/2026 11:45', '2026-03-04']) {
      expect(() => parseNoest(fixture('delivered').replace('2026-03-04 11:45:27', clock), DELIVERED), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseNoest(fixture('delivered').replace('\n                                            Livré\n', '\n'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseNoest(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits, moved routes and a refused session apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(flow(answer)).track({ number: DELIVERED });
    await expect(lookup(() => html(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Too Many Requests', { status: 429, headers: { 'Retry-After': '60' } })))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('<title>Page Expired</title>', { status: 419 })))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://app.noest-dz.com/login' } })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('leaves the session cookie and form token out of a failed lookup', async () => {
    const failure = await carrier(flow(() => html('Server Error', { status: 500 }))).track({ number: DELIVERED }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(JSON.stringify(failure)).not.toMatch(/noest_express_session|SyntheticFormToken/);
    expect(failure).toMatchObject({ status: 500, diagnostics: undefined, request: undefined });
  });

  it('needs the page’s form token and session before it posts', async () => {
    const without = (first: Response) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first);
      return { fetcher, lookup: carrier(fetcher).track({ number: DELIVERED }) };
    };
    const noSession = without(html(fixture('page')));
    await expect(noSession.lookup).rejects.toMatchObject({ kind: 'schema' });
    const noToken = without(html(fixture('page').replace(/name="_token" value="[^"]*"/, 'name="_token" value=""'),
      { headers: { 'Set-Cookie': `${SESSION}; path=/` } }));
    await expect(noToken.lookup).rejects.toMatchObject({ kind: 'schema' });
    const blocked = without(html(CHALLENGE));
    await expect(blocked.lookup).rejects.toMatchObject({ kind: 'challenge' });
    const moved = without(html('', { status: 301, headers: { Location: 'https://noest-dz.com/' } }));
    await expect(moved.lookup).rejects.toMatchObject({ kind: 'transport' });
    for (const { fetcher } of [noSession, noToken, blocked, moved]) expect(fetcher).toHaveBeenCalledTimes(1);
    expect(noestFormToken(fixture('page'))).toBe(TOKEN);
  });

  it('starts again with a new page once when NOEST cannot be reached', async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return init?.method === 'POST' ? html(fixture('delivered')) : page();
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new NoestTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST']);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
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

  it('rejects numbers NOEST does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'AB-123-12345678', 'ABC-123-1234567', 'ABC-123-123456789', '1BC-123-12345678', 'ABC-12-12345678', 'ABC-123-1234567A',
      `ABC-123-${'0'.repeat(70)}`, 'ABC-123-1234567é']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known number with its last instant and an unknown one as unknown, and asks nothing for a number NOEST does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => page()).mockResolvedValueOnce(html(fixture('delivered')))
      .mockImplementationOnce(async () => page()).mockResolvedValueOnce(html(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-09T09:00:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ABC-123-1234567')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('answers a number filed under NOEST', async () => {
    const fetcher = flow(() => html(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: 'ABC12312345678', carrier: 'noest' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'noest', source: 'noest', result: { current_stage: 'delivered' } });
    expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)).get('tracking')).toBe(DELIVERED);
  });
});

describe('NOEST numbers and links', () => {
  it('puts the hyphens back between the three blocks, since the tracker finds a number only with them', () => {
    for (const number of [DELIVERED, 'abc12312345678', 'ABC 123 12345678', 'ABC-12312345678']) expect(noestRequestNumber(number)).toBe(DELIVERED);
    expect(noestRequestNumber('abc-abc-00000000')).toBe(IN_TRANSIT);
  });

  it('claims no number, so recognition never offers NOEST', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('noest');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id), number).not.toContain('noest');
    }
  });

  it('links to the page for one number, and reads that page’s address back', () => {
    expect(CARRIERS.noest.trackingUrl?.(DELIVERED)).toBe(`https://app.noest-dz.com/list/t/${DELIVERED}`);
    for (const url of [`https://app.noest-dz.com/list/t/${DELIVERED}`, `https://app.noest-dz.com/tracking/${DELIVERED}`]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: DELIVERED, carrier: 'noest' });
    }
  });
});

describe('NOEST status vocabulary', () => {
  it('stages every recorded wording as the map does, and leaves the bookkeeping ones out on purpose', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(noestStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'noest', description: entry.wording }), entry.wording)
          .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        continue;
      }
      expect(noestStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'noest', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('livre', 'livré')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'noest', description: 'Pick-Up collecté' })).toEqual({ kind: 'unknown' });
  });
});
