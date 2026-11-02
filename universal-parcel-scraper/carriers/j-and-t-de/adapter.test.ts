import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { J_AND_T_APP_ID, J_AND_T_SIGNING_KEY, jAndTWording } from '../j-and-t-au/official.js';
import { adapter, J_AND_T_DE_API, JAndTDeTracker } from './adapter.js';
import { jAndTDeWording, normalizeJAndTDeNumber, parseJAndTDe } from './parser.js';
import { jAndTDeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic waybills in J&T Express Germany's layout; none is a real parcel.
const DELIVERED = 'JTDE123450789013';
const RETURNED = 'JTDE012345678901';
const UNKNOWN = 'JTDE000000000000';

type Row = Record<string, unknown>;
type Answer = Row & { details: Row[] };
type Reply = Row & { data: Answer[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (answer: Answer, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const delivered = (type: string) => jAndTWording(jAndTDeWording(`Your package has been successfully delivered. The delivery type is【${type}】. `
  + 'If you have any questions or complaints, please call our customer service hotline at +49 0000000000.'));

describe('J&T Express Germany HTTP adapter', () => {
  it('posts the whole waybill as the German page does, signed over its sorted fields, once through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('returned')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JAndTDeTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jtde 0123-4567-8901 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(J_AND_T_DE_API);
    expect(J_AND_T_DE_API).toBe('https://official.jtexpress.eu/official/logisticsTracking/getDetailByWaybillNo');
    const headers = init!.headers as Record<string, string>;
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(headers).toMatchObject({ 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0', langType: 'EN',
      timezone: 'GMT+0000', country: 'DE', appId: J_AND_T_APP_ID, key: J_AND_T_SIGNING_KEY,
      timestamp: expect.stringMatching(/^\d{13}$/), nonce: expect.stringMatching(/^0\.\d+$/) });
    expect(headers).not.toHaveProperty('countryCode');
    expect(init!.body).toBe(`{"waybillNos":["${RETURNED}"],"langType":"EN"}`);
    const signed = `${J_AND_T_APP_ID}${headers.timestamp}${headers.nonce}{"langType":"EN","waybillNos":["${RETURNED}"]}${J_AND_T_SIGNING_KEY}`;
    expect(headers.sign).toBe(createHash('md5').update(signed).digest('hex').toUpperCase());
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'j-and-t-de', step: 'direct', outcome: 'ok' }));
  });

  it('reads each scan time as an instant in UTC and keeps the delivery type the site offers', () => {
    const result = parseJAndTDe(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your package has been successfully delivered. The delivery type is Left with neighbor.',
      last_update: '2026-05-14T08:45:09Z', delivered_at: '2026-05-14T08:45:09Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-05-14T08:45:09Z', 'delivered'],
      ['2026-05-14T05:37:59Z', 'out_for_delivery'],
      ['2026-05-14T05:32:17Z', 'in_transit'],
      ['2026-05-14T05:26:38Z', 'in_transit'],
      ['2026-05-13T21:07:38Z', 'accepted'],
    ]);
    expect(result.events![4]!.description).toBe('The shipment has been successfully picked up and is being prepared for transportation');
    expect(JSON.stringify(result)).not.toMatch(/0000000000|hotline|【/);
  });

  it('reads delivery runs, a failed delivery and the return', () => {
    const result = parseJAndTDe(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'The shipment has been returned',
      last_update: '2026-06-10T11:28:14Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.stage)).toEqual(['returned', 'in_transit', 'returned', 'failed_attempt',
      'out_for_delivery', 'out_for_delivery', 'in_transit', 'accepted']);
  });

  it('drops a delivery type the site does not offer, an empty one and the customer service line', () => {
    expect(delivered('Left with neighbor')).toBe('Your package has been successfully delivered. The delivery type is Left with neighbor.');
    expect(delivered('Mailbox')).toBe('Your package has been successfully delivered. The delivery type is Mailbox.');
    for (const type of ['', ' ', 'Signed by recipient', 'Sample Person', 'Sample Street 1']) {
      expect(delivered(type), type).toBe('Your package has been successfully delivered.');
    }
    expect(jAndTDeStage(delivered('Garage'))).toEqual({ stage: 'delivered', source: 'carrier_map' });
    // Other sentences pass unchanged.
    expect(jAndTDeWording('Returns have begun')).toBe('Returns have begun');
  });

  it('keeps an unknown waybill, a moved route, a refusal and a page apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ code: 999001031, msg: '验签失败', data: null, fail: true, succ: false })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<!doctype html><html><title>J&T Express</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    expect(() => parseJAndTDe(fixture('delivered'), RETURNED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'J&T Express Germany answered for another waybill' }));
    expect(() => parseJAndTDe(changed('delivered', (answer) => { answer.details[0]!.scanTime = '14.05.2026 08:45'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects waybills J&T Express Germany does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JTDE01234567890', 'JTDE0123456789012', 'JTAU012345678901', 'JTE300000000000']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).recognize!('JTAU012345678901')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJAndTDeNumber('jtde 0123 4567 8901')).toBe(RETURNED);
  });

  it('recognizes a waybill with scans, and an unknown one as unknown, through the same lookup', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-05-14T08:45:09.000Z' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).recognize!(UNKNOWN))
      .resolves.toEqual({ known: false });
  });

  it('routes a waybill filed under J&T Express Germany, or detected as one of its waybills, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'j-and-t-de' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'j-and-t-de', source: 'j-and-t-de', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'j-and-t-de', source: 'j-and-t-de' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === J_AND_T_DE_API)).toBe(true);
  });
});

describe('J&T Express Germany waybills', () => {
  it('claims JTDE and twelve digits only', () => {
    for (const number of [DELIVERED, RETURNED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'j-and-t-de', confidence: 'high' });
    }
    for (const number of ['JTDE01234567890', 'JTDE0123456789012', 'JTDF012345678901']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('j-and-t-de');
    }
  });
});

describe('J&T Express Germany status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(jAndTDeStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'j-and-t-de', description: 'Your package has been successfully delivered. The delivery type is Mailbox.' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'j-and-t-de', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(jAndTDeStage('Synthetic note')).toBeNull();
  });
});
