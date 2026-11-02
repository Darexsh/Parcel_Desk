import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BookurierTracker } from './adapter.js';
import { BOOKURIER_API, BOOKURIER_PAGE, normalizeBookurierNumber, parseBookurier, readBookurierToken } from './parser.js';
import { bookurierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'BOK9000001';
const IN_TRANSIT = 'BOK9000002';
const UNKNOWN = 'BOK9000009';
const TOKEN = 'a'.repeat(64);
const SESSION = 'ci_session=syntheticsession0000000000000000000000';

type Row = Record<string, unknown>;
type Reply = Row & { events: Row[] };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const edited = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// The lookup answers JSON under an HTML content type.
const reply = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const page = (body = text('page.html'), cookies = [`${SESSION}; expires=Thu, 01-Jan-2099 00:00:00 GMT; Max-Age=7200; path=/; HttpOnly; SameSite=Lax`]) =>
  new Response(body, { status: 200, headers: [['Content-Type', 'text/html; charset=UTF-8'], ...cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
const lookupUrl = (number: string) => `${BOOKURIER_API}?awb=${number}&_token=${TOKEN}`;
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

/** Bookurier's tracker: the page opens a session, and the lookup answers each number from its fixture. */
function site(lookup: (number: string) => Response | Promise<Response> = (number) =>
  reply(number === DELIVERED ? text('delivered.json') : number === IN_TRANSIT ? text('in-transit.json') : text('not-found.json')),
open: () => Response = () => page()) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === BOOKURIER_PAGE) return open();
    return lookup(new URL(url).searchParams.get('awb')!);
  });
}

describe('Bookurier tracking adapter', () => {
  it('opens the tracking page, then asks its lookup with the page’s token in its session, through the supplied transport', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BookurierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bok 900-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe(BOOKURIER_PAGE);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(lookupUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'X-Track-Token': TOKEN, Cookie: SESSION, 'User-Agent': 'SyntheticHost/1.0', Referer: BOOKURIER_PAGE } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bookurier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, dating every scan in Romania and dropping the repeated depot scan', () => {
    const result = parseBookurier(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Livrat', last_update: '2026-02-11T15:27:08+02:00', expected_delivery: null,
      delivered_at: '2026-02-11T15:27:08+02:00', weight_kg: 3.5 });
    expect(result.events!.map((event) => [event.time, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-02-11T15:27:08+02:00', 'Livrat', 'delivered', 'delivered'],
      ['2026-02-11T10:01:40+02:00', 'In masina spre livrare', 'out_for_delivery', 'out_for_delivery'],
      ['2026-02-11T08:50:33+02:00', 'Intrare in depozit', 'in_transit', 'in_transit'],
      // Bookurier files the assignment under out for delivery; nothing has moved yet.
      ['2026-02-10T18:13:26+02:00', 'Repartizata', 'out_for_delivery', 'registered'],
      ['2026-02-10T13:10:06+02:00', 'Comanda noua', 'order_placed', 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2026-02-11T15:27:08+02:00', location: 'BRASOV', description: 'Livrat',
      provider_code: 'delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    // The masked recipient, their town, the sender and the reply's next token stay out.
    expect(JSON.stringify(result)).not.toMatch(/S\*+|Brasov|EXEMPLU|bbbbbbbb/);
  });

  it('reads a parcel in transit, dating a repeated hour as its first occurrence', async () => {
    const result = await carrier(site()).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Intrare in depozit',
      last_update: '2026-10-25T03:30:00+03:00', weight_kg: 1 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.stage])).toEqual([
      ['2026-10-25T03:30:00+03:00', 'SIBIU', 'in_transit'],
      ['2026-10-24T23:05:12+03:00', 'Romania', 'registered'],
      ['2026-10-24T16:40:51+03:00', null, 'registered'],
      ['2026-10-24T11:02:37+03:00', null, 'registered'],
    ]);
  });

  it('takes the summary’s word for a returned parcel and leaves a scan whose code it does not know without a stage', () => {
    const result = parseBookurier(edited('in-transit', (reply) => {
      reply.is_returned = true;
      reply.events[0]!.status_code = 'synthetic_code';
      reply.events[0]!.status = 'Scanare sintetica';
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(result.events![0]).toEqual({ time: '2026-10-25T03:30:00+03:00', location: 'SIBIU', description: 'Scanare sintetica',
      provider_code: 'synthetic_code' });
  });

  it('reads the tracker’s own not-found answer as not found', async () => {
    await expect(carrier(site()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseBookurier({ success: false, message: 'Eroare temporara' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a refused session apart from a missing parcel', async () => {
    await expect(carrier(site(() => reply(text('session-expired.json')))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(carrier(site(() => reply(text('session-expired.json'), 403))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    const withoutCookie = site(undefined, () => page(text('page.html'), []));
    await expect(carrier(withoutCookie).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(withoutCookie).toHaveBeenCalledTimes(1);
  });

  it('reads a bot check in place of the page or the reply, or a bare refusal, as a challenge', async () => {
    const checked = site(undefined, () => page(CHECK));
    await expect(carrier(checked).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    expect(checked).toHaveBeenCalledTimes(1);
    await expect(carrier(site(() => reply(CHECK))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => reply('<html><body>Forbidden</body></html>', 403))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => reply({ success: false, message: 'Acces interzis.' }, 403))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reports a rate limit without the session the request carried', async () => {
    const error = await carrier(site(() => new Response('{"success":false,"message":"Prea multe cereri."}', { status: 429,
      headers: { 'Retry-After': '30' } }))).track({ number: DELIVERED }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect((error as { request?: unknown; diagnostics?: unknown }).request).toBeUndefined();
    expect((error as { request?: unknown; diagnostics?: unknown }).diagnostics).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('syntheticsession');
  });

  it('rejects malformed replies and pages', async () => {
    await expect(carrier(site(() => reply('<html><body>Eroare</body></html>'))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(site(undefined, () => page('<html><title>Bookurier</title></html>'))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'schema' });
    for (const payload of [
      null,
      { awb: DELIVERED },
      edited('delivered', (reply) => { delete reply.awb; }),
      edited('delivered', (reply) => { reply.events = {} as Row[]; }),
      edited('delivered', (reply) => { reply.events[0]!.date = '11.02.2026 15:27'; }),
      edited('delivered', (reply) => { reply.events[0]!.date = '2026-02-30 15:27:08'; }),
      edited('delivered', (reply) => { reply.events[0]!.status = 42; }),
      edited('delivered', (reply) => { reply.events[0]!.status = ''; reply.events[0]!.status_unified = ''; }),
      edited('delivered', (reply) => { reply.events.push('Livrat' as unknown as Row); }),
    ]) expect(() => parseBookurier(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => readBookurierToken('<html></html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(readBookurierToken(text('page.html'))).toBe(TOKEN);
  });

  it('binds the reply to the whole number asked and needs a history', () => {
    expect(() => parseBookurier(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBookurier(edited('delivered', (reply) => { reply.awb = 'BOK90000011'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBookurier(edited('delivered', (reply) => { reply.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseBookurier(edited('delivered', (reply) => { reply.awb = 'bok9000001'; }), DELIVERED).current_stage).toBe('delivered');
  });

  it('refuses numbers Bookurier does not issue before any request, its partners’ included', async () => {
    const fetcher = site();
    for (const number of ['BOK123456', 'BOK12345678', 'BOX1234567', '062000000000', '1BOK000000000', 'ZZ000000000']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBookurierNumber(' bok-900 0001 ')).toBe(DELIVERED);
  });

  it('routes a BOK waybill to the adapter, which detection settles without recognition, and reads the tracker link', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'bookurier', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)).toEqual([]);
    expect(parseTrackingInput(`https://t.bookurier.ro/?awb=${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'bookurier' });
    const tracker = createTracker({ fetcher: site(), providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bookurier', source: 'bookurier', result: { current_stage: 'delivered' } });
  });
});

type Entry = { code?: string; wording: string; stage?: string };

describe('Bookurier status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries as Entry[]) {
      if (!entry.stage) continue;
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(bookurierStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'bookurier', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'bookurier', providerCode: 'synthetic_code', description: 'Scanare sintetica' })).toEqual({ kind: 'unknown' });
  });
});
