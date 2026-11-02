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
import { adapter, NIM_EXPRESS_TRACKING, nimExpressTrackingUrl, NimExpressTracker } from './adapter.js';
import { normalizeNimExpressNumber, parseNimExpress } from './parser.js';
import { nimExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '0000000000001';
const IN_TRANSIT = '0000000000002';
const UNKNOWN = '0000000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// The timeline's entries, newest first, as the page lists them.
const TIMELINE = /(<ul class="nx-tracking-timeline">\n)([\s\S]*?)(\s*<\/ul>)/;
const withItems = (html: string, change: (items: string) => string) => html.replace(TIMELINE, (_, head: string, items: string, end: string) =>
  `${head}${change(items)}${end}`);
const item = (date: string, wording: string, ref?: string) => `<li class="nx-tracking-timeline__item">
  <span class="nx-tracking-timeline__dot"></span>
  <div class="nx-tracking-timeline__body">
    <div class="nx-tracking-timeline__date">${date}</div>
    <div class="nx-tracking-timeline__desc">
      ${wording}
      ${ref === undefined ? '' : `<br><span class="nx-tracking-timeline__ref">${ref}</span>`}
    </div>
  </div>
</li>`;
const events = (result: ReturnType<typeof parseNimExpress>) => result.events!.map((event) => [event.time, event.description,
  event.stage ?? null, event.location ?? null]);

describe('Nim Express HTTP adapter', () => {
  it('asks the tracking page for the whole number, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NimExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000-0000-000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${NIM_EXPRESS_TRACKING}?h_i=${IN_TRANSIT}`);
    expect(nimExpressTrackingUrl('0000 0000 00001')).toBe(`${NIM_EXPRESS_TRACKING}?h_i=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'nim-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered timeline newest first, in Bangkok time, at branches named without their codes', () => {
    const result = parseNimExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'จัดส่งสำเร็จ',
      last_update: '2026-03-04T14:05:10+07:00', delivered_at: '2026-03-04T14:05:10+07:00', expected_delivery: null,
    });
    for (const field of ['summary_only', 'last_update_local', 'receiver_name', 'sender_name', 'history_truncated']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-03-04T14:05:10+07:00', 'จัดส่งสำเร็จ', 'delivered', null],
      ['2026-03-04T09:12:30+07:00', 'อยู่ระหว่างจัดส่ง ครั้งที่ 1', 'out_for_delivery', null],
      ['2026-03-04T06:40:05+07:00', 'พัสดุถึงสาขาปลายทาง', 'in_transit', 'DC สมมติ'],
      ['2026-03-03T21:30:00+07:00', 'พัสดุออกจากศูนย์คัดแยก', 'in_transit', 'ศูนย์คัดแยก ทดสอบ'],
      ['2026-03-03T02:20:15+07:00', 'พัสดุถึงศูนย์คัดแยก', 'in_transit', 'ศูนย์คัดแยก ทดสอบ'],
      ['2026-03-02T18:00:40+07:00', 'พัสดุออกจากต้นทาง', 'in_transit', 'DC ตัวอย่าง'],
      ['2026-03-02T17:10:20+07:00', 'รับพัสดุเข้า', 'accepted', 'DC ตัวอย่าง'],
      ['2026-03-02T12:30:00+07:00', 'Nim Express เข้ารับพัสดุเรียบร้อยแล้ว', 'accepted', null],
      ['2026-03-02T10:00:00+07:00', 'Nim Express กำลังเข้ารับพัสดุ', 'registered', null],
      ['2026-03-02T08:30:00+07:00', 'ยืนยันเข้ารับ วันที่ 02/03/2569 12:00 - 16:00', 'registered', 'DC ตัวอย่าง'],
      ['2026-03-01T20:00:00+07:00', `ผู้ส่งสร้างบิลเข้าระบบ Tracking no. ${DELIVERED}`, 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && !('provider_code' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2\.1|checkDataBill|ประเภทผู้แจ้งข้อมูล/);
  });

  it('reads an in-transit timeline by its newest staged scan, from a drop point', () => {
    const result = parseNimExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'พัสดุถึงศูนย์คัดแยก',
      last_update: '2026-10-11T03:30:00+07:00', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result)).toEqual([
      ['2026-10-11T03:30:00+07:00', 'พัสดุถึงศูนย์คัดแยก', 'in_transit', 'ศูนย์คัดแยก ทดสอบ'],
      ['2026-10-10T19:00:00+07:00', 'พัสดุออกจากต้นทาง', 'in_transit', 'DC ทดสอบ'],
      ['2026-10-10T16:20:00+07:00', 'รับพัสดุเข้า', 'accepted', 'DC ทดสอบ'],
      ['2026-10-10T10:25:00+07:00', `สร้างบิลเข้าระบบ Tracking no. ${IN_TRANSIT}`, 'registered', 'Drop point สาขา ตัวอย่าง'],
    ]);
    // A wording the map does not know is kept without a stage; the newest staged scan decides.
    const unlabelled = parseNimExpress(withItems(fixture('in-transit'), (items) => `${item('11/10/2569 08:00:00', 'สถานะตัวอย่าง')}${items}`), IN_TRANSIT);
    expect(unlabelled).toMatchObject({ current_stage: 'in_transit', last_status_text: 'สถานะตัวอย่าง', last_update: '2026-10-11T08:00:00+07:00' });
    expect(unlabelled.events![0]).not.toHaveProperty('stage');
    // A later delivery round, and the earlier page's failed delivery.
    const round = parseNimExpress(withItems(fixture('in-transit'), (items) => `${item('12/10/2569 09:00:00', 'อยู่ระหว่างจัดส่ง ครั้งที่ 2')}${items}`), IN_TRANSIT);
    expect(round).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    const failed = parseNimExpress(withItems(fixture('in-transit'), (items) => `${item('12/10/2569 17:00:00', 'สินค้าจัดส่งไม่ได้', '9 DC สมมติ')}${items}`), IN_TRANSIT);
    expect(failed).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(failed.events![0]).toMatchObject({ location: 'DC สมมติ' });
  });

  it('orders entries by their clocks, and keeps a repeated entry once', () => {
    const repeated = parseNimExpress(withItems(fixture('in-transit'), (items) => `${items}${item('11/10/2569 03:30:00', 'พัสดุถึงศูนย์คัดแยก', '102 ศูนย์คัดแยก ทดสอบ')}`), IN_TRANSIT);
    expect(repeated.events).toHaveLength(4);
    const late = parseNimExpress(withItems(fixture('in-transit'), (items) => `${items}${item('12/10/2569 06:00:00', 'พัสดุถึงสาขาปลายทาง', '9 DC สมมติ')}`), IN_TRANSIT);
    expect(late.events![0]).toMatchObject({ time: '2026-10-12T06:00:00+07:00', description: 'พัสดุถึงสาขาปลายทาง' });
    expect(late).toMatchObject({ last_update: '2026-10-12T06:00:00+07:00' });
  });

  it('reads the card’s error as not found, and a parcel only when the card names the number asked', () => {
    expect(() => parseNimExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // An answer for another number is no answer, either way.
    expect(() => parseNimExpress(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Nim Express answered for another number' }));
    expect(() => parseNimExpress(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Nim Express answered for another number' }));
    // A twelve-digit number is not the thirteen-digit one it starts.
    expect(() => parseNimExpress(fixture('delivered'), DELIVERED.slice(1)))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseNimExpress(withItems(fixture('in-transit'), () => ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (html: string) => html.replace('nx-tracking-card__title', 'nx-tracking-card__heading'),
      (html: string) => html.replace('1. Tracking no.', 'Tracking no.'),
      (html: string) => html.replace('class="nx-tracking-timeline"', 'class="nx-tracking-steps"'),
      (html: string) => html.replace(/<div class="nx-tracking-card">[\s\S]*<\/ul>\s*<\/div>/, (card) => `${card}${card}`),
      (html: string) => withItems(html, (items) => `${item('30/02/2569 09:00:00', 'พัสดุถึงสาขาปลายทาง')}${items}`),
      (html: string) => withItems(html, (items) => `${item('12/10/2026 09:00:00', 'พัสดุถึงสาขาปลายทาง')}${items}`),
      (html: string) => withItems(html, (items) => `${item('12/10/2569 24:00:00', 'พัสดุถึงสาขาปลายทาง')}${items}`),
      (html: string) => withItems(html, (items) => `${item('12/10/2569 09:00', 'พัสดุถึงสาขาปลายทาง')}${items}`),
      (html: string) => withItems(html, (items) => `${item('12/10/2569 09:00:00', '', '9 DC สมมติ')}${items}`),
      (html: string) => withItems(html, (items) => `${item('12/10/2569 09:00:00', 'พัสดุถึงสาขาปลายทาง', '9 DC สมมติ</span><span class="nx-tracking-timeline__ref">9 DC สมมติ')}${items}`),
      (html: string) => withItems(html, (items) => `<li class="nx-tracking-row">พัสดุถึงสาขาปลายทาง</li>${items}`),
      (html: string) => withItems(html, (items) => `${items}${item('12/10/2569 09:00:00', 'พัสดุถึงสาขาปลายทาง').repeat(500)}`),
      (html: string) => html.replace('<ul class="nx-tracking-timeline">', '<p class="nx-tracking-card__error">Tracking no. ไม่ถูกต้อง</p><ul class="nx-tracking-timeline">'),
    ]) {
      expect(() => parseNimExpress(change(fixture('in-transit')), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['', '<html><body>Nim Express</body></html>', fixture('not-found').replace('Tracking no. ไม่ถูกต้อง</p>', 'ระบบขัดข้อง</p>')]) {
      expect(() => parseNimExpress(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://www.nimexpress.com/web/p/home' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>Nim Express</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the card’s error, and asks nothing for a number Nim Express does not issue', async () => {
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T07:05:10.000Z' });
    await expect(carrier(page('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another parcel is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('00000000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Nim Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '00000000001', '00000000000001', '000000000000A', 'A000000000001', '0000000000.1', `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of ['0000 0000 00001', '000-0000-000001', ' 0000000000001 ']) expect(normalizeNimExpressNumber(raw), raw).toBe(DELIVERED);
    expect(normalizeNimExpressNumber('000000000001')).toBe('000000000001');
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number the caller names Nim Express’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'nim-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'nim-express', source: 'nim-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === nimExpressTrackingUrl(DELIVERED))).toBe(true);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toEqual({ mode: 'automatic', adapter: 'nim-express', steps: ['direct', 'retry'], recognition: { rank: 631 } });
  });
});

describe('Nim Express numbers', () => {
  it('leaves twelve and thirteen digits to the caller’s choice, and reads tracker links', () => {
    // Many carriers print these digit runs, so neither detection nor recognition offers Nim Express.
    for (const number of [DELIVERED, DELIVERED.slice(1)]) {
      expect(detectCarrierMatch(number).carrier).not.toBe('nim-express');
      expect(recognitionAskedCarriers(number)).not.toContain('nim-express');
    }
    for (const link of [`https://www.nimexpress.com/web/p/tracking?h_i=${DELIVERED}`, `http://nimexpress.com/web/p/tracking?i=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'nim-express', source: 'link' });
    }
  });
});

describe('Nim Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(nimExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'nim-express', providerCode: null, description: 'จัดส่งสำเร็จ' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'nim-express', providerCode: null, description: 'สถานะตัวอย่าง' })).toEqual({ kind: 'unknown' });
    // The bill number, the pickup day and window and the delivery round do not change a wording.
    expect(nimExpressStage(`ผู้ส่งสร้างบิลเข้าระบบ Tracking no. ${IN_TRANSIT}`)).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(nimExpressStage('ยืนยันเข้ารับ วันที่ 12/10/2569 09:00 - 12:00')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(nimExpressStage('อยู่ระหว่างจัดส่ง ครั้งที่ 3')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    // A wording the map does not know falls to the shared rules, else stays without a stage.
    expect(nimExpressStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(nimExpressStage('สถานะตัวอย่าง')).toBeNull();
  });
});
