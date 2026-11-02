import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPEEDAF_API, SpeedafTracker } from './adapter.js';
import { normalizeSpeedafNumber, parseSpeedaf, speedafCode, speedafWording } from './parser.js';
import { speedafStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZA000000002R';
const IN_TRANSIT = 'NG000000001R';
const UNKNOWN = 'MA000000000000';

type Row = Record<string, unknown>;
type Entry = Row & { tracks: Row[] };
type Reply = Row & { data: Entry[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply, entry: Entry) => void) => {
  const reply = fixture(name);
  change(reply, reply.data[0]!);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Speedaf HTTP adapter', () => {
  it('posts the whole number in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SpeedafTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ng0000-00001r ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SPEEDAF_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ mailNoList: [IN_TRANSIT] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'speedaf', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan at its own offset and stages it by its action', () => {
    const result = parseSpeedaf(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Customs clearance in progress', last_update: '2026-05-06T10:15:00+01:00', expected_delivery: null,
      destination_country: 'NG' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-05-06T10:15:00+01:00', '360', 'customs'],
      ['2026-05-06T06:20:00+01:00', '230', 'in_transit'],
      ['2026-05-04T23:40:00+08:00', '220', 'in_transit'],
      ['2026-05-03T14:00:00+08:00', '191', 'in_transit'],
      ['2026-05-02T19:50:25+08:00', '190', 'in_transit'],
      ['2026-05-02T11:01:20+08:00', '181', 'in_transit'],
      ['2026-05-01T15:36:41+08:00', '150', 'accepted'],
    ]);
    expect(result.events!.at(-1)!.description).toBe('[Guangzhou warehouse] [InternationalLogistics] processing, order has been inbounded');
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
  });

  it('keeps the delivery without the people it names, the hidden action or the repeated scan', () => {
    const result = parseSpeedaf(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel delivered 【Collected】; Collection site is 【SMP01-Site】.', last_update: '2026-04-29T16:51:35+02:00',
      delivered_at: '2026-04-29T16:51:35+02:00', destination_country: 'ZA' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['5', 'delivered', 'Parcel delivered 【Collected】; Collection site is 【SMP01-Site】.'],
      ['4', 'out_for_delivery', '【SMP01-Site】scanned for delivery'],
      ['-1:IP06', 'failed_attempt', 'Issue Parcel Reason【Rescheduled delivery】,Reschedule Time【2026-04-28】'],
      ['80', 'in_transit', 'In Transit'],
      ['3:3002', 'in_transit', 'Arrived at Site【SMP01-Site】'],
      ['2:2001', 'in_transit', 'Loaded at 【ZA DC】; Departed for 【SMP01-Site】'],
      ['3:3001', 'in_transit', 'Arrive at Distribution【ZA DC】'],
      ['1', 'in_transit', 'Received in 【ZA speedaf】'],
      ['370', 'in_transit', '【South Africa】Customs Clearance Completed'],
      ['361', 'customs', 'Customs clearance tax paid'],
      // Later than the flight's departure, although its wall clock reads earlier.
      ['360:36001', 'customs', 'pending Tax'],
      ['220', 'in_transit', 'Cargo flight departured'],
      ['191', 'in_transit', 'Delivery to the airport'],
      ['402', 'customs', 'clearance in progress'],
      ['150', 'accepted', '[Guangzhou warehouse] [InternationalLogistics] processing, order has been inbounded'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Courier|Picker)|SAMPLE RECIPIENT|0000000000|Problem|pod\/view|topay|Android/);
  });

  it('shows the hidden action when the waybill carries its exception flag', () => {
    const result = parseSpeedaf(changed('delivered', (_body, entry) => { entry.blExceptionSign = true; }), DELIVERED);
    expect(result.events!.find((event) => event.provider_code === '-2')).toMatchObject({ description: 'Problem parcel' });
  });

  it('takes the people and phone numbers out of the English and Chinese wording', () => {
    expect(speedafWording('【Sample Courier】in 【SMP01-Site】scanned for delivery; The delivery courier is 【Sample Courier】【0000000000】.'))
      .toBe('【SMP01-Site】scanned for delivery');
    expect(speedafWording('Received in 【ZA speedaf】，Pick-Up Courier is【Sample Picker】')).toBe('Received in 【ZA speedaf】');
    expect(speedafWording('Received in【Sample Site】，The pick-up is 【Sample Picker】')).toBe('Received in【Sample Site】');
    expect(speedafWording('包裹【已签收】,签收人是【样本】,签收网点是【SMP01-Site】')).toBe('包裹【已签收】,签收网点是【SMP01-Site】');
    expect(speedafWording('【SMP01-Site】已做派件扫描，扫描员是【样本】，派件员是【样本】【+000 00 000 0000】')).toBe('【SMP01-Site】已做派件扫描');
    expect(speedafWording('【ISB CITY】scanned for delivery;The courier is 【Sample Rider】')).toBe('【ISB CITY】scanned for delivery');
    expect(speedafWording('【Parcel delivered】 and Received by【Sample Person】')).toBe('【Parcel delivered】');
    // A rescheduled delivery's new day stays.
    expect(speedafWording('Issue Parcel Reason【Rescheduled delivery】,Reschedule Time【2026-04-28】'))
      .toBe('Issue Parcel Reason【Rescheduled delivery】,Reschedule Time【2026-04-28】');
    // The courier's label ends the wording, whatever follows it.
    expect(speedafWording('【Sample Site】scanned for delivery;The courier is Sample Person 000(0)000 00 00 00')).toBe('【Sample Site】scanned for delivery');
    expect(speedafWording('包裹【已签收】,签收人：样本')).toBe('包裹【已签收】');
    // A label without its brackets takes the rest of the wording with it, and a phone number goes wherever it is.
    expect(speedafWording('Delivered, signed by Sample Person at the door')).toBe('Delivered');
    expect(speedafWording('Call the site on 0000000000 to arrange delivery')).toBe('Call the site on to arrange delivery');
    expect(speedafWording('Call the site on +000 (0)00 00 00 00 or 000-000-0000.')).toBe('Call the site on or.');
    expect(speedafWording('Arrived at Site【Sample Site 0216】')).toBe('Arrived at Site【Sample Site 0216】');
  });

  it('reads Indian Ocean scans at the offset Speedaf gives them', () => {
    const result = parseSpeedaf(changed('in-transit', (_body, entry) => {
      entry.countryCode = 'RE';
      for (const row of entry.tracks) if (row.timezone === 1) row.timezone = 4;
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-05-06T10:15:00+04:00', destination_country: 'RE' });
    expect(result.events!.slice(0, 3).map((event) => event.time)).toEqual([
      '2026-05-06T10:15:00+04:00', '2026-05-06T06:20:00+04:00', '2026-05-04T23:40:00+08:00',
    ]);
  });

  it('falls back to the Chinese wording and keeps a wall clock without a usable offset', () => {
    const result = parseSpeedaf(changed('in-transit', (_body, entry) => {
      entry.tracks[0]!.msgEng = '';
      entry.tracks[0]!.timezone = null;
      entry.tracks[1]!.timezone = 'GMT+1';
      entry.tracks[2]!.timezone = '8';
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_status_text: '清关中', last_update: null, last_update_local: '2026-05-06T10:15:00' });
    expect(result.events!.slice(0, 3).map((event) => [event.time ?? null, event.local_time ?? null])).toEqual([
      [null, '2026-05-06T10:15:00'], [null, '2026-05-06T06:20:00'], ['2026-05-04T23:40:00+08:00', null],
    ]);
  });

  it('reads an unknown number as not found, and a record without scans as no history', () => {
    expect(() => parseSpeedaf(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSpeedaf(changed('delivered', (_body, entry) => { entry.tracks = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // Only the hidden action: the page shows nothing either.
    expect(() => parseSpeedaf(changed('delivered', (_body, entry) => { entry.tracks = entry.tracks.filter((row) => row.action === '-2'); }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when its own number is in the reply', () => {
    expect(() => parseSpeedaf(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpeedaf(changed('in-transit', (body) => { body.data = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpeedaf(changed('in-transit', (_body, entry) => { entry.mailNo = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Scans of another piece are not this waybill's history.
    expect(() => parseSpeedaf(changed('in-transit', (_body, entry) => {
      for (const row of entry.tracks) row.mailNo = 'NG000000009R';
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Speedaf answered with scans of another shipment' }));
    const mixed = parseSpeedaf(changed('in-transit', (_body, entry) => { entry.tracks[0]!.mailNo = 'NG000000009R'; }), IN_TRANSIT);
    expect(mixed.events).toHaveLength(6);
  });

  it('keeps a failed lookup apart from a throttled one', () => {
    const failed = (message: string) => ({ success: false, error: { code: '500', message }, data: null });
    expect(() => parseSpeedaf(failed('Internal server error, please try again later.'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpeedaf(failed('请求过于频繁'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseSpeedaf(failed('Too many requests'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.success; },
      (body: Reply) => { body.data = null as never; },
      (_body: Reply, entry: Entry) => { delete entry.mailNo; },
      (_body: Reply, entry: Entry) => { entry.tracks = 'tracks' as never; },
      (_body: Reply, entry: Entry) => { entry.tracks = Array.from({ length: 501 }, () => entry.tracks[0]!); },
      (_body: Reply, entry: Entry) => { entry.countryCode = 1; },
      (_body: Reply, entry: Entry) => { entry.tracks[0] = 'scan' as never; },
      (_body: Reply, entry: Entry) => { entry.tracks[0]!.time = '2026-05-06 10:15'; },
      (_body: Reply, entry: Entry) => { entry.tracks[0]!.time = '2026-05-06 24:00:00'; },
      (_body: Reply, entry: Entry) => { delete entry.tracks[0]!.time; },
      (_body: Reply, entry: Entry) => { entry.tracks[0]!.msgEng = ['Customs clearance in progress']; },
      (_body: Reply, entry: Entry) => {
        entry.tracks[0]!.msgEng = null;
        entry.tracks[0]!.message = null;
        entry.tracks[0]!.actionName = null;
      },
    ]) {
      expect(() => parseSpeedaf(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a missing route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.speedaf.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>var arg1="0";document.cookie="acw_sc__v2="+arg1</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Speedaf</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Speedaf does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-04-29T14:51:35.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ZA-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Speedaf does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZA00000', 'SAMPLETRACKING', `ZA${'0'.repeat(30)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpeedafNumber('za 000-000-002 r')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'customs' });
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

  it('routes a number filed under Speedaf to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'speedaf' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'speedaf', source: 'speedaf', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === SPEEDAF_API)).toBe(true);
  });
});

describe('Speedaf numbers', () => {
  it('only suggests Speedaf for IE and twelve digits, the layout it gives other countries’ parcels', () => {
    for (const number of ['IE120000000017', 'ie 1200 0000 0017', 'IE120000000017T']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['speedaf'] });
    }
    for (const other of ['IE12000000017', 'IE1200000000170', 'IL120000000017']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('speedaf');
    }
  });
});

describe('Speedaf status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(speedafStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'speedaf', providerCode: '360:36001', description: 'pending Tax' })).toEqual({ kind: 'mapped', stage: 'customs' });
    // A sub-action the map does not name takes its action's stage, apart from an issue scan's reason.
    expect(speedafStage('401:9999', 'Clearance Exception')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(speedafStage('-1:IP99', 'Issue Parcel Reason【Synthetic reason】')).toBeNull();
    expect(statusMapAnswer({ carrier: 'speedaf', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(speedafStage('999', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(speedafStage('999', 'Synthetic note')).toBeNull();
    expect(speedafCode({ action: '3', subAction: '3001' })).toBe('3:3001');
    expect(speedafCode({ action: '5', subAction: '5' })).toBe('5');
    expect(speedafCode({ action: '4', subAction: null })).toBe('4');
  });
});
