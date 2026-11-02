import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LA_POSTE_SENEGAL_API, laPosteSenegalLookupUrl, LaPosteSenegalTracker } from './adapter.js';
import { normalizeLaPosteSenegalNumber, parseLaPosteSenegal } from './parser.js';
import { laPosteSenegalMappedStage, laPosteSenegalStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const INBOUND = 'CP000000014FR';
const IN_TRANSIT = 'EE000000005SN';
const UNKNOWN = 'LX000000005SN';
type Row = Record<string, unknown>;
interface Reply { MailItemId: unknown; MatchFound: unknown; Events?: Row[] | null; not_found?: unknown }
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const payload = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (reply: Reply, rows: Row[]) => void): Reply => {
  const reply = payload(name);
  change(reply, reply.Events!);
  return reply;
};
const reply = (body: string, status = 200, type = 'application/json; charset=UTF-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const CUSTOMS = 'Envoyer envoi à la douane (Ent): Documents manquants';

describe('La Poste du Sénégal tracking adapter', () => {
  it('asks the home page’s lookup for the whole code once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('inbound-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LaPosteSenegalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cp 000 000 014 fr ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LA_POSTE_SENEGAL_API}?code=${INBOUND}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'la-poste-senegal', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads mail from abroad delivered in Senegal, newest first, with each office’s wall clock', () => {
    const result = parseLaPosteSenegal(payload('inbound-delivered'), INBOUND);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Distribuer envoi (Ent)', last_update: null, last_update_local: '2026-08-11T11:02:41', expected_delivery: null,
      destination_country: 'SN' });
    // A wall clock without an offset gives the delivery no instant.
    expect(result).not.toHaveProperty('delivered_at');
    // The repeated scan is kept once.
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage, event.provider_code])).toEqual([
      ['2026-08-11T11:02:41', 'SAMPLE OFFICE, Senegal', 'Distribuer envoi (Ent)', 'delivered', '37'],
      ['2026-08-10T09:15:00', 'SAMPLE OFFICE, Senegal', 'Recevoir envoi au bureau de livraison (Ent)', 'in_transit', '32'],
      ['2026-08-10T04:13:38', 'DAKAR CENTRE DE TRI, Senegal', 'Expédier envoi à adresse nationale (Ent)', 'in_transit', '35'],
      ['2026-08-10T01:00:00', 'DAKAR CENTRE DE TRI, Senegal', 'Retourner envoi de la douane (Ent)', 'in_transit', '38'],
      ['2026-08-09T23:30:00', 'DAKAR CENTRE DE TRI, Senegal', CUSTOMS, 'customs', '31'],
      ['2026-08-09T23:08:19', 'DAKAR CENTRE DE TRI, Senegal', 'Recevoir envoi au bureau d\'échange (Ent)', 'in_transit', '30'],
      ['2026-08-05T02:15:00', 'SAMPLE CTI, France', 'Insérer envoi dans sac (Srt)', 'in_transit', '8'],
      ['2026-08-04T21:40:00', 'SAMPLE CTI, France', 'Recevoir envoi au bureau d\'échange (Srt)', 'in_transit', '3'],
      ['2026-08-03T10:12:00', 'SAMPLE PPDC, France', 'Recevoir envoi du client (Srt)', 'accepted', '1'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The signatory, the signature, the next office and the office's postcode are not read.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|AAAAAAAA|NextOffice|OFFICE 0000|Missing documents/);
  });

  it('reads an item posted in Senegal that has not left the country, without a destination', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Insérer envoi dans sac intérieur',
      last_update: null, last_update_local: '2026-10-06T02:10:45' });
    expect(result).not.toHaveProperty('destination_country');
    expect(result.events!.map(event => [event.local_time, event.location, event.provider_code, event.stage])).toEqual([
      ['2026-10-06T02:10:45', 'DAKAR CENTRE DE TRI, Senegal', '13', 'in_transit'],
      ['2026-10-06T02:09:21', 'DAKAR CENTRE DE TRI, Senegal', '3', 'in_transit'],
      ['2026-10-05T18:03:09', 'SAMPLE OFFICE, Senegal', '2', 'in_transit'],
      ['2026-10-05T09:31:12', 'SAMPLE OFFICE, Senegal', '1', 'accepted'],
    ]);
  });

  it('reads customs, unknown events, places and clocks the way the page’s data gives them', () => {
    const held = parseLaPosteSenegal(edited('inbound-delivered', (_reply, rows) => { rows.splice(5); }), INBOUND);
    expect(held).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: CUSTOMS, destination_country: 'SN' });
    // An event without a French name keeps its English one; an unknown number falls to the wording rules or none.
    const unnamed = parseLaPosteSenegal(edited('in-transit', (_reply, rows) => {
      rows.at(-1)!.MailItemEvent = { Code: '99', Name: 'Sample event', LocalName: '' };
    }), IN_TRANSIT);
    expect(unnamed).toMatchObject({ last_status_text: 'Sample event', current_stage: 'in_transit' });
    expect(unnamed.events![0]).toEqual({ local_time: '2026-10-06T02:10:45', location: 'DAKAR CENTRE DE TRI, Senegal', description: 'Sample event',
      provider_code: '99' });
    // The wording rules read an unknown event's English name, while the event keeps the page's French one.
    const missed = parseLaPosteSenegal(edited('in-transit', (_reply, rows) => {
      rows.at(-1)!.MailItemEvent = { Code: '99', Name: 'Unsuccessful item delivery attempt (Inb)', LocalName: 'Exemple de tentative (Ent)' };
    }), IN_TRANSIT);
    expect(missed.events![0]).toMatchObject({ description: 'Exemple de tentative (Ent)', provider_code: '99', stage: 'failed_attempt',
      stage_source: 'wording:language' });
    const numeric = parseLaPosteSenegal(edited('in-transit', (_reply, rows) => {
      rows.at(-1)!.MailItemEvent = { Code: 37, Name: 'Deliver item (Inb)', LocalName: null };
      rows.at(-1)!.NonDeliveryReason = { Code: '', Name: 'Sample reason', LocalName: '' };
      rows.at(-1)!.NonDeliveryMeasure = { Code: '', Name: '', LocalName: 'Mesure exemple' };
    }), IN_TRANSIT);
    expect(numeric.events![0]).toMatchObject({ description: 'Deliver item (Inb): Sample reason; Mesure exemple', provider_code: '37', stage: 'delivered' });
    // A country named twice is named once, a scan in no country names its office alone, and IPS's article is dropped.
    const places = parseLaPosteSenegal(edited('in-transit', (_reply, rows) => {
      rows.at(-1)!.Location = 'SENEGAL';
      rows.at(-2)!.Country = null;
      rows.at(-3)!.Country = { Code: 'NL', Name: 'Netherlands (the)', LocalName: 'Pays-Bas' };
    }), IN_TRANSIT);
    expect(places.events!.slice(0, 3).map(event => event.location)).toEqual(['Senegal', 'DAKAR CENTRE DE TRI', 'SAMPLE OFFICE, Netherlands']);
    // A clock with a fraction keeps its second; scans at the same second keep the later reply row first.
    const tied = parseLaPosteSenegal(edited('in-transit', (_reply, rows) => {
      rows.at(-1)!.LocalDate = '2026-10-06T02:09:21.907';
    }), IN_TRANSIT);
    expect(tied.events!.slice(0, 2).map(event => [event.local_time, event.provider_code])).toEqual([
      ['2026-10-06T02:09:21', '13'], ['2026-10-06T02:09:21', '3']]);
    // An inward scan abroad names the country the item was sent to.
    const abroad = parseLaPosteSenegal(edited('in-transit', (_reply, rows) => {
      rows.push({ ...rows[0]!, MailItemEvent: { Code: '30', Name: 'Receive item at office of exchange (Inb)', LocalName: '' },
        LocalDate: '2026-10-09T08:00:00', Country: { Code: 'FR', Name: 'France', LocalName: 'France' }, Location: 'SAMPLE CTI' });
    }), IN_TRANSIT);
    expect(abroad).toMatchObject({ destination_country: 'FR', last_update_local: '2026-10-09T08:00:00' });
  });

  it('reads the tracker’s answer for a code without a match as missing, and anything else short of a history as no answer', async () => {
    expect(() => parseLaPosteSenegal(payload('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLaPosteSenegal(edited('not-found', reply => { reply.Events = null; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLaPosteSenegal({ not_found: true }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseLaPosteSenegal(edited('not-found', reply => { reply.MatchFound = true; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'indeterminate' });
    // A route the site does not know is not a missing item.
    await expect(lookup('{"code":"rest_no_route","message":"Sample","data":{"status":404}}', 404)).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(`\uFEFF${text('in-transit')}`))).track({ number: IN_TRANSIT }))
      .resolves.toMatchObject({ status: 'in_transit' });
  });

  it('rejects changed replies and answers for another item', () => {
    const row = payload('in-transit').Events![0]!;
    const changed: unknown[] = [null, 'reply', [], {}, 0, { MailItemId: IN_TRANSIT }, { MailItemId: IN_TRANSIT, MatchFound: 'true', Events: [] },
      { MailItemId: 7, MatchFound: true, Events: [row] },
      { MailItemId: IN_TRANSIT, MatchFound: true, Events: {} },
      { MailItemId: IN_TRANSIT, MatchFound: true, Events: Array.from({ length: 501 }, () => row) },
      // Scans without a match are not the answer for an unknown code.
      edited('in-transit', reply => { reply.MatchFound = false; }),
      edited('in-transit', reply => { reply.MailItemId = 'EE000000005SG'; }),
      edited('in-transit', reply => { reply.MailItemId = UNKNOWN; }),
      edited('in-transit', (_reply, rows) => { rows[0] = 'row' as never; }),
      edited('in-transit', (_reply, rows) => { delete rows[0]!.MailItemEvent; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.MailItemEvent = { Code: '1', Name: '  ', LocalName: '' }; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.MailItemEvent = { Code: 'EMA', Name: 'Sample', LocalName: '' }; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.MailItemEvent = { Code: ['1'], Name: 'Sample', LocalName: '' }; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.MailItemEvent = { Code: '1', Name: ['Sample'], LocalName: '' }; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.MailItemEvent = 'Sample'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.Country = 'SN'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.Location = { Name: 'DAKAR' }; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.RetentionReason = 'Sample'; }),
      edited('in-transit', (_reply, rows) => { delete rows[0]!.LocalDate; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.LocalDate = '05/10/2026 09:31:12'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.LocalDate = '2026-10-05T09:31'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.LocalDate = '2026-10-05T09:31:12Z'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.LocalDate = '2026-02-30T09:31:12'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.LocalDate = '2026-10-05T24:31:12'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.LocalDate = '0001-01-01T00:00:00'; })];
    for (const changedPayload of changed) {
      expect(() => parseLaPosteSenegal(changedPayload, IN_TRANSIT), JSON.stringify(changedPayload)?.slice(0, 160))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'EE000000004SN', 'EE00000005SN', 'EE000000005SNX', 'E0000000005SN', 'JT0000000000000', '0000000000000',
      'SAMPLETRACKING', `EE${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLaPosteSenegalNumber(' ee-000-000-005 sn ')).toBe(IN_TRANSIT);
    expect(laPosteSenegalLookupUrl(IN_TRANSIT)).toBe(`${LA_POSTE_SENEGAL_API}?code=${IN_TRANSIT}`);
    expect(() => parseLaPosteSenegal(payload('not-found'), 'LX000000004SN')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // Recognition sends nothing for a code the tracker does not take.
    await expect(carrier(fetcher).recognize!('SAMPLETRACKING', {})).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes an item the tracker holds, and not one it finds no match for, with the same request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => reply(text(String(url).endsWith(UNKNOWN) ? 'not-found' : 'in-transit')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT, { budgetMs: 3000 })).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN, { budgetMs: 3000 })).resolves.toEqual({ known: false });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([laPosteSenegalLookupUrl(IN_TRANSIT), laPosteSenegalLookupUrl(UNKNOWN)]);
    // A lookup that names no match for sure is not an unknown item.
    const flagged = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"not_found":true}'));
    await expect(carrier(flagged).recognize!(UNKNOWN, { budgetMs: 3000 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too many requests',
      { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: INBOUND })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[400, 'transport'], [401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'],
    [405, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: INBOUND })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(text('inbound-delivered')));
    await expect(carrier(flaky).track({ number: INBOUND })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('inbound-delivered')));
    await expect(carrier(immediate).track({ number: INBOUND }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: INBOUND }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // The first try's timeout and the budget's end come close together; either is a correct answer.
    await expect(carrier(slow).track({ number: INBOUND }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(2_200_000)));
    await expect(carrier(large).track({ number: INBOUND })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under La Poste du Sénégal to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('inbound-delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INBOUND, carrier: 'la-poste-senegal' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'la-poste-senegal', source: 'la-poste-senegal', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === laPosteSenegalLookupUrl(INBOUND))).toBe(true);
  });
});

describe('La Poste du Sénégal status vocabulary', () => {
  it('maps every event number it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(laPosteSenegalMappedStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'la-poste-senegal', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(laPosteSenegalStage(' 37 ', 'Sample')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const code of ['constructor', 'toString', '99', '', null]) expect(laPosteSenegalMappedStage(code), String(code)).toBeUndefined();
    expect(laPosteSenegalStage(null, '')).toBeNull();
  });
});
