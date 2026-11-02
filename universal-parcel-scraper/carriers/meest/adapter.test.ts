import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MEEST_LOOKUP, MEEST_PAGE, meestLookupUrl, meestPageSalt, MeestTracker } from './adapter.js';
import { parseMeest } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const TRANSIT = 'ZZ1234567AB00010G';
const PARTNER = 'ZZ7654321CD00020G';
const DOMESTIC = 'ZZ123456789US';
const REFERENCE = '9900000001';
const UNKNOWN = 'ZZ0000000ZZ00000G';
const SALT = '0123456789abcdef0123456789abcdef';
const NEW_SALT = 'fedcba9876543210fedcba9876543210';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const xml = (name: string) => text(`${name}.xml`);
const page = (salt = SALT) => new Response(text('page.html').replace(SALT, salt), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const reply = (name: string) => new Response(xml(name), { headers: { 'Content-Type': 'text/xml; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A transport that serves the tracking page, then the given lookup replies in turn. */
const site = (...answers: (() => Response)[]) => vi.fn<typeof fetch>(async input => {
  if (String(input) === MEEST_PAGE) return page();
  const next = answers.length > 1 ? answers.shift()! : answers[0]!;
  return next();
});
const urls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.map(([url]) => String(url));
const lookup = (number: string, salt = SALT) => meestLookupUrl(number, salt);

afterEach(() => vi.restoreAllMocks());

describe('Meest HTTP adapter', () => {
  it("takes the salt from the tracker's page, then signs the lookup for the whole number with it", async () => {
    expect(meestPageSalt(text('page.html'))).toBe(SALT);
    expect(lookup(TRANSIT)).toBe(`${MEEST_LOOKUP}?what=tracking&test&number=${TRANSIT}&lang=uk&ext_track=&chk=507c9844686a21b788516c8267842781`);
    const fetcher = site(() => reply('transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MeestTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz-1234567.ab 00010g ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(urls(fetcher)).toEqual([MEEST_PAGE, lookup(TRANSIT)]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/xml, text/xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(fetcher.mock.calls[1]![1]!.body ?? null).toBeNull();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'meest', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reuses the salt for an hour, then loads the page again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    const fetcher = site(() => reply('transit'));
    const tracker = new MeestTracker({ fetcher });
    await tracker.fetch(TRANSIT);
    await tracker.fetch(TRANSIT);
    expect(urls(fetcher).filter(url => url === MEEST_PAGE)).toHaveLength(1);
    now.mockReturnValue(1_900_000_000_000 + 60 * 60_000);
    await tracker.fetch(TRANSIT);
    expect(urls(fetcher)).toEqual([MEEST_PAGE, lookup(TRANSIT), lookup(TRANSIT), MEEST_PAGE, lookup(TRANSIT)]);
  });

  it('refreshes a kept salt the lookup refuses, once', async () => {
    const salts = [SALT, NEW_SALT];
    let valid = SALT;
    const fetcher = vi.fn<typeof fetch>(async input => {
      if (String(input) === MEEST_PAGE) return page(salts.shift() ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      return String(input) === lookup(TRANSIT, valid) ? reply('transit') : new Response('', { status: 400 });
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new MeestTracker({ fetcher, recorder });
    await expect(tracker.fetch(TRANSIT)).resolves.toMatchObject({ status: 'in_transit' });
    valid = NEW_SALT;
    fetcher.mockClear();
    await expect(tracker.fetch(TRANSIT)).resolves.toMatchObject({ status: 'in_transit' });
    expect(urls(fetcher)).toEqual([lookup(TRANSIT, SALT), MEEST_PAGE, lookup(TRANSIT, NEW_SALT)]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'refresh', outcome: 'ok', fallbackFrom: 'direct',
      fallbackReason: 'indeterminate' }));
    // A fresh salt the lookup refuses is no expiry: the page or the check changed.
    valid = 'none';
    fetcher.mockClear();
    await expect(tracker.fetch(TRANSIT)).rejects.toMatchObject({ kind: 'transport' });
    expect(urls(fetcher)).toHaveLength(3);
    fetcher.mockClear();
    await expect(tracker.fetch(TRANSIT)).rejects.toMatchObject({ kind: 'transport' });
    expect(urls(fetcher)).toHaveLength(2);
  });

  it('reads a consolidation in transit newest first, without the hidden registration or a repeated scan', () => {
    const result = parseMeest(xml('transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrival at transit office of exchange', last_update: null, last_update_local: '2026-01-10T19:27:14',
      expected_delivery: null });
    expect(result.destination_country).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.events).toEqual([
      { local_time: '2026-01-10T19:27:14', description: 'Arrival at transit office of exchange', location: 'Amsterdam, NETHERLANDS',
        provider_code: '404', stage: 'in_transit', stage_source: 'carrier_map' },
      // The page shows a midnight clock as a day.
      { local_time: '2026-01-10', description: 'Departure from international sorting center', location: 'Hong Kong, CHINA',
        provider_code: '405', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-08T15:02:36', description: 'Departure from outward office of exchange', location: 'Guangzhou, CHINA',
        provider_code: '303', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-08T14:44:52', description: 'REGISTER COLLECTED', location: 'Guangzhou, CHINA',
        provider_code: '203', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-08T08:16:05', description: 'Arrival at outward office of exchange', location: 'Guangzhou, CHINA',
        provider_code: '202', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-05T04:12:48', description: 'Parcel/shipment registered', location: 'Guangzhou, CHINA',
        provider_code: '101', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/складі|Registered|MCHINA/);
  });

  it("keeps the reply's later row first on equal clocks, and its Ukrainian wording when English is missing", () => {
    const tied = xml('transit').replace('2026-01-08 08:16:05', '2026-01-08 14:44:52')
      .replace('<ActionMessages_EN>REGISTER COLLECTED</ActionMessages_EN>', '<ActionMessages_EN></ActionMessages_EN>')
      .replace('<ActionMessages>REGISTER COLLECTED</ActionMessages>', '<ActionMessages>Реєстр зібрано</ActionMessages>');
    expect(parseMeest(tied, TRANSIT).events!.slice(3, 5).map(event => [event.local_time, event.provider_code, event.description])).toEqual([
      ['2026-01-08T14:44:52', '203', 'Реєстр зібрано'],
      ['2026-01-08T14:44:52', '202', 'Arrival at outward office of exchange'],
    ]);
  });

  it("names the final-mile partner a partner feed hands the parcel to, with that partner's number", () => {
    const result = parseMeest(xml('partner'), PARTNER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Parcel is DELIVERED',
      last_update_local: '2026-02-10T16:22:58', destination_country: 'GR', delivery_carrier: 'box-now',
      delivery_tracking_number: REFERENCE });
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-02-10T16:22:58', '1622', 'delivered', 'GR'],
      ['2026-02-09T18:03:16', '1200', 'ready_for_pickup', 'GR'],
      ['2026-02-09T13:27:45', '505', 'in_transit', 'GR'],
      ['2026-02-07T09:12:00', '2220', 'in_transit', 'NL'],
      ['2026-02-07T08:46:00', '2000', 'customs', 'NL'],
      ['2026-02-07T08:31:00', '404', 'in_transit', 'NL'],
      ['2026-02-06T10:15:09', '100', 'registered', 'GR'],
      ['2026-02-06T10:14:22', '100', 'registered', 'CN'],
      ['2026-02-04T15:49:03', '303', 'in_transit', 'Guangzhou, CHINA'],
      ['2026-02-04T07:21:40', '202', 'in_transit', 'Guangzhou, CHINA'],
      ['2026-02-02T06:58:11', '101', 'accepted', 'Guangzhou, CHINA'],
    ]);
    // A note without a barcode names the partner, with the number its row carries.
    const announced = xml('partner').replace(/Arrival to local HUB\. Delivery by BOXNOW with barcode \d+/, 'Arrival to local HUB');
    expect(parseMeest(announced, PARTNER)).toMatchObject({ delivery_carrier: 'box-now', delivery_tracking_number: REFERENCE });
    // A partner the catalog cannot place, or a destination the rows disagree on, is left out.
    const unplaced = parseMeest(xml('partner').replaceAll('BOXNOW', 'Synthetic Lockers').replaceAll('Box Now', 'Synthetic Lockers')
      .replace('<CountryDel>GR</CountryDel>', '<CountryDel>RO</CountryDel>'), PARTNER);
    expect(unplaced.delivery_carrier).toBeUndefined();
    expect(unplaced.delivery_tracking_number).toBeUndefined();
    expect(unplaced.destination_country).toBeUndefined();
  });

  it('reads a parcel cleared and delivered in Ukraine, without the hidden row, details or other numbers', () => {
    const result = parseMeest(xml('domestic'), DOMESTIC);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Shipment received',
      last_update_local: '2026-03-19T12:44:06', destination_country: 'UA' });
    expect(result.events!.map(event => [event.provider_code, event.stage, event.location])).toEqual([
      ['1622', 'delivered', 'Zhytomyr, UKRAINE'],
      ['1214', 'ready_for_pickup', 'Zhytomyr, UKRAINE'],
      ['1315', 'out_for_delivery', 'Zhytomyr, UKRAINE'],
      ['1100', 'in_transit', 'Zhytomyr, UKRAINE'],
      ['808', 'in_transit', 'Lviv, UKRAINE'],
      ['2227', 'in_transit', 'Lviv, UKRAINE'],
      ['2225', 'customs', 'Lviv, UKRAINE'],
      ['505', 'in_transit', 'Lviv, UKRAINE'],
      ['303', 'in_transit', 'New York, USA'],
    ]);
    expect(result.delivery_carrier).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/1628|Delivery attempt|Branch No|Synthetic street|синтетичний|Synthetic preparation note|ZZ987654321UA/);
  });

  it('keeps a number Meest notes only as a partner reference, and scans it hides, apart from a parcel', () => {
    expect(() => parseMeest(xml('reference'), REFERENCE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const hidden = xml('domestic').replace(/<StatusCode>\d+<\/StatusCode>/g, '<StatusCode>1628</StatusCode>');
    expect(() => parseMeest(hidden, DOMESTIC)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads an empty table as not found and a refused lookup as inconclusive', () => {
    expect(() => parseMeest(xml('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMeest(xml('error'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the reply to the whole requested number and refuses a changed shape', () => {
    expect(() => parseMeest(xml('transit'), 'ZZ1234567AB00011G')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const changed of [
      xml('transit').replace('2026-01-08 15:02:36', '08.01.2026 13:23'),
      xml('transit').replace('2026-01-08 15:02:36', '2026-02-30 15:02:36'),
      xml('transit').replace('<StatusCode>303</StatusCode>', '<StatusCode>Departure</StatusCode>'),
      xml('transit').replace('<StatusCode>303</StatusCode>', '<StatusCode>303</StatusCode><StatusCode>404</StatusCode>'),
      xml('transit').replace('<api>API-1C</api>', '<result_table></result_table>'),
      xml('transit').replace('<code>000</code>', '<code>ok</code>'),
      xml('not-found').replace('<result_table></result_table>', '<result_table><row/></result_table>'),
      xml('transit').replaceAll('return>', 'answer>'),
      '<html><body>Maintenance</body></html>',
      '<!DOCTYPE return [<!ENTITY a "a">]><return/>',
    ]) {
      expect(() => parseMeest(changed, TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('recognizes a known parcel and the empty reply with one lookup each', async () => {
    const fetcher = site(() => reply('transit'), () => reply('not-found'));
    const instance = carrier(fetcher);
    await expect(instance.recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-10T19:27:14' });
    await expect(instance.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(instance.recognize!('ABC12')).resolves.toEqual({ known: false });
    expect(urls(fetcher)).toEqual([MEEST_PAGE, lookup(TRANSIT), lookup(UNKNOWN)]);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the lookup as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = site(() => new Response('', { status }));
      const instance = carrier(fetcher);
      await expect(instance.track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(instance.recognize!(TRANSIT)).rejects.toMatchObject({ kind });
    });

  it('keeps a refused or changed tracking page apart from a missing parcel', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    for (const [answer, kind] of [[() => new Response(challenge, { status: 403 }), 'challenge'], [() => new Response(challenge), 'challenge'],
      [() => new Response('<html><script>var salt = "";</script></html>'), 'schema'], [() => new Response('', { status: 404 }), 'transport']] as const) {
      const fetcher = vi.fn<typeof fetch>(async () => answer());
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps blocked HTTP 200 lookups and malformed replies apart from missing parcels', async () => {
    for (const [body, kind] of [['<html><title>Attention Required! | Cloudflare</title></html>', 'challenge'],
      ['<html>Maintenance</html>', 'schema'], ['', 'schema'], ['{"result":[]}', 'schema']]) {
      const fetcher = site(() => new Response(body));
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects numbers the tracker cannot take and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ABC12', 'ABCDEFGH', 'Z'.repeat(40) + '1', 'ZZ1234567AB/0010G']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a parcel filed under Meest to the adapter, keeps its wall clocks and offers the final-mile partner', async () => {
    const fetcher = site(() => reply('partner'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARTNER, carrier: 'meest' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'meest', source: 'meest', result: { current_stage: 'delivered', delivery_carrier: 'box-now' },
      handoff: { carrier: 'box-now', number: REFERENCE } });
    expect(answer.result.events[0]).toMatchObject({ local_time: '2026-02-10T16:22:58' });
    expect(urls(fetcher).slice(0, 2)).toEqual([MEEST_PAGE, lookup(PARTNER)]);
  });

  it("opens the tracker's links and asks Meest for its consolidation numbers only", () => {
    for (const link of [`https://t.meest-group.com/n/${TRANSIT}`, `https://ua.meest.com/parcel-track?parcel_number=${TRANSIT}`,
      `https://us.meest.com/uk/parcel-track?parcel_number=${TRANSIT}`, `https://tracking-iframe.meest.com/t/en/${TRANSIT}?dateFormat=us`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: TRANSIT, carrier: 'meest', source: 'link' });
    }
    expect(detectCarrierMatch(TRANSIT)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['meest'] });
    expect(recognitionAskedCarriers(TRANSIT)).toContain('meest');
    // Senders' S10 numbers and partners' references stay with their own routing.
    for (const number of [DOMESTIC, REFERENCE]) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('meest');
    }
  });
});

describe('Meest status vocabulary', () => {
  it('records every code the map knows with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), `${entry.code} ${entry.wording}`).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(statusMapAnswer({ carrier: 'meest', providerCode: '1622', description: 'Parcel is DELIVERED' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'meest', providerCode: '2533', description: 'Уточнено реквізити отримувача' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'meest', providerCode: '9999', description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});
