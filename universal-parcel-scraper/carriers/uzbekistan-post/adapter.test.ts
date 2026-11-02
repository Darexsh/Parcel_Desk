import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, UZBEKISTAN_POST_API, UzbekistanPostTracker, uzbekistanPostLookupUrl } from './adapter.js';
import { normalizeUzbekistanPostNumber, parseUzbekistanPost } from './parser.js';
import { statusMap, uzbekistanPostMappedStage, uzbekistanPostStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014UZ';
const IN_TRANSIT = 'ZZ000000028UZ';
const EMS = 'EZ000000031IT';
const INBOUND = 'ZZ000000045RU';
const UNKNOWN = 'ZZ000000059UZ';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Row = Record<string, unknown>;
type Shipox = { header: { data: Row; status: unknown } | null; shipox: { data: { total: number; list: Row[] }; status: unknown } | null; gdeposilka: unknown };
type Ips = { Fid: unknown; InfoFromEdi: Row; OperationalMailitems: { TMailitemInfoFromScanning: { InternationalId: unknown; Events: { TMailitemEventScanning: Row[] } }[] } }[];
const shipox = (name: string): Shipox => JSON.parse(text(name)) as Shipox;
const ips = (): Ips => JSON.parse(text('ems')) as Ips;
const edited = <T>(read: () => T, change: (payload: T) => void): T => {
  const payload = read();
  change(payload);
  return payload;
};
const list = (payload: Shipox) => payload.shipox!.data.list;
const scans = (payload: Ips) => payload[0]!.OperationalMailitems.TMailitemInfoFromScanning[0]!.Events.TMailitemEventScanning;
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Uzbekistan Post tracking adapter', () => {
  it('asks the tracker for the whole code once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new UzbekistanPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 uz ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${UZBEKISTAN_POST_API}${DELIVERED}/`);
    expect(uzbekistanPostLookupUrl(DELIVERED)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'uzbekistan-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic delivery newest first, with Tashkent instants, offices without postcodes and codes', () => {
    const result = parseUzbekistanPost(shipox('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Выдан получателю', last_update: '2026-09-28T15:25:35+05:00', delivered_at: '2026-09-28T15:25:35+05:00',
      expected_delivery: null, destination_country: 'UZ' });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-09-28T15:25:35+05:00', 'Тестово ОПС - Тестово', 'Выдан получателю', 'issued_to_recipient', 'delivered'],
      ['2026-09-28T15:22:35+05:00', 'Тестово ОПС - Тестово', 'В пути для доставки', 'out_for_delivery', 'out_for_delivery'],
      ['2026-09-23T17:54:53+05:00', 'Тестово ОПС - Тестово', 'Готов к выдаче', 'ready_for_issue', 'ready_for_pickup'],
      ['2026-09-23T17:54:53+05:00', 'Тестово ОПС - Тестово', 'На сортировке', 'in_sorting_facility', 'in_transit'],
      ['2026-09-22T14:52:23+05:00', 'Образцово ОПП / Namunaobod OPP', 'В пути', 'in_transit', 'in_transit'],
      ['2026-09-22T02:39:55+05:00', 'Образцово ОПП / Namunaobod OPP', 'В пути', 'in_transit', 'in_transit'],
      ['2026-09-21T23:36:48+05:00', 'Образцово ОПП / Namunaobod OPP', 'На сортировке', 'in_sorting_facility', 'in_transit'],
      ['2026-09-20T12:42:03+05:00', 'Xalqaro Pi - 9', 'В пути', 'in_transit', 'in_transit'],
      ['2026-09-19T23:15:01+05:00', 'Xalqaro Pi - 9', 'На сортировке', 'in_sorting_facility', 'in_transit'],
      ['2026-09-19T11:24:41+05:00', 'Примерск - УПС - Намуна', 'В пути', 'in_transit', 'in_transit'],
      ['2026-09-19T11:21:02+05:00', 'Примерск - УПС - Намуна', 'На сортировке', 'in_sorting_facility', 'in_transit'],
      ['2026-09-18T16:07:41+05:00', 'Примерск ОПС - г. Примерск', 'На сортировке', 'in_sorting_facility', 'in_transit'],
      ['2026-09-18T16:07:37+05:00', 'Примерск ОПС - г. Примерск', 'Новое отправление', 'unassigned', 'registered'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // Addresses, postcodes and the package are the recipient's and the sender's, not the item's history.
    expect(JSON.stringify(result)).not.toMatch(/99990|NAMUNA|SINOV|ONE_STEP|Qopsiz|UzPost/);
  });

  it('reads an item after a failed delivery as in transit, without the postman’s name, phone or position', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'В пути',
      last_update: '2026-10-12T21:04:06+05:00' });
    expect(result.events!.map(event => [event.provider_code, event.stage])).toEqual([
      ['in_transit', 'in_transit'], ['in_sorting_facility', 'in_transit'], ['incomplete_address', 'exception'],
      ['first_delivery_attempt', 'failed_attempt'], ['dispatched', 'in_transit'], ['in_sorting_facility', 'in_transit'], ['unassigned', 'registered'],
    ]);
    expect(result.events!.at(-1)).toEqual({ time: '2026-10-11T14:39:26+05:00', description: 'Новое отправление', provider_code: 'unassigned',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Sample Courier|900000000|40\.2|ROLE_DRIVER|SIMPLE/);
  });

  it('reads mail from abroad, keeping the copied scans of the sending post by their wall clocks without an office', () => {
    const result = parseUzbekistanPost(shipox('inbound'), INBOUND);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_update: '2026-08-26T12:12:44+05:00',
      destination_country: 'UZ' });
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-08-26T12:12:44+05:00', 'Тестово ОПС - Тестово', 'Готов к выдаче', 'ready_for_pickup'],
      ['2026-08-26T12:12:44+05:00', 'Тестово ОПС - Тестово', 'На сортировке', 'in_transit'],
      // A code the system gives no wording keeps its code.
      ['2026-08-25T15:53:57+05:00', 'Тестово ОПС - Тестово', 'recipient_refused', 'exception'],
      ['2026-08-23T07:12:48+05:00', 'Xalqaro Pi - 9', 'В пути', 'in_transit'],
      ['2026-08-23T00:40:22+05:00', 'Xalqaro Pi - 9', 'На сортировке', 'in_transit'],
      ['2026-08-22T16:26:15+05:00', 'Pi - 9 Ishlov berish', 'На сортировке', 'in_transit'],
      ['2026-08-22T16:26:15+05:00', 'Pi - 9 Ishlov berish', 'Выпущено из таможни', 'in_transit'],
      ['2026-08-22T16:24:53+05:00', 'Pi - 9 Ishlov berish', 'Отправлено на таможню', 'customs'],
      ['2026-08-22T16:22:06+05:00', 'Pi - 9 Ishlov berish', 'Новое отправление', 'registered'],
      ['2026-08-14T16:13:00', undefined, 'Выпущено из таможни', 'in_transit'],
      ['2026-08-14T16:12:00', undefined, 'Отправлено на таможню', 'customs'],
      ['2026-08-05T13:00:00', undefined, 'Новое отправление', 'registered'],
    ]);
    expect(result.events!.slice(-3).every(event => event.time === undefined)).toBe(true);
  });

  it('reads an EMS item from IPS, with an offset where the post gives a GMT clock and the sending post’s wall clocks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('ems')));
    const result = await carrier(fetcher).track({ number: EMS });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Доставка отправления',
      last_update: '2026-09-09T10:15:00+05:00', delivered_at: '2026-09-09T10:15:00+05:00', destination_country: 'UZ' });
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-09-09T10:15:00+05:00', 'SINOV EMS', 'Доставка отправления', '37', 'delivered'],
      ['2026-09-08T11:06:50+05:00', 'SINOV EMS', 'Отправлено в отделение доставки', '32', 'in_transit'],
      ['2026-09-08T11:05:12+05:00', 'SINOV EMS', 'Отправлено в местный пункт', '35', 'in_transit'],
      ['2026-09-08T11:02:30+05:00', 'SINOV EMS', 'Выпущено из таможни', '38', 'in_transit'],
      // The page names an event without a Russian name by its IPS name, and the reason customs kept the item beside it.
      ['2026-09-03T15:23:05+05:00', 'SINOV EMS', 'Record item customs information (Inb): Documents required', '34', 'customs'],
      ['2026-09-03T15:22:40+05:00', 'SINOV EMS', 'Отправлено на таможню', '31', 'customs'],
      ['2026-09-03T15:20:11+05:00', 'SINOV EMS', 'Принято в пункте обмена', '30', 'in_transit'],
      ['2026-08-31T08:03:00', 'ESEMPIO CMP', 'Отправление помещено в депешу для отправки в страну назначения', '8', 'in_transit'],
      ['2026-08-31T03:37:00', 'ESEMPIO CMP', 'Принято в пункте обмена', '3', 'in_transit'],
      ['2026-08-27T12:09:00', undefined, 'Получение отправления от клиента', '1', 'accepted'],
    ]);
    expect(result.events!.slice(-3).every(event => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SIGNATORY|UZZZZA|ITZZZA|XXZZZ/);
  });

  it('reads an EMS item no office scanned from its announcement, and keeps a wall clock two clocks cannot settle', () => {
    const announced = parseUzbekistanPost(edited(ips, payload => { payload[0]!.OperationalMailitems = { TMailitemInfoFromScanning: [] }; }), EMS);
    expect(announced).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_update: null, last_update_local: '2026-08-27T12:09:00',
      events: [{ local_time: '2026-08-27T12:09:00', description: 'Получение отправления от клиента', provider_code: '1' }] });
    const unsettled = parseUzbekistanPost(edited(ips, payload => { scans(payload)[6]!.GmtDateTime = '2026-09-09T05:07:00'; }), EMS);
    expect(unsettled.events![0]).toMatchObject({ local_time: '2026-09-09T10:15:00', description: 'Доставка отправления' });
    expect(unsettled).not.toHaveProperty('delivered_at');
    const reasoned = parseUzbekistanPost(edited(ips, payload => {
      scans(payload)[6]!.NonDeliveryReason = { Code: '10', Name: 'Addressee absent', LocalName: null };
    }), EMS);
    expect(reasoned.events![0]).toMatchObject({ description: 'Доставка отправления: Addressee absent', stage: 'delivered' });
    const unnamed = parseUzbekistanPost(edited(ips, payload => {
      scans(payload)[6]!.IPSEventType = { Code: '99', Name: 'Sample event (Inb)', LocalName_ru: null };
    }), EMS);
    expect(unnamed).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample event (Inb)' });
    expect(unnamed.events![0]).not.toHaveProperty('stage');
  });

  it('keeps IPS scans of one instant in its order, reversed as it lists them oldest first', () => {
    const tied = parseUzbekistanPost(edited(ips, payload => {
      const [same, moved] = [scans(payload)[4]!, scans(payload)[5]!];
      Object.assign(moved, { LocalDateTime: same.LocalDateTime, GmtDateTime: same.GmtDateTime });
    }), EMS);
    expect(tied.events!.slice(0, 4).map(event => event.provider_code)).toEqual(['37', '32', '35', '38']);
  });

  it('keeps a repeated scan once, keeps the newest stage under an unknown code and says when the history is cut short', () => {
    const repeated = parseUzbekistanPost(edited(() => shipox('delivered'), payload => {
      list(payload).splice(1, 0, { ...list(payload)[1]!, id: 1 });
    }), DELIVERED);
    expect(repeated.events).toHaveLength(13);
    const unknown = parseUzbekistanPost(edited(() => shipox('in-transit'), payload => {
      list(payload).unshift({ ...list(payload)[0]!, status: 'sample_status', status_ru: 'Образец события', date: '2026-10-13T04:00:00.000Z' });
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Образец события' });
    expect(unknown.events![0]).toEqual({ time: '2026-10-13T09:00:00+05:00', location: 'Примерск - УПС - Намуна', description: 'Образец события',
      provider_code: 'sample_status' });
    const reversed = parseUzbekistanPost(edited(() => shipox('delivered'), payload => { list(payload).reverse(); }), DELIVERED);
    expect(reversed.events!.map(event => event.time)).toEqual(parseUzbekistanPost(shipox('delivered'), DELIVERED).events!.map(event => event.time));
    const cut = parseUzbekistanPost(edited(() => shipox('delivered'), payload => { payload.shipox!.data.total = 40; }), DELIVERED);
    expect(cut.history_truncated).toBe(true);
    const returned = parseUzbekistanPost(edited(() => shipox('in-transit'), payload => {
      list(payload)[0]!.status = 'returning_to_origin';
      list(payload)[0]!.status_ru = 'Возвращается отправителю';
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });

  it('reads the tracker’s empty answer and its EMS 404 as missing, and a reply without history as having none', async () => {
    expect(() => parseUzbekistanPost(JSON.parse(text('not-found')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseUzbekistanPost(JSON.parse(text('ems-not-found')), EMS)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseUzbekistanPost(edited(() => shipox('delivered'), payload => { payload.shipox = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseUzbekistanPost(edited(() => shipox('delivered'), payload => { payload.shipox!.data.list = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseUzbekistanPost(edited(() => shipox('delivered'), payload => { payload.shipox!.status = 'error'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUzbekistanPost([], EMS)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const lookup = (body: string, status = 200, type?: string, number = UNKNOWN) => carrier(vi.fn<typeof fetch>()
      .mockResolvedValue(reply(body, status, type))).track({ number });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('ems-not-found'), 404, 'application/json', EMS)).rejects.toMatchObject({ kind: 'not_found' });
    // A route the server does not know is not a missing item.
    await expect(lookup('<!doctype html><title>Not Found</title>', 404, 'text/html')).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('delivered').replaceAll(DELIVERED, UNKNOWN)}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('binds the reply to the whole requested code and rejects changed replies', () => {
    expect(() => parseUzbekistanPost(shipox('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Uzbekistan Post answered for a different item' }));
    expect(() => parseUzbekistanPost(ips(), 'EZ000000045IT'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Uzbekistan Post answered for a different item' }));
    expect(() => parseUzbekistanPost(edited(ips, payload => {
      payload[0]!.OperationalMailitems.TMailitemInfoFromScanning[0]!.InternationalId = 'EZ000000045IT';
    }), EMS)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Uzbekistan Post answered for a different item' }));
    expect(parseUzbekistanPost(edited(() => shipox('delivered'), payload => { payload.header!.data.order_number = DELIVERED.toLowerCase(); }), DELIVERED)
      .events).toHaveLength(13);
    const shipoxPayloads: unknown[] = [null, 'reply', {}, { header: null, shipox: null },
      edited(() => shipox('delivered'), reply => { reply.header = null; }),
      edited(() => shipox('delivered'), reply => { reply.header!.status = 'error'; }),
      edited(() => shipox('delivered'), reply => { delete reply.header!.data.order_number; }),
      edited(() => shipox('delivered'), reply => { reply.header!.data.order_number = 7; }),
      edited(() => shipox('delivered'), reply => { reply.header!.data.locations = 'UZ'; }),
      edited(() => shipox('delivered'), reply => { (reply.shipox!.data as Row).list = null; }),
      edited(() => shipox('delivered'), reply => { (list(reply) as unknown[])[1] = 'scan'; }),
      edited(() => shipox('delivered'), reply => { list(reply)[1]!.status = null; }),
      edited(() => shipox('delivered'), reply => { list(reply)[1]!.status = 'Sample Status'; }),
      edited(() => shipox('delivered'), reply => { list(reply)[1]!.status_ru = ['Выдан получателю']; }),
      edited(() => shipox('delivered'), reply => { list(reply)[1]!.date = '2026-09-28T15:22:35+05:00'; }),
      edited(() => shipox('delivered'), reply => { list(reply)[1]!.date = '2026-09-31T10:22:35.810Z'; }),
      edited(() => shipox('delivered'), reply => { list(reply)[1]!.date = null; }),
      edited(() => shipox('delivered'), reply => { list(reply)[1]!.warehouse = 'office'; }),
      edited(() => shipox('delivered'), reply => { list(reply)[1]!.external_id = { id: 1 }; }),
      edited(() => shipox('delivered'), reply => { reply.shipox!.data.list = Array.from({ length: 501 }, () => list(reply)[0]!); })];
    const ipsPayloads: unknown[] = [[ips()[0], ips()[0]], ['entry'],
      edited(ips, reply => { delete reply[0]!.Fid; }),
      edited(ips, reply => { (reply[0]!.OperationalMailitems as Row).TMailitemInfoFromScanning = {}; }),
      edited(ips, reply => { reply[0]!.OperationalMailitems.TMailitemInfoFromScanning.push(reply[0]!.OperationalMailitems.TMailitemInfoFromScanning[0]!); }),
      edited(ips, reply => { (reply[0]!.OperationalMailitems.TMailitemInfoFromScanning[0]!.Events as Row).TMailitemEventScanning = 'scans'; }),
      edited(ips, reply => { scans(reply)[0]!.IPSEventType = { Code: '30' }; }),
      edited(ips, reply => { scans(reply)[0]!.IPSEventType = { Code: 'A-30', Name: 'Sample' }; }),
      edited(ips, reply => { scans(reply)[0]!.IPSEventType = { Code: 30.5, Name: 'Sample' }; }),
      edited(ips, reply => { scans(reply)[0]!.LocalDateTime = '03.09.2026 15:20'; }),
      edited(ips, reply => { scans(reply)[0]!.LocalDateTime = '2026-09-03T24:20:11'; }),
      edited(ips, reply => { scans(reply)[0]!.GmtDateTime = '2026-09-03T10:20:11Z'; }),
      edited(ips, reply => { scans(reply)[0]!.EventOffice = 'SINOV'; })];
    for (const payload of shipoxPayloads) {
      expect(() => parseUzbekistanPost(payload, DELIVERED), JSON.stringify(payload)?.slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of ipsPayloads) {
      expect(() => parseUzbekistanPost(payload, EMS), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015UZ', 'ZZ00000001UZ', 'ZZ000000014UZX', 'Z0000000014UZ', '1234567890123', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeUzbekistanPostNumber(' zz-000-000-045 ru ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')))
      .mockResolvedValueOnce(reply(text('ems-not-found'), 404));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-28T10:25:35.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(EMS)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"detail":"Request was throttled."}',
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // The first try's timeout and the budget's end come close together; either is a correct answer.
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Uzbekistan Post to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'uzbekistan-post' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'uzbekistan-post', source: 'uzbekistan-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === uzbekistanPostLookupUrl(DELIVERED))).toBe(true);
  });

  it('reads the number from the tracker’s links', () => {
    for (const link of [`https://uz.post/ru/tracking/${DELIVERED}`, `https://uz.post/uz/tracking/${DELIVERED}/`, `https://www.uz.post/tracking/${DELIVERED}`,
      `https://uz.post/ru/tracking?search=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'uzbekistan-post', source: 'link' });
    }
  });
});

describe('Uzbekistan Post status vocabulary', () => {
  it('maps every code and Russian or English wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && typeof entry.code === 'string' ? entry.code : null;
      const wording = 'wording' in entry && typeof entry.wording === 'string' ? entry.wording : '';
      const label = `${code ?? ''} ${wording}`;
      // The adapter reads the Russian page's wording: the Uzbek page's wordings map through their codes.
      if ('language' in entry && entry.language === 'uz' && !code) continue;
      expect(uzbekistanPostMappedStage(code, wording), label).toBe(entry.stage);
      expect(statusMap.stage(code, normalizeStatusWording(wording)), label).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'uzbekistan-post', providerCode: code, description: wording || code! }), label)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(uzbekistanPostStage(null, ' выдан  получателю ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(uzbekistanPostStage('31', 'Sample')).toEqual({ stage: 'customs', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Образец события']) expect(uzbekistanPostMappedStage(null, wording), wording).toBeUndefined();
    expect(uzbekistanPostMappedStage('constructor', '')).toBeUndefined();
    expect(uzbekistanPostStage(null, '')).toBeNull();
  });
});
