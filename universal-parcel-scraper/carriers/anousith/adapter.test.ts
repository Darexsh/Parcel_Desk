import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ANOUSITH_API, AnousithTracker, anousithRequests } from './adapter.js';
import { anousithItem, anousithScans, normalizeAnousithNumber, parseAnousith } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = '0000000000000';
const DELIVERED = '0000000000001';
const IN_TRANSIT = '0000000000002';
const RETURNED = '0000000000003';

type Row = Record<string, unknown>;
interface Replies { items: { data: { itemsV2: { total: number; data: Row[] } } }; scans: { data: { scanItems: { data: Row[] } } } }

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Replies;
const changed = (name: string, change: (replies: Replies, item: Row, scans: Row[]) => void) => {
  const replies = fixture(name);
  change(replies, replies.items.data.itemsV2.data[0]!, replies.scans.data.scanItems.data);
  return replies;
};
const parse = (replies: Replies, number: string) => parseAnousith(anousithItem(replies.items, number), anousithScans(replies.scans, number), number);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const answering = (replies: Replies) => vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { operationName: string };
  return reply(body.operationName === 'ItemsV2' ? replies.items : replies.scans);
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const PERSONAL = /ສົມມຸດ|ຮ້ານ|02000000000|02099999999|20000|receiver|customer|charge/;

describe('Anousith HTTP adapter', () => {
  it('asks the API for the bill and then its scans, for the whole number, through the supplied transport', async () => {
    const fetcher = answering(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AnousithTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000 0000 00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const bodies = fetcher.mock.calls.map(([url, init]) => {
      expect(String(url)).toBe(ANOUSITH_API);
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Referer: 'https://app.anousith.express/', 'User-Agent': 'SyntheticHost/1.0',
      } });
      return JSON.parse(String(init?.body)) as Row;
    });
    expect(bodies.map((body) => [body.operationName, body.variables])).toEqual([
      ['ItemsV2', { where: { trackingId: IN_TRANSIT, isDeleted: 0 }, limit: 2 }],
      ['ScanItems', { where: { trackingId: IN_TRANSIT } }],
    ]);
    expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual([anousithRequests(IN_TRANSIT).items, anousithRequests(IN_TRANSIT).scans]);
    // One field per line, as the app sends it, and nothing personal asked for.
    for (const body of bodies) {
      expect(String(body.query).split('\n').every((line) => line.trim().split(/\s+/).length === 1 || /[({]\s*$/.test(line) || /^\s*}$/.test(line)))
        .toBe(true);
      expect(String(body.query)).not.toMatch(/receiver|sender|customer|charge|phone|full_name|price|\bcod/i);
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'anousith', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists a collected parcel newest first, from the bill’s dates and the scans between them, in UTC', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ພັດສະດຸສົ່ງສຳເລັດ', provider_code: 'COMPLETED', last_update: '2026-03-03T03:20:30Z', expected_delivery: null,
      delivered_at: '2026-03-03T03:20:30Z', weight_kg: 1.5 });
    const destination = 'ສາຂາ ທົດລອງສອງ (ບ້ານທົດສອບ), ແຂວງ ທົດລອງ';
    const origin = 'ສາຂາ ທົດລອງໜຶ່ງ, ນະຄອນຫຼວງທົດລອງ';
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage, event.location ?? null, event.description])).toEqual([
      ['2026-03-03T03:20:30Z', null, 'delivered', destination, 'ຈັດສົ່ງສຳເລັດແລ້ວ'],
      ['2026-03-03T02:05:10Z', null, 'ready_for_pickup', destination, 'ຮອດສາຂາປາຍທາງແລ້ວ'],
      ['2026-03-02T16:15:07Z', 'SCAN_OUT', 'in_transit', 'ສູນແຂວງທົດລອງ', 'ສະແກນອອກ'],
      ['2026-03-02T08:19:05Z', 'SCAN_IN', 'in_transit', 'ສູນຄັດແຍກທົດລອງ', 'ສະແກນເຂົ້າ'],
      ['2026-03-02T06:40:05Z', null, 'in_transit', origin, 'ກຳລັງຍ້າຍໄປສາຂາປາຍທາງ'],
      ['2026-03-02T02:15:20Z', null, 'accepted', origin, 'ຢູ່ສາຂາຕົ້ນທາງ'],
      ['2026-03-02T02:15:20Z', null, 'registered', null, 'ລໍຖ້າສາຂາຮັບເຄື່ອງ'],
    ]);
    expect(result.events!.every((event) => !event.local_time && event.stage_source === 'carrier_map' && !event.provider_leg)).toBe(true);
    // A parcel collected at its branch names no point once delivered; the recipient, sender and charges are not kept.
    expect(result).not.toHaveProperty('pickup_point');
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
  });

  it('reads a parcel on its way, and one waiting at its destination branch with the branch as its pickup point', () => {
    const result = parse(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'ກຳລັງຂົນສົ່ງໄປປາຍທາງ',
      provider_code: 'TRANSIT_TO_DEST_BRANCH', last_update: '2026-04-07T20:25:18Z' });
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['ສະແກນເຂົ້າ', 'in_transit'], ['ກຳລັງຍ້າຍໄປສາຂາປາຍທາງ', 'in_transit'], ['ຢູ່ສາຂາຕົ້ນທາງ', 'accepted'], ['ລໍຖ້າສາຂາຮັບເຄື່ອງ', 'registered'],
    ]);
    for (const key of ['delivered_at', 'weight_kg', 'pickup_point']) expect(result).not.toHaveProperty(key);

    const waiting = parse(changed('in-transit', (_replies, item, scans) => {
      item.itemStatus = 'DEST_BRANCH_RECEIVED_FORWARD';
      item.destReceiveDate = '2026-04-08T03:00:00.000Z';
      scans.unshift({ ...scans[1]!, createdAt: '2026-04-08T03:00:00.000Z', scanStatus: 'SCAN_IN', branch: item.destBranchId });
    }), IN_TRANSIT);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'ຮອດສາຂາປາຍທາງເເລ້ວ',
      pickup_point: 'ສາຂາ ທົດລອງໜຶ່ງ\nນະຄອນຫຼວງທົດລອງ' });
    // The arrival scan is the bill's own arrival date, kept once under the page's wording.
    expect(waiting.events!.slice(0, 2).map((event) => [event.description, event.location])).toEqual([
      ['ຮອດສາຂາປາຍທາງແລ້ວ', 'ສາຂາ ທົດລອງໜຶ່ງ, ນະຄອນຫຼວງທົດລອງ'], ['ສະແກນເຂົ້າ', 'ສູນຄັດແຍກທົດລອງ'],
    ]);
  });

  it('reads the way back and the handover to the sender as the return', () => {
    const result = parse(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'ສົ່ງຄືນແມ່ຄ້າສຳເລັດແລ້ວ', provider_code: 'COMPLETED', last_update: '2026-05-14T05:00:00Z', weight_kg: 2 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('pickup_point');
    expect(result.events!.map((event) => [event.description, event.stage, event.provider_leg ?? null, event.location ?? null])).toEqual([
      ['ສົ່ງຄືນແມ່ຄ້າສຳເລັດແລ້ວ', 'returned', 'return', 'ສາຂາ ທົດລອງໜຶ່ງ, ນະຄອນຫຼວງທົດລອງ'],
      ['ຮອດສາຂາຕົ້ນທາງແລ້ວ', 'returned', 'return', 'ສາຂາ ທົດລອງໜຶ່ງ, ນະຄອນຫຼວງທົດລອງ'],
      ['ສະແກນອອກ (ເຄື່ອງຕີກັບ)', 'returned', 'return', 'ສູນຄັດແຍກທົດລອງ'],
      ['ສະແກນເຂົ້າ (ເຄື່ອງຕີກັບ)', 'returned', 'return', 'ສູນຄັດແຍກທົດລອງ'],
      ['ກຳລັງຍ້າຍໄປສາຂາຕົ້ນທາງ (ເຄື່ອງຕີກັບ)', 'returned', 'return', 'ສາຂາ ທົດລອງສອງ (ບ້ານທົດສອບ), ແຂວງ ທົດລອງ'],
      ['ຮອດສາຂາປາຍທາງແລ້ວ', 'ready_for_pickup', null, 'ສາຂາ ທົດລອງສອງ (ບ້ານທົດສອບ), ແຂວງ ທົດລອງ'],
      ['ສະແກນອອກ', 'in_transit', null, 'ສູນຄັດແຍກທົດລອງ'],
      ['ສະແກນເຂົ້າ', 'in_transit', null, 'ສູນຄັດແຍກທົດລອງ'],
      ['ກຳລັງຍ້າຍໄປສາຂາປາຍທາງ', 'in_transit', null, 'ສາຂາ ທົດລອງໜຶ່ງ, ນະຄອນຫຼວງທົດລອງ'],
      ['ຢູ່ສາຂາຕົ້ນທາງ', 'accepted', null, 'ສາຂາ ທົດລອງໜຶ່ງ, ນະຄອນຫຼວງທົດລອງ'],
      ['ລໍຖ້າສາຂາຮັບເຄື່ອງ', 'registered', null, null],
    ]);
  });

  it('keeps an unknown scan or bill status without a stage of its own', () => {
    const result = parse(changed('in-transit', (_replies, item, scans) => {
      item.itemStatus = 'SAMPLE_STATE';
      scans.unshift({ ...scans[0]!, createdAt: '2026-04-08T09:00:00.000Z', scanStatus: 'SAMPLE_SCAN' });
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ time: '2026-04-08T09:00:00Z', location: 'ສູນຄັດແຍກທົດລອງ', description: 'SAMPLE_SCAN', provider_code: 'SAMPLE_SCAN' });
    // The newest scan with a stage gives the parcel's.
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'SAMPLE_SCAN', provider_code: 'SAMPLE_STATE' });
    const bare = parse(changed('in-transit', (_replies, item, scans) => {
      item.itemStatus = 'SAMPLE_STATE';
      for (const key of ['createdDate', 'originReceiveDate', 'originSendDate']) item[key] = null;
      scans.splice(0, scans.length, { ...scans[0]!, scanStatus: 'SAMPLE_SCAN' });
    }), IN_TRANSIT);
    expect(bare).toMatchObject({ status: 'unknown', last_status_text: 'SAMPLE_SCAN' });
    expect(bare).not.toHaveProperty('current_stage');
  });

  it('counts a reply only for the bill asked', () => {
    expect(() => anousithItem(fixture('delivered').items, IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Anousith answered for another shipment' }));
    expect(() => anousithScans(fixture('delivered').scans, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(changed('delivered', (_replies, _item, scans) => { scans[2]!.trackingId = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAnousith(anousithItem(fixture('returned').items, RETURNED), [], DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Two parcels under one bill name neither.
    expect(() => anousithItem(changed('delivered', (replies, item) => { replies.items.data.itemsV2.data.push({ ...item }); replies.items.data.itemsV2.total = 2; }).items,
      DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => anousithItem(changed('delivered', (replies) => { replies.items.data.itemsV2.total = 2; }).items, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parse(changed('delivered', (_replies, item) => { item.trackingId = ` ${DELIVERED} `; }), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the empty list as not found, an error the API sends as inconclusive, and a bill without dates or scans as no history', () => {
    expect(() => anousithItem(fixture('not-found').items, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(anousithScans(fixture('not-found').scans, UNKNOWN)).toEqual([]);
    expect(() => anousithItem(fixture('error'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => anousithItem({ errors: [{ message: 'Cannot query field', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => anousithScans({ errors: 'failure', data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(changed('in-transit', (_replies, item, scans) => {
      for (const key of ['createdDate', 'originReceiveDate', 'originSendDate']) item[key] = null;
      scans.length = 0;
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (replies: Replies) => { (replies.items.data as Row).itemsV2 = null; },
      (replies: Replies) => { (replies.items.data.itemsV2 as Row).data = 'bills'; },
      (replies: Replies) => { (replies.items.data.itemsV2 as Row).total = '1'; },
      (replies: Replies) => { replies.items.data.itemsV2.data = []; },
      (replies: Replies) => { replies.items.data.itemsV2.data[0] = 'bill' as never; },
      (replies: Replies) => { (replies.scans.data as Row).scanItems = null; },
      (replies: Replies) => { replies.scans.data.scanItems.data = Array.from({ length: 501 }, () => replies.scans.data.scanItems.data[0]!); },
      (replies: Replies) => { replies.scans.data.scanItems.data[1] = 'scan' as never; },
      (_replies: Replies, item: Row) => { delete item.trackingId; },
      (_replies: Replies, item: Row) => { item.itemStatus = null; },
      (_replies: Replies, item: Row) => { item.isBackward = 'no'; },
      (_replies: Replies, item: Row) => { item.originSendDate = '2026-03-02 06:40:05'; },
      (_replies: Replies, item: Row) => { item.destReceiveDate = 1772503510000; },
      (_replies: Replies, item: Row) => { item.originBranchId = 'branch'; },
      (_replies: Replies, item: Row) => { item.destProvinceId = { provinceName: 7 }; },
      (_replies: Replies, _item: Row, scans: Row[]) => { delete scans[1]!.trackingId; },
      (_replies: Replies, _item: Row, scans: Row[]) => { scans[1]!.createdAt = null; },
      (_replies: Replies, _item: Row, scans: Row[]) => { scans[1]!.createdAt = '2026-03-03T02:05:10'; },
      (_replies: Replies, _item: Row, scans: Row[]) => { scans[1]!.scanStatus = ''; },
      (_replies: Replies, _item: Row, scans: Row[]) => { scans[1]!.transportStatus = 'SIDEWAYS'; },
      (_replies: Replies, _item: Row, scans: Row[]) => { scans[2]!.center = ['centre']; },
    ]) {
      expect(() => parse(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], 'reply', { data: null }, { data: {} }]) {
      expect(() => anousithItem(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
      expect(() => anousithScans(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('asks nothing more after the unknown-bill answer, and keeps a refusal, a browser check and a broken reply apart', async () => {
    const unknown = answering(fixture('not-found'));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown).toHaveBeenCalledTimes(1);
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // A request the API does not take goes to another site.
    await expect(lookup('', { status: 302, headers: { Location: 'https://example.com/' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Hack Prank</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Anousith</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fixture('error'))).rejects.toMatchObject({ kind: 'indeterminate' });
    // A scans request that fails fails the lookup.
    const half = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered').items)).mockResolvedValueOnce(reply(fixture('error')));
    await expect(carrier(half).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known bill by its latest instant and the unknown-bill answer, and asks nothing for a number Anousith does not issue', async () => {
    await expect(carrier(answering(fixture('delivered'))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-03T03:20:30.000Z' });
    await expect(carrier(answering(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('000000000000')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Anousith does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0', '000000000000', '00000000000000', 'LA0000000000001', '000000000000X', "0000000000001'", `${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAnousithNumber(' 0000-0000-00001 ')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const replies = fixture('delivered');
    const flaky = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(replies.items)).mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(replies.items)).mockResolvedValueOnce(reply(replies.scans));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(4);
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

  it('routes a bill filed under Anousith to the adapter, and leaves the bill shape unclaimed', async () => {
    const fetcher = answering(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'anousith' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'anousith', source: 'anousith', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === ANOUSITH_API)).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('anousith');
  });
});

describe('Anousith status vocabulary', () => {
  it('maps every recorded code and wording to the stage it records, and the parser stages scans the same way', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean; confirmedBy: string }[];
    expect(entries.filter((entry) => entry.confirmedBy === 'live').length).toBeGreaterThanOrEqual(8);
    for (const entry of entries) {
      const answer = statusMapAnswer({ carrier: 'anousith', providerCode: entry.code ?? null, description: entry.wording });
      if (entry.unmapped) {
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    for (const name of ['delivered', 'returned']) {
      for (const event of parse(fixture(name), name === 'delivered' ? DELIVERED : RETURNED).events!) {
        expect(statusMap.stage(event.provider_code ?? null, normalizeStatusWording(event.description!)), event.description).toBe(event.stage);
      }
    }
    expect(statusMapAnswer({ carrier: 'anousith', providerCode: 'SCAN_IN', description: 'Sample scan' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'anousith', providerCode: 'COMPLETED', description: 'Sample scan' })).toEqual({ kind: 'unknown' });
  });
});
