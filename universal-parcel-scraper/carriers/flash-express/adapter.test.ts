import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FLASH_EXPRESS_API, FlashExpressTracker } from './adapter.js';
import { flashExpressWording, normalizeFlashExpressNumber, parseFlashExpress } from './parser.js';
import { flashExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'TH0101000000A';
const IN_TRANSIT = 'TH0202000001B';
const UNKNOWN = 'TH9999000000Z';

type Row = Record<string, unknown>;
type Entry = Row & { routes: Row[] };
type Reply = Row & { data: Row & { error_search: unknown[]; list: Entry[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply, entry: Entry) => void) => {
  const reply = fixture(name);
  change(reply, reply.data.list[0]!);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Flash Express HTTP adapter', () => {
  it('posts the whole number in capitals to the tracking page’s lookup once, in English, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FlashExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' th0202-000001b ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(FLASH_EXPRESS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(JSON.parse(String(init!.body))).toEqual({ search: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'flash-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the delivery on the Bangkok clock, without the people and phone numbers the reply names', () => {
    const result = parseFlashExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your parcel has been delivered. Thank you for using Flash Express service.',
      last_update: '2026-03-04T14:28:38+07:00', delivered_at: '2026-03-04T14:28:38+07:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-03-04T14:28:38+07:00', 'DELIVERY_CONFIRM', 'delivered'],
      ['2026-03-04T14:20:55+07:00', 'PHONE', null],
      ['2026-03-04T09:10:00+07:00', 'DELIVERY_TICKET_CREATION_SCAN', 'out_for_delivery'],
      ['2026-03-03T15:16:45+07:00', 'CHANGE_PARCEL_IN_TRANSIT', 'in_transit'],
      ['2026-03-03T13:17:49+07:00', 'CHANGE_PARCEL_CLOSE', 'exception'],
      ['2026-03-03T10:12:00+07:00', 'HURRY_PARCEL', null],
      ['2026-03-02T18:44:00+07:00', 'DETAIN_WAREHOUSE', 'failed_attempt'],
      ['2026-03-02T05:00:12+07:00', 'ARRIVAL_WAREHOUSE_SCAN', 'in_transit'],
      ['2026-03-01T22:16:26+07:00', 'SHIPMENT_WAREHOUSE_SCAN', 'in_transit'],
      ['2026-03-01T20:06:16+07:00', 'ARRIVAL_WAREHOUSE_SCAN', 'in_transit'],
      ['2026-03-01T17:29:40+07:00', 'SHIPMENT_WAREHOUSE_SCAN', 'in_transit'],
      ['2026-03-01T17:29:32+07:00', 'RECEIVE_WAREHOUSE_SCAN', 'accepted'],
      ['2026-03-01T17:11:22+07:00', 'FLASH_HOME_SCAN', 'in_transit'],
      ['2026-03-01T15:32:53+07:00', 'RECEIVE_WAREHOUSE_SCAN', 'accepted'],
      ['2026-03-01T15:32:52+07:00', 'RECEIVED', 'accepted'],
    ]);
    expect(result.events![1]).toMatchObject({ description: 'Call the receiver(2)', location: 'Sample District, Sample Province' });
    // A closure has no place after it.
    expect(result.events![4]).not.toHaveProperty('location');
    expect(result.events!.at(-1)).toMatchObject({ description: 'Your parcel has been picked up by the [FH-Sample Agent] courier.',
      location: 'Origin District, Origin Province' });
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Person|Courier)|In Person|000\*|0000000|fle-asset|signer|【/);
  });

  it('lets the summary decide a journey that ended, whatever scan comes last', () => {
    // Calls and reminders can follow a delivery.
    const late = parseFlashExpress(changed('delivered', (_body, entry) => {
      entry.routes.unshift({ ...entry.routes[5]!, routed_at: '2026-03-05 08:00:00' });
    }), DELIVERED);
    expect(late).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', delivered_at: '2026-03-04T14:28:38+07:00',
      last_status_text: 'The order has been reminded, and the relevant staff are processing it urgently.', last_update: '2026-03-05T08:00:00+07:00' });
    // A parcel closed after a delivery attempt.
    const closed = parseFlashExpress(changed('delivered', (_body, entry) => {
      entry.state = 8;
      entry.routes.splice(0, 4);
    }), DELIVERED);
    expect(closed).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Delivery terminated by exception, Order closed' });
    expect(closed).not.toHaveProperty('delivered_at');
    const returned = parseFlashExpress(changed('in-transit', (_body, entry) => { entry.state = 7; }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
  });

  it('reads the newer wording, whose scans carry no state', () => {
    const result = parseFlashExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The order has been reminded, and the relevant staff are processing it urgently.',
      last_update: '2026-05-08T09:30:00+07:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['HURRY_PARCEL', null, 'The order has been reminded, and the relevant staff are processing it urgently.'],
      ['ARRIVAL_WAREHOUSE_SCAN', 'in_transit', 'Your package has arrived 9SMP_BDC-Sample Town'],
      ['DELIVERY_MARKER', 'failed_attempt', 'Delivery at 9SMP_BDC-Sample Town failed due to Delivery rescheduled.'],
      ['DELIVERY_TICKET_CREATION_SCAN', 'out_for_delivery', 'Your package is currently being delivered by a Flash Express courier.'],
      ['ARRIVAL_WAREHOUSE_SCAN', 'in_transit', 'Your package has arrived 9SMP_BDC-Sample Town'],
      ['SHIPMENT_WAREHOUSE_SCAN', 'in_transit', 'Your shipment is in transit from 5ORG_PDC-Origin Town to 9SMP_BDC-Sample Town.'],
      ['RECEIVE_WAREHOUSE_SCAN', 'accepted', 'Your shipment has been received and stored at 2ORG_PU-Origin Town.'],
      ['RECEIVED', 'accepted', 'Picked up by courier at 2ORG_PU-Origin Town.'],
    ]);
    const delivered = parseFlashExpress(changed('in-transit', (_body, entry) => {
      entry.state = 5;
      entry.routes.unshift({ ...entry.routes[1]!, route_action: 'DELIVERY_CONFIRM', routed_at: '2026-05-08 19:08:49',
        state_text: 'Delivered', message: 'Your shipment has been delivered. Thank you for using Flash Express!,【Sample District】,【Sample Province】' });
    }), IN_TRANSIT);
    expect(delivered).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-05-08T19:08:49+07:00',
      last_status_text: 'Your shipment has been delivered. Thank you for using Flash Express!' });
  });

  it('takes the signer, phone numbers and changed details out of the wording, and the place off its end', () => {
    expect(flashExpressWording('Your parcel has been delivered and signed by 【Sample Person(Reception)】. Thank you for using Flash Express service.,【Sample District】,【Sample Province】'))
      .toEqual({ description: 'Your parcel has been delivered. Thank you for using Flash Express service.', location: 'Sample District, Sample Province' });
    expect(flashExpressWording('พัสดุของคุณถูกเซ็นรับแล้ว เซ็นรับโดย ตัวอย่าง')).toEqual({ description: 'พัสดุของคุณถูกเซ็นรับแล้ว', location: '' });
    expect(flashExpressWording('พัสดุของคุณถูกเซ็นรับแล้ว เซ็นรับโดย【ตัวอย่าง】,【เขตตัวอย่าง】,【จังหวัดตัวอย่าง】'))
      .toEqual({ description: 'พัสดุของคุณถูกเซ็นรับแล้ว', location: 'เขตตัวอย่าง, จังหวัดตัวอย่าง' });
    expect(flashExpressWording('Call the courier on 000-000-0000 or 000****0000 for help,【Sample Province】'))
      .toEqual({ description: 'Call the courier on or for help', location: 'Sample Province' });
    expect(flashExpressWording('ข้อมูลพัสดุมีการเปลี่ยนแปลงชื่อผู้รับ จาก ตัวอย่าง เปลี่ยนเป็น ตัวอย่าง', 'CHANGE_PARCEL_INFO').description)
      .toBe('ข้อมูลพัสดุมีการเปลี่ยนแปลงชื่อผู้รับ');
    expect(flashExpressWording('Your parcel information has been modified, recipient name from Sample to Sample', 'CUSTOMER_CHANGE_PARCEL_INFO').description)
      .toBe('Your parcel information has been modified');
    expect(flashExpressWording('Your parcel information has been modified: address changed to 1 Sample Road', 'CHANGE_PARCEL_INFO').description)
      .toBe('Your parcel information has been modified');
    expect(flashExpressWording('You have modified parcel information.', 'CUSTOMER_CHANGE_PARCEL_INFO').description)
      .toBe('You have modified parcel information.');
    // Only a changed detail loses what follows "from".
    expect(flashExpressWording('Your parcel is being transported from 【A_HUB】to 【B_DC】.').description).toBe('Your parcel is being transported from 【A_HUB】to 【B_DC】.');
    expect(flashExpressWording('Your parcel has arrived at 【SMP_DC】').description).toBe('Your parcel has arrived at 【SMP_DC】');
    // A rescheduled delivery's date stays.
    expect(flashExpressWording('You have changed delivery time：2026-05-09 (please do not operate frequently)').description)
      .toBe('You have changed delivery time：2026-05-09 (please do not operate frequently)');
  });

  it('reads an unknown number as not found, and a shipment without scans as no history', () => {
    expect(() => parseFlashExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFlashExpress(changed('delivered', (_body, entry) => { entry.routes = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseFlashExpress(changed('delivered', (_body, entry) => { delete (entry as Row).routes; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when the reply searched its whole number', () => {
    expect(() => parseFlashExpress(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlashExpress(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlashExpress(changed('in-transit', (_body, entry) => { entry.search_no = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlashExpress(changed('in-transit', (body) => { body.data.list = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page shows another number beside the one searched for some parcels; the search still binds the history.
    const shown = parseFlashExpress(changed('in-transit', (_body, entry) => { entry.pno_display = `TH0202000009C0(${IN_TRANSIT})`; }), IN_TRANSIT);
    expect(shown.events).toHaveLength(8);
    // A known number in a reply that also lists an unknown one.
    const mixed = parseFlashExpress(changed('in-transit', (body) => { body.data.error_search = [UNKNOWN]; }), IN_TRANSIT);
    expect(mixed.current_stage).toBe('in_transit');
  });

  it('keeps a failed lookup apart from a throttled one', () => {
    const failed = (message: string) => ({ code: 0, message, data: null });
    expect(() => parseFlashExpress(failed('Internal server error'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlashExpress(failed('Too many requests, please try again later'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseFlashExpress({ code: 1001, message: 'คุณค้นหาบ่อยเกินไป', data: null }, IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'rate_limited' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.code; },
      (body: Reply) => { body.data = null as never; },
      (body: Reply) => { body.data.list = 'list' as never; },
      (body: Reply) => { delete (body.data as Row).error_search; },
      (_body: Reply, entry: Entry) => { delete entry.search_no; },
      (_body: Reply, entry: Entry) => { entry.state = '2'; },
      (_body: Reply, entry: Entry) => { entry.routes = 'routes' as never; },
      (_body: Reply, entry: Entry) => { entry.routes = Array.from({ length: 501 }, () => entry.routes[0]!); },
      (_body: Reply, entry: Entry) => { entry.routes[0] = 'scan' as never; },
      (_body: Reply, entry: Entry) => { entry.routes[0]!.routed_at = '2026-05-08 09:30'; },
      (_body: Reply, entry: Entry) => { entry.routes[0]!.routed_at = '2026-05-08 24:00:00'; },
      (_body: Reply, entry: Entry) => { entry.routes[0]!.routed_at = 1778207400; },
      (_body: Reply, entry: Entry) => { delete entry.routes[0]!.routed_at; },
      (_body: Reply, entry: Entry) => { entry.routes[0]!.message = ['reminded']; },
      (_body: Reply, entry: Entry) => { entry.routes[0]!.message = ',【Sample District】,【Sample Province】'; },
      (_body: Reply, entry: Entry) => { entry.routes[0]!.route_action = 7; },
    ]) {
      expect(() => parseFlashExpress(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a missing route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.flashexpress.co.th/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>var arg1="0";document.cookie="acw_sc__v2="+arg1</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Flash Express</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Flash Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-03-04T07:28:38.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('TH0101')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Flash Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TH01010000A', 'KER0101000000A', '0101000000A', 'TH010100000000AB', `TH${'0'.repeat(70)}A`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFlashExpressNumber('th 0101-000000-a')).toBe(DELIVERED);
    // A return waybill adds a digit.
    expect(normalizeFlashExpressNumber('TH0202000009C0')).toBe('TH0202000009C0');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Flash Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'flash-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'flash-express', source: 'flash-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === FLASH_EXPRESS_API)).toBe(true);
  });
});

describe('Flash Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(flashExpressStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'flash-express', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(flashExpressStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'flash-express', providerCode: 'DELIVERY_CONFIRM', description: 'Your parcel has been delivered.' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'flash-express', providerCode: 'SYNTHETIC_SCAN', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'flash-express', providerCode: null, description: 'Your parcel has been delivered.' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules; a gap does not.
    expect(flashExpressStage('SYNTHETIC_SCAN', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(flashExpressStage('SYNTHETIC_SCAN', 'Synthetic note')).toBeNull();
    expect(flashExpressStage('PHONE', 'Delivered')).toBeNull();
  });
});
