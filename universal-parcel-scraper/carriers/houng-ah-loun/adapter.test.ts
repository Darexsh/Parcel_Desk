import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HAL_API, HalTracker } from './adapter.js';
import { halWording, normalizeHalNumber, parseHal } from './parser.js';
import { halStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = 'VTE00000000000';
const DELIVERED = 'VTE00000000001';
const IN_TRANSIT = 'SVT00000000002';
const RETURNED = 'PSE00000000003';

type Row = Record<string, unknown>;
type Reply = Row & { shipment_info: Row; tracking_events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('HAL Express HTTP adapter', () => {
  it('asks the parcel page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' svt 000-0000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HAL_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'houng-ah-loun', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists a collected parcel newest first, on wall clocks, without the staff who scanned it', () => {
    const result = parseHal(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ສຳເລັດການຮັບຝາກ ຂອບໃຈທີ່ໃຊ້ບໍລິການ', last_update: null, last_update_local: '2026-03-04T10:20:30',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location, event.description])).toEqual([
      ['2026-03-04T10:20:30', '6', 'delivered', 'ສາຂາ ທົດລອງສອງ (ຫຼັກ12)', 'ສຳເລັດການຮັບຝາກ ຂອບໃຈທີ່ໃຊ້ບໍລິການ'],
      ['2026-03-03T11:02:42', '5', 'ready_for_pickup', 'ສາຂາ ທົດລອງສອງ (ຫຼັກ12)',
        'ພັດສະດຸຮອດປາຍທາງແລ້ວ ທ່ານສາມາດເຂົ້າຮັບພັດສະດຸໄດ້ທີ່ສາຂາ ທົດລອງສອງ (ຫຼັກ12) ກ່ອນວັນທີ 10/03/2026 ຫາກເກີນກຳນົດພັດສະດຸຈະຖືກຕີກັບສາຂາຕົ້ນທາງ'],
      ['2026-03-03T11:02:41', '4', 'in_transit', 'ສາງສາຂາທົດລອງສອງ', 'ກໍາລັງຈັດສົ່ງໄປສາຂາ ທົດລອງສອງ (ຫຼັກ12)'],
      ['2026-03-03T11:02:37', '3', 'in_transit', 'ສາງສາຂາທົດລອງສອງ', 'ພັດສະດຸຮອດ ສາງສາຂາທົດລອງສອງ'],
      ['2026-03-03T06:30:00', '4', 'in_transit', 'ສູນຄັດແຍກທົດລອງ', 'ກໍາລັງຈັດສົ່ງໄປ ສາງສາຂາທົດລອງສອງ'],
      ['2026-03-03T02:10:44', '3', 'in_transit', 'ສູນຄັດແຍກທົດລອງ', 'ພັດສະດຸຮອດ ສູນຄັດແຍກທົດລອງ'],
      ['2026-03-02T17:40:05', '4', 'in_transit', 'ສາຂາ ທົດລອງໜຶ່ງ', 'ກໍາລັງຈັດສົ່ງໄປ ສູນຄັດແຍກທົດລອງ'],
      ['2026-03-02T09:15:21', '3', 'in_transit', 'ສາຂາ ທົດລອງໜຶ່ງ', 'ພັດສະດຸຮອດສາຂາ ທົດລອງໜຶ່ງ'],
      ['2026-03-02T09:15:20', '2', 'accepted', 'ສາຂາ ທົດລອງໜຶ່ງ', 'ຮັບພັດສະດຸແລ້ວ'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map' && !event.provider_leg)).toBe(true);
    // The staff, phone numbers, sender, recipient, branches' details, charges and parcel details are not kept.
    expect(JSON.stringify(result)).not.toMatch(/ສົມມຸດ|ຕົວຢ່າງ ທົດລອງ|ເບີໂທ|00000000|ຜູ້ສົ່ງ|Sample Receiver|\*\*\*\*|ເຄື່ອງທົດລອງ|HC1-2-3|20000|weight/);
  });

  it('reads a parcel on its way, a booking by the reply’s own name for it', () => {
    const result = parseHal(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'ພັດສະດຸຮອດ ສູນຄັດແຍກທົດລອງ',
      last_update: null, last_update_local: '2026-04-08T03:25:18' });
    expect(result.events!.map((event) => [event.description, event.stage, event.location ?? null])).toEqual([
      ['ພັດສະດຸຮອດ ສູນຄັດແຍກທົດລອງ', 'in_transit', 'ສູນຄັດແຍກທົດລອງ'],
      ['ກໍາລັງຈັດສົ່ງໄປ ສູນຄັດແຍກທົດລອງ', 'in_transit', 'ສາຂາ ທົດລອງສອງ (ຫຼັກ12)'],
      ['ພັດສະດຸຮອດສາຂາ ທົດລອງສອງ (ຫຼັກ12)', 'in_transit', 'ສາຂາ ທົດລອງສອງ (ຫຼັກ12)'],
      ['ຮັບພັດສະດຸແລ້ວ', 'accepted', 'ສາຂາ ທົດລອງສອງ (ຫຼັກ12)'],
      ['Pending', 'registered', null],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the arrival and collection after a return as the parcel back with its sender', () => {
    const result = parseHal(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'ສຳເລັດການຮັບຝາກ ຂອບໃຈທີ່ໃຊ້ບໍລິການ', last_update_local: '2026-06-02T11:10:00' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.provider_leg ?? null, event.location])).toEqual([
      ['6', 'returned', 'return', 'ສາຂາ ທົດລອງໜຶ່ງ'],
      ['5', 'returned', 'return', 'ສາຂາ ທົດລອງໜຶ່ງ'],
      ['4', 'in_transit', 'return', 'ສູນຄັດແຍກທົດລອງ'],
      ['3', 'in_transit', 'return', 'ສູນຄັດແຍກທົດລອງ'],
      ['4', 'in_transit', 'return', 'ສາຂາ ທົດລອງສອງ (ຫຼັກ12)'],
      ['11', 'exception', 'return', 'ສາຂາ ທົດລອງສອງ (ຫຼັກ12)'],
      ['3', 'in_transit', null, 'ສາຂາ ທົດລອງສອງ (ຫຼັກ12)'],
      ['4', 'in_transit', null, 'ສູນຄັດແຍກທົດລອງ'],
      ['3', 'in_transit', null, 'ສູນຄັດແຍກທົດລອງ'],
      ['4', 'in_transit', null, 'ສາຂາ ທົດລອງໜຶ່ງ'],
      ['3', 'in_transit', null, 'ສາຂາ ທົດລອງໜຶ່ງ'],
      ['2', 'accepted', null, 'ສາຂາ ທົດລອງໜຶ່ງ'],
    ]);
    // The return scan keeps the branch it sends the parcel back to.
    expect(result.events![5]!.description).toBe('ພັດສະດຸຖືກຕີກັບສາຂາຕົ້ນທາງແລ້ວ - ສາຂາ ທົດລອງໜຶ່ງ');
  });

  it('puts scans in clock order, keeps a repeated one once and an unknown code without a stage', () => {
    const result = parseHal(changed('in-transit', (body) => {
      const events = body.tracking_events;
      events.push({ ...events[4]! });
      events.push({ ...events[3]!, date: '2026-04-08 09:00:00', delivery_state: 9, delivery_state_name: 'Sample state', message: 'ສະຖານະທົດລອງ' });
      events.reverse();
    }), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'ສະຖານະທົດລອງ', last_update_local: '2026-04-08T09:00:00' });
    expect(result.events![0]).toMatchObject({ provider_code: '9', description: 'ສະຖານະທົດລອງ' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events!.map((event) => event.local_time)).toEqual([
      '2026-04-08T09:00:00', '2026-04-08T03:25:18', '2026-04-07T16:12:30', '2026-04-07T08:00:07', '2026-04-07T08:00:05', '2026-04-06T19:45:00',
    ]);
    // Scans in the same second keep the reply's order.
    const sameSecond = parseHal(changed('delivered', (body) => {
      for (const event of body.tracking_events.slice(5, 8)) event.date = '2026-03-03 11:02:40';
    }), DELIVERED);
    expect(sameSecond.events!.slice(1, 4).map((event) => event.provider_code)).toEqual(['5', '4', '3']);
  });

  it('cuts the staff member and phone numbers out of a message, and keeps the branch a return names', () => {
    expect(halWording('ພັດສະດຸຮອດສາຂາ ທົດລອງ  - ທ. ສົມມຸດ ທົດລອງ - ເບີໂທ 00000000000')).toBe('ພັດສະດຸຮອດສາຂາ ທົດລອງ');
    expect(halWording('ກໍາລັງຈັດສົ່ງໄປ ສູນທົດລອງ  - ນາງ ຕົວຢ່າງ ສາທິດ')).toBe('ກໍາລັງຈັດສົ່ງໄປ ສູນທົດລອງ');
    expect(halWording('ກໍາລັງຈັດສົ່ງໄປ ສູນທົດລອງ ທ້າວ ຕົວຢ່າງ ສາທິດ')).toBe('ກໍາລັງຈັດສົ່ງໄປ ສູນທົດລອງ');
    expect(halWording('ພັດສະດຸຖືກຕີກັບສາຂາຕົ້ນທາງແລ້ວ - ສາຂາ ທົດລອງ - ນ. ຕົວຢ່າງ ທົດລອງ')).toBe('ພັດສະດຸຖືກຕີກັບສາຂາຕົ້ນທາງແລ້ວ - ສາຂາ ທົດລອງ');
    expect(halWording('ພັດສະດຸຮອດ ສາງທົດລອງ ເບີໂທ: 000 0000 0000')).toBe('ພັດສະດຸຮອດ ສາງທົດລອງ');
    expect(halWording('ກະລຸນາໂທ +000 00 000 000 ທົດລອງ')).toBe('ກະລຸນາໂທ ທົດລອງ');
    // A branch's number and a date stay.
    expect(halWording('ສາຂາ ທົດລອງ (ຫຼັກ30) ກ່ອນວັນທີ 01/02/2026')).toBe('ສາຂາ ທົດລອງ (ຫຼັກ30) ກ່ອນວັນທີ 01/02/2026');
    expect(halWording(' - ທ. ສົມມຸດ ທົດລອງ')).toBe('');
  });

  it('counts a reply only for the bill asked', () => {
    expect(() => parseHal(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'HAL Express answered for another shipment' }));
    expect(() => parseHal(changed('delivered', (body) => { body.shipment_info.bill_number = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseHal(changed('delivered', (body) => { body.shipment_info.bill_number = ' vte00000000001 '; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the unknown-bill answer as not found, another error as inconclusive and a bill without scans as no history', () => {
    expect(() => parseHal(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHal({ error: true, message: 'Sample failure', code: 500, data: null }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const events of [[], undefined, null]) {
      expect(() => parseHal(changed('delivered', (body) => { body.tracking_events = events as never; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('rejects a changed reply', () => {
    const first = (change: (event: Row) => void) => (body: Reply) => change(body.tracking_events[1]!);
    for (const change of [
      (body: Reply) => { delete (body as Row).shipment_info; },
      (body: Reply) => { body.shipment_info.bill_number = 7; },
      (body: Reply) => { body.tracking_events = 'scans' as never; },
      (body: Reply) => { body.tracking_events = Array.from({ length: 501 }, () => body.tracking_events[1]!); },
      (body: Reply) => { body.tracking_events[1] = 'scan' as never; },
      first((event) => { event.delivery_state = '3'; }),
      first((event) => { event.delivery_state = -1; }),
      first((event) => { event.delivery_state = 3.5; }),
      first((event) => { event.message = 7; }),
      first((event) => { event.place = ['ສາຂາ']; }),
      first((event) => { event.message = ''; event.delivery_state_name = null; }),
      first((event) => { event.date = null; }),
      first((event) => { event.date = '2026/03/02 09:15'; }),
      first((event) => { event.date = '2026-03-02T09:15:21+07:00'; }),
      first((event) => { event.date = '2026-02-30 09:15:21'; }),
      first((event) => { event.date = '2026-03-02 24:00:00'; }),
    ]) {
      expect(() => parseHal(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], 'reply', { data: null }]) {
      expect(() => parseHal(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown bill, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // HAL answers an unknown bill with HTTP 404 and its own message; any other 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ error: true, message: 'Route not found', code: 404 }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://halexpress.la/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>HAL Express</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [405, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known bill and the unknown-bill answer, and asks nothing for a number HAL does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T10:20:30' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('00000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers HAL does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A run of digits is a phone number to the page's search, which needs a login.
    for (const number of ['0', '00000000000', '0000000000000', 'V00000000000', 'VTEAB00000000000', 'VTE0000000', 'VTE000000000000000',
      'VTE0000000000X', `VTE${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHalNumber(' vte-0000 0000 001 ')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a bill filed under HAL Express to the adapter, and leaves the bill shape unclaimed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'houng-ah-loun' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'houng-ah-loun', source: 'houng-ah-loun', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${HAL_API}${DELIVERED}`)).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('houng-ah-loun');
  });
});

describe('HAL Express status vocabulary', () => {
  it('maps every recorded code to the stage it records, and leaves the arrival and collection to the history', () => {
    const entries = statuses.entries as { code: string; wording: string; stage: string; confirmedBy: string }[];
    expect(entries.filter((entry) => entry.confirmedBy === 'live').length).toBeGreaterThanOrEqual(6);
    for (const entry of entries) {
      expect(halStage(entry.code, false)?.stage, entry.wording).toBe(entry.stage);
      const answer = statusMapAnswer({ carrier: 'houng-ah-loun', providerCode: entry.code, description: entry.wording });
      if (entry.code === '5' || entry.code === '6') {
        expect(halStage(entry.code, true)?.stage, entry.wording).toBe('returned');
        expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBeUndefined();
        expect(answer, entry.wording).toEqual({ kind: 'unknown' });
        continue;
      }
      expect(halStage(entry.code, true)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'houng-ah-loun', providerCode: '9', description: 'Sample state' })).toEqual({ kind: 'unknown' });
    expect(halStage('9', false)).toBeNull();
  });
});
