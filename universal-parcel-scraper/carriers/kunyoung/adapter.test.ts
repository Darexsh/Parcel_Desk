import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KUNYOUNG_LOOKUP, KunyoungTracker } from './adapter.js';
import { normalizeKunyoungNumber, parseKunyoung } from './parser.js';
import { kunyoungStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '3000000011';
const IN_TRANSIT = '3000000022';
const UNKNOWN = '3000000099';

type Reply = { success: boolean; msgCode: string; rows: Record<string, unknown>[] };
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const reply = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(JSON.stringify(fixture(name))));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// A scan as the reply lists it, with the fields the adapter reads.
const scan = (fields: Record<string, unknown>) => ({ writeDate: '2026-10-14 09:00:00', shopName: '예시터미널', userName: '', phoneNumber: '',
  goodsContent: '샘플 상태입니다.', goodsType: '샘플', deliveryContent: '', goodsTypeSP: 'V', fileUrl: '', ...fields });
const withRows = (name: string, change: (rows: Record<string, unknown>[]) => unknown[]) => {
  const body = fixture(name);
  return { ...body, rows: change(body.rows) };
};
const events = (result: ReturnType<typeof parseKunyoung>) => result.events!.map((event) => [event.time, event.provider_code ?? null,
  event.description, event.stage ?? null, event.location ?? null]);

describe('Kunyoung Express HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KunyoungTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 3000-0000-22 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(KUNYOUNG_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    // Multipart form data, as the page sends it, with the number alone.
    const body = init!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect([...body.keys()]).toEqual(['invoiceNumber']);
    expect(body.get('invoiceNumber')).toBe(IN_TRANSIT);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kunyoung', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history newest first as Korean clocks, without the driver, phone numbers or photo', () => {
    const result = parseKunyoung(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송을 완료하였습니다.', last_update: '2026-03-05T06:20:30Z', expected_delivery: null,
      delivered_at: '2026-03-05T06:20:30Z',
    });
    for (const field of ['summary_only', 'receiver_name', 'sender_name', 'history_truncated']) expect(result).not.toHaveProperty(field);
    expect(events(result)).toEqual([
      ['2026-03-05T06:20:30Z', 'Y', '배송을 완료하였습니다.', 'delivered', '예시대리점'],
      ['2026-03-04T10:20:00Z', 'V', '배송할 터미널에 도착하였습니다.', 'in_transit', '샘플터미널'],
      // The page marks a scan without a site with a dash.
      ['2026-03-04T10:10:00Z', 'A', '배송 예정인 상품을 접수하였습니다.', 'accepted', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/홍길동|010-0000-0000|00가0000|example\.invalid|SAMPLE|H0000|U0000|완료"|도착"|접수"/);
  });

  it('reads an in-transit history by its newest staged scan', () => {
    const result = parseKunyoung(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '배송할 터미널에 도착하였습니다.', last_update: '2026-10-12T23:50:00Z', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result).map(([time, code, , stage]) => [time, code, stage])).toEqual([
      ['2026-10-12T23:50:00Z', 'V', 'in_transit'],
      ['2026-10-12T23:40:00Z', 'A', 'accepted'],
    ]);
    // A code the map does not know keeps its scan without a stage; the newest staged scan decides.
    const driven = parseKunyoung(withRows('in-transit', (rows) => [scan({ writeDate: '2026-10-14 08:00:00', goodsTypeSP: 'G',
      shopName: '예시대리점', userName: '김예시', phoneNumber: '010-0000-0000' }), ...rows]), IN_TRANSIT);
    expect(driven).toMatchObject({ current_stage: 'in_transit', last_status_text: '샘플 상태입니다.', last_update: '2026-10-13T23:00:00Z' });
    expect(driven.events![0]).toMatchObject({ provider_code: 'G', location: '예시대리점' });
    expect(driven.events![0]).not.toHaveProperty('stage');
    expect(JSON.stringify(driven)).not.toMatch(/김예시|010-0000-0000/);
  });

  it('writes a detailed scan as its details and status line, and keeps no site that names a person', () => {
    const detailed = parseKunyoung(withRows('in-transit', (rows) => [scan({ goodsTypeSP: 'N', deliveryContent: '샘플사유', goodsContent: '샘플 안내입니다.' }),
      ...rows]), IN_TRANSIT);
    expect(detailed.events![0]).toMatchObject({ description: '샘플사유 샘플 안내입니다.', provider_code: 'N' });
    // Another code's details are not part of its line, as on the page.
    const plain = parseKunyoung(withRows('in-transit', (rows) => [scan({ deliveryContent: '샘플사유' }), ...rows]), IN_TRANSIT);
    expect(plain.events![0]!.description).toBe('샘플 상태입니다.');
    for (const shopName of ['김*시', '예시 배송기사', '-', '', null]) {
      const result = parseKunyoung(withRows('in-transit', (rows) => [scan({ shopName }), ...rows]), IN_TRANSIT);
      expect(result.events![0], String(shopName)).not.toHaveProperty('location');
    }
    const phoned = parseKunyoung(withRows('in-transit', (rows) => [scan({ shopName: '예시터미널 (031-000-0000)' }), ...rows]), IN_TRANSIT);
    expect(phoned.events![0]!.location).toBe('예시터미널');
  });

  it('keeps a repeated scan once and lists a history the reply gives oldest first newest first', () => {
    const repeated = parseKunyoung(withRows('delivered', (rows) => [rows[0], ...rows]), DELIVERED);
    expect(repeated.events).toHaveLength(3);
    const reversed = parseKunyoung(withRows('delivered', (rows) => [...rows].reverse()), DELIVERED);
    expect(events(reversed)).toEqual(events(parseKunyoung(fixture('delivered'), DELIVERED)));
    // A clock with a fraction of a second keeps its second.
    const fraction = parseKunyoung(withRows('in-transit', (rows) => [scan({ writeDate: '2026-10-14 09:00:00.0' }), ...rows]), IN_TRANSIT);
    expect(fraction.last_update).toBe('2026-10-14T00:00:00Z');
  });

  it('reads the empty answer as not found, and an error answer as inconclusive', () => {
    expect(() => parseKunyoung(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseKunyoung({ success: false, msgCode: '9', msgDesc: '샘플 오류' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Kunyoung Express answered with an error' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (rows: Record<string, unknown>[]) => [scan({ writeDate: '2026-02-30 09:00:00' }), ...rows],
      (rows: Record<string, unknown>[]) => [scan({ writeDate: '2026-10-14 24:00:00' }), ...rows],
      (rows: Record<string, unknown>[]) => [scan({ writeDate: '2026.10.14 09:00' }), ...rows],
      (rows: Record<string, unknown>[]) => [scan({ writeDate: '2026-10-14T09:00:00+09:00' }), ...rows],
      (rows: Record<string, unknown>[]) => [scan({ writeDate: undefined }), ...rows],
      (rows: Record<string, unknown>[]) => [scan({ goodsContent: '' }), ...rows],
      (rows: Record<string, unknown>[]) => [scan({ goodsContent: 7 }), ...rows],
      (rows: Record<string, unknown>[]) => [scan({ goodsTypeSP: 'VV' }), ...rows],
      (rows: Record<string, unknown>[]) => [scan({ shopName: ['예시터미널'] }), ...rows],
      (rows: Record<string, unknown>[]) => ['예시', ...rows],
      (rows: Record<string, unknown>[]) => Array.from({ length: 501 }, () => rows[0]),
    ]) {
      expect(() => parseKunyoung(withRows('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], 'rows', {}, { msgCode: 0, rows: [] }, { msgCode: '0' }, { msgCode: '0', rows: {} }]) {
      expect(() => parseKunyoung(body, UNKNOWN), JSON.stringify(body)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a reply its server labels EUC-KR', async () => {
    // {"msgCode":"0","rows":[{..."goodsContent":"배송을 완료하였습니다."...}]} with the line in EUC-KR.
    const line = Buffer.from('b9e8bcdbc0bb20bfcfb7e1c7cfbfb4bdc0b4cfb4d92e', 'hex');
    const [head, tail] = JSON.stringify({ msgCode: '0', rows: [scan({ goodsTypeSP: 'Y', goodsContent: '@' })] }).split('@');
    const body = Buffer.concat([Buffer.from(head!), line, Buffer.from(tail!)]);
    await expect(carrier(answering(() => reply(new Uint8Array(body), { headers: { 'Content-Type': 'text/html; charset=EUC-KR' } })))
      .track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered', last_status_text: '배송을 완료하였습니다.' });
    await expect(carrier(answering(() => reply(new Uint8Array(body)))).track({ number: DELIVERED }))
      .resolves.not.toMatchObject({ last_status_text: '배송을 완료하였습니다.' });
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply(`\uFEFF${JSON.stringify(fixture('not-found'))}`))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://mj.kunyoung.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>건영택배</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply(''))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty answer, and asks nothing for a number Kunyoung does not issue', async () => {
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T06:20:30.000Z' });
    await expect(carrier(page('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(answering(() => reply(JSON.stringify({ msgCode: '9' })))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('300000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Kunyoung does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '300000001', '30000000111', '300000001A', 'A300000001', '3000000011.5', `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of ['3000 0000 11', '3000-0000-11', ' 3000000011 ']) expect(normalizeKunyoungNumber(raw), raw).toBe(DELIVERED);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(JSON.stringify(fixture('in-transit'))) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    // Each try sends its own form.
    expect((recovered.fetcher.mock.calls[1]![1]!.body as FormData).get('invoiceNumber')).toBe(IN_TRANSIT);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number the caller names Kunyoung’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'kunyoung' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'kunyoung', source: 'kunyoung', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === KUNYOUNG_LOOKUP
      && (init?.body as FormData).get('invoiceNumber') === DELIVERED)).toBe(true);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toEqual({ mode: 'automatic', adapter: 'kunyoung', steps: ['direct', 'retry'], recognition: { rank: 622 } });
  });
});

describe('Kunyoung Express numbers', () => {
  it('leaves ten digits to the caller’s choice, and reads tracker links', () => {
    // Many Korean carriers print ten digits, so neither detection nor recognition offers Kunyoung.
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('kunyoung');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('kunyoung');
    for (const link of [
      `https://mj.kunyoung.com/?invoiceNumber=${DELIVERED}`,
      `http://www.kunyoung.com/goods/goods_01.php?mulno=${DELIVERED}`,
      `https://www.kunyoung.com/goods/goods_02.php?mulno=${DELIVERED}`,
      `http://kunyoung.com/goods/goods_01__.php?mulno=${DELIVERED}`,
      `http://www.kunyoung.com/goods/goods_02__.php?mulno=${DELIVERED}`,
    ]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'kunyoung', source: 'link' });
    }
  });
});

describe('Kunyoung Express status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      // The line alone stages a scan that comes without its code.
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(kunyoungStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'kunyoung', providerCode: 'Y', description: '배송을 완료하였습니다.' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'kunyoung', providerCode: 'G', description: '샘플 상태입니다.' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to its line, then the shared rules, else stays without a stage.
    expect(kunyoungStage('G', '배송할 터미널에 도착하였습니다.')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(kunyoungStage('G', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(kunyoungStage('G', '샘플 상태입니다.')).toBeNull();
  });
});
