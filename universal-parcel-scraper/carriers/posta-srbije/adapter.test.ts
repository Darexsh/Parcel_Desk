import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTA_SRBIJE_ENDPOINT, PostaSrbijeTracker } from './adapter.js';
import { parsePostaSrbije } from './parser.js';
import { postaSrbijeCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const ABROAD = 'CE900000022RS';
const RETURNED = 'RR900000019RS';
const UNKNOWN = 'ZZ000000014RS';
type Row = Record<string, unknown>;
interface Fixture { Rezultat: number; StrOut: { Kretanja: Row[] | null; [key: string]: unknown } | null; StrRezultat: Row | null }
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture;
// The service sends the history and the notice as JSON text inside its answer.
const encoded = (value: Fixture) => ({ ...value, StrOut: value.StrOut && JSON.stringify(value.StrOut),
  StrRezultat: value.StrRezultat && JSON.stringify(value.StrRezultat) });
const answer = (name: string, change: (rows: Row[], value: Fixture) => void = () => {}) => {
  const value = fixture(name);
  change(value.StrOut?.Kretanja ?? [], value);
  return encoded(value);
};
const json = (name: string) => JSON.stringify(answer(name));
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parsePostaSrbije>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);

describe('Pošta Srbije tracking adapter', () => {
  it('asks the app’s service about the whole number once, with the app’s user, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('abroad')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostaSrbijeTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ce 900 000 022 rs ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(POSTA_SRBIJE_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'SyntheticHost/1.0' } });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ TipSerijalizacije: 2, StrKlijent: expect.any(String), Servis: 111, IdVrstaTranskacije: 63,
      IdTransakcija: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), StrIn: expect.any(String) });
    expect(JSON.parse(String(body.StrKlijent))).toEqual({ Username: 'MAPeN', Password: expect.any(String), Jezik: 'ENG', IdTipUredjaja: 3 });
    expect(JSON.parse(String(body.StrIn))).toEqual({ VrstaUsluge: 1, EksterniBroj: '', PrijemniBroj: ABROAD });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'posta-srbije', step: 'direct', outcome: 'ok' }));
    // Every request is its own transaction.
    await new PostaSrbijeTracker({ fetcher }).fetch(ABROAD);
    const transaction = (call: number) => JSON.parse(String(fetcher.mock.calls[call]![1]?.body)).IdTransakcija;
    expect(transaction(1)).not.toBe(transaction(0));
  });

  it('dates Serbian offices on Belgrade’s clock and a foreign post’s events on its country’s, naming only the country', () => {
    const result = parsePostaSrbije(answer('abroad'), ABROAD);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-07-06T10:20:00+02:00', delivered_at: '2026-07-06T10:20:00+02:00',
      expected_delivery: null, weight_kg: 1.25 });
    expect(result.last_update_local).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-07-06T10:20:00+02:00', 'UR', 'delivered', 'Germany'],
      ['2026-07-06T07:45:00+02:00', 'PS', 'in_transit', 'Germany'],
      ['2026-07-03T18:02:00+02:00', 'OT', 'in_transit', 'Germany'],
      ['2026-07-02T09:12:40+02:00', 'OT', 'in_transit', 'IZMENIČNA POŠTA PRIMER'],
      ['2026-07-02T09:01:05+02:00', 'PS', 'in_transit', 'IZMENIČNA POŠTA PRIMER'],
      ['2026-07-01T19:40:12+02:00', 'OT', 'in_transit', 'PRIMEROVO'],
      ['2026-07-01T14:06:55+02:00', 'PR', 'accepted', 'PRIMEROVO'],
    ]);
    expect(result.events!.map(event => event.description)).toEqual(['Delivered', 'Arrived', 'Dispatch', 'Transport', 'Arrived', 'Dispatch', 'Receipt']);
    expect(result.events!.every(event => !('local_time' in event))).toBe(true);
    // The signer, office numbers, office codes, destinations and the service's own ids stay out.
    const kept = JSON.stringify(result);
    for (const dropped of ['Primer Primerović', '29999', '29900', '11999', 'DEPRMA', 'DEPRMB', '900001', '99999', 'PC PRIMEROVO']) {
      expect(kept, dropped).not.toContain(dropped);
    }
    // Another clock: the event keeps Tokyo's offset.
    const japan = parsePostaSrbije(answer('abroad', events => { events[0]!.Mesto = 'JP-JPPRMA'; }), ABROAD);
    expect(japan.events![0]).toMatchObject({ time: '2026-07-06T10:20:00+09:00', location: 'Japan' });
    // A delivery at home is dated on Belgrade's clock and names its office.
    const home = parsePostaSrbije(answer('abroad', events => { events.splice(0, 3, { ...events[0]!, Mesto: '29998 PRIMERNO SELO' }); }), ABROAD);
    expect(home).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-07-06T10:20:00+02:00' });
    expect(home.events![0]).toMatchObject({ location: 'PRIMERNO SELO' });
  });

  it('keeps the wall clock of a country with several clocks, drops its postcodes and reads a return to the sender', () => {
    const result = parsePostaSrbije(answer('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered (to the sender)', last_update: '2026-05-15T13:30:00+02:00', weight_kg: 0.04 });
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-05-15T13:30:00+02:00', 'UO', 'returned', 'PRIMEROVO'],
      ['2026-05-15T05:10:00+02:00', 'OT', 'in_transit', 'PC PRIMEROVO'],
      ['2026-05-14T11:56:19+02:00', 'OT', 'in_transit', 'Serbia'],
      ['2026-05-14T08:01:06+02:00', 'PS', 'in_transit', 'IZMENIČNA POŠTA PRIMER'],
      ['2026-05-04T19:42:00', 'OT', 'in_transit', 'United States'],
      ['2026-05-02T08:40:00', 'VR', 'failed_attempt', 'United States'],
      ['2026-04-30T06:18:00', 'PS', 'in_transit', 'United States'],
      ['2026-04-21T17:17:48+02:00', 'OT', 'in_transit', 'IZMENIČNA POŠTA PRIMER'],
      ['2026-04-16T14:34:14+02:00', 'PR', 'accepted', 'PRIMEROVO'],
    ]);
    expect(result.events![5]!.description).toBe('Neuspešan pokušaj uručenja');
    expect(JSON.stringify(result)).not.toMatch(/Primer Primerović|99999|RSPRMA|USPRMA|29999|11999/);
    // A delivery the service flags as a return is the sender's, whatever its code.
    const flagged = parsePostaSrbije(answer('returned', events => { events[0]!.ApiStatusSifra = 'UR'; }), RETURNED);
    expect(flagged.events![0]).toMatchObject({ provider_code: 'UR', stage: 'returned' });
    expect(flagged.delivered_at).toBeUndefined();
    // The newest event abroad leaves only a wall clock.
    const abroad = parsePostaSrbije(answer('returned', events => { events.splice(0, 4); }), RETURNED);
    expect(abroad).toMatchObject({ current_stage: 'in_transit', last_update: null, last_update_local: '2026-05-04T19:42:00' });
    // A place without a country or office keeps its name without a postcode, and its wall clock.
    const other = parsePostaSrbije(answer('returned', events => { events[0]!.Mesto = 'PRIMER 29999 CENTAR'; events[1]!.Mesto = ''; events[2]!.Mesto = 'XX-XXPRMA'; }), RETURNED);
    expect(rows(other).slice(0, 3)).toEqual([
      ['2026-05-15T13:30:00', 'UO', 'returned', 'PRIMER CENTAR'],
      ['2026-05-15T05:10:00', 'OT', 'in_transit', null],
      ['2026-05-14T11:56:19', 'OT', 'in_transit', null],
    ]);
  });

  it('keeps new codes visible, reads codes in lists, drops repeated events and caps long histories', () => {
    const result = parsePostaSrbije(answer('abroad', events => {
      events.unshift(
        { ...events[0]!, DatumKretanja: '2026-07-07T09:00:00', Status: 'Something new', StatusSifra: 'NN', ApiStatusSifra: 'NN' },
        { ...events[0]!, DatumKretanja: '2026-07-07T08:00:00', Status: '', StatusSifra: 'NX;', ApiStatusSifra: '' },
        { ...events[0]!, DatumKretanja: '2026-07-07T07:00:00', Status: 'Delivered', StatusSifra: 'XX;UR;', ApiStatusSifra: null },
      );
    }), ABROAD);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Something new' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events!.slice(0, 3)).toEqual([
      { time: '2026-07-07T09:00:00+02:00', description: 'Something new', provider_code: 'NN', location: 'Germany' },
      { time: '2026-07-07T08:00:00+02:00', description: 'NX', provider_code: 'NX', location: 'Germany' },
      { time: '2026-07-07T07:00:00+02:00', description: 'Delivered', provider_code: 'XX;UR', location: 'Germany', stage: 'delivered',
        stage_source: 'carrier_map' },
    ]);
    // A code no map knows takes the shared wording rules.
    const worded = parsePostaSrbije(answer('abroad', events => { events[0]!.ApiStatusSifra = 'NN'; events[0]!.Status = 'Item delivered to the addressee'; }), ABROAD);
    expect(worded.events![0]).toMatchObject({ stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) });
    const twice = parsePostaSrbije(answer('abroad', events => { events.push({ ...events.at(-1)! }); }), ABROAD);
    expect(twice.events).toHaveLength(7);
    const long = parsePostaSrbije(answer('abroad', events => {
      events.push(...Array.from({ length: 120 }, (_, index) => ({ ...events.at(-1)!, ApiStatusSifra: 'OT', Status: 'Dispatch',
        DatumKretanja: `2026-06-${String(1 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00` })));
    }), ABROAD);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ current_stage: 'delivered', history_truncated: true, weight_kg: 1.25 });
  });

  it('reads its not-found notice as a missing item, and its other notices apart from it', async () => {
    expect(() => parsePostaSrbije(answer('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const serbian = 'Pošiljka nije pronađena. Proverite ispravnost unetog broja.';
    expect(() => parsePostaSrbije(answer('not-found', (_, value) => { value.StrRezultat = { Poruka: serbian, PorukaKorisnik: serbian }; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(json('abroad'))).mockResolvedValueOnce(reply(json('not-found')));
    await expect(carrier(fetcher).recognize!(ABROAD)).resolves.toEqual({ known: true, lastActivityAt: '2026-07-06T08:20:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(() => parsePostaSrbije(answer('refused'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const notice = (code: number, text: string | null) => answer('not-found', (_, value) => {
      value.Rezultat = code;
      value.StrRezultat = { Poruka: text, PorukaKorisnik: text, Info: null };
    });
    expect(() => parsePostaSrbije(notice(1, 'Servis trenutno nije dostupan.'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostaSrbije(notice(2, 'Postal item not found. Please check the accuracy of the number you entered.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostaSrbije(notice(1, null), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const empty of [[], null]) {
      expect(() => parsePostaSrbije(answer('abroad', (_, value) => { value.StrOut!.Kretanja = empty; }), ABROAD), String(empty))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'no_history' }));
    }
  });

  it('binds the answer to the whole requested number and rejects malformed items', () => {
    expect(() => parsePostaSrbije(answer('abroad'), 'CE900000036RS')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (events: Row[]) => { events[3]!.PrijemniBroj = 'CE900000036RS'; },
      (events: Row[]) => { delete events[0]!.PrijemniBroj; },
      (events: Row[]) => { events[0]!.DatumKretanja = '06.07.2026 10:20:00'; },
      (events: Row[]) => { events[0]!.DatumKretanja = '2026-02-30T10:20:00'; },
      (events: Row[]) => { events[0]!.DatumKretanja = null; },
      (events: Row[]) => { events[0]!.ApiStatusSifra = 'not a code'; },
      (events: Row[]) => { events[0]!.ApiStatusSifra = ''; events[0]!.StatusSifra = ';'; },
      (events: Row[]) => { (events as unknown[])[0] = 'event'; },
      (_: Row[], value: Fixture) => { (value.StrOut as { Kretanja: unknown }).Kretanja = {}; },
    ]) expect(() => parsePostaSrbije(answer('abroad', change), ABROAD)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, 'item', {}, { Rezultat: '0' }, { Rezultat: 0 }, { Rezultat: 0, StrOut: '{' }, { Rezultat: 0, StrOut: '[]' },
      { Rezultat: 1, StrRezultat: null }, { Rezultat: 1.5 }]) {
      expect(() => parsePostaSrbije(payload, ABROAD), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
      await expect(carrier(fetcher).track({ number: ABROAD })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABROAD)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages, refused credentials and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [['<html><body>Request Rejected</body></html>', 'challenge'], ['Service unavailable', 'schema'],
      ['{"items":[]}', 'schema'], [json('refused'), 'challenge']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).recognize!(ABROAD), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: ABROAD })).rejects.toThrow('unexpectedly large');
  });

  it('takes S10 item codes, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CE900000023RS', 'CE90000002RS', 'CE9000000222RS', 'PE12345678', '123456789012', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('not-found')));
    for (const number of ['RR900000019DE', UNKNOWN]) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(any.mock.calls.map(([, init]) => JSON.parse(JSON.parse(String(init?.body)).StrIn).PrijemniBroj)).toEqual(['RR900000019DE', UNKNOWN]);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(json('abroad')));
    await expect(carrier(flaky).track({ number: ABROAD })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(json('abroad')));
    await expect(carrier(immediate).track({ number: ABROAD }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: ABROAD }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: ABROAD }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an item filed under Pošta Srbije to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('returned')));
    const tracked = await createTracker({ fetcher, providers: [], env: {} }).track({ number: RETURNED, carrier: 'posta-srbije' }, { budgetMs: 3000 });
    expect(tracked).toMatchObject({ carrier: 'posta-srbije', source: 'posta-srbije', result: { current_stage: 'returned' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === POSTA_SRBIJE_ENDPOINT)).toBe(true);
  });

  it('is named for its own Serbian S10 codes, asked about the others, and reads its links', () => {
    expect(detectCarrierMatch(ABROAD)).toMatchObject({ carrier: 'posta-srbije', confidence: 'high' });
    expect(detectCarrierMatch(RETURNED)).toMatchObject({ carrier: 'posta-srbije', confidence: 'high' });
    expect(detectCarrierMatch('PL900000019RS')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers('PL900000019RS')[0]).toBe('posta-srbije');
    expect(detectCarrierMatch('CE900000023RS').candidates).not.toContain('posta-srbije');
    expect(recognitionAskedCarriers('CE900000023RS')).not.toContain('posta-srbije');
    expect(recognitionAskedCarriers('RR900000019DE')).not.toContain('posta-srbije');
    for (const language of ['cir', 'lat', 'eng']) {
      expect(parseTrackingInput(`https://www.posta.rs/${language}/alati/pracenje-posiljke.aspx?broj=${ABROAD}`))
        .toMatchObject({ trackingNumber: ABROAD, carrier: 'posta-srbije', source: 'link' });
    }
  });
});

describe('Pošta Srbije status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(stage);
      expect(postaSrbijeCodeStage(entry.code), entry.code).toBe(stage);
    }
    for (const code of ['constructor', 'toString', '__proto__', 'NN']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'posta-srbije', providerCode: 'UO', description: 'Delivered (to the sender)' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'posta-srbije', providerCode: 'VR', description: 'Neuspešan pokušaj uručenja' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'posta-srbije', providerCode: 'ZI', description: 'In charge of delivery at post office' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
