import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DPD_AT_SEARCH, DpdAtTracker } from './adapter.js';
import { dpdAtNumber, parseDpdAt, readDpdAt } from './parser.js';
import { dpdAtStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '06210000000001';
const IN_TRANSIT = '01900000000002';
const UNKNOWN = '06200000000003';

type Row = Record<string, unknown>;
type Scan = Row & { depotData: unknown; state: Row };
type Parcel = Row & { lifecycle: Row & { entries: Scan[] } };
type Reply = Row & { data: Parcel[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const CHALLENGE = readFileSync(new URL('./fixtures/challenge.html', import.meta.url), 'utf8');
const changed = (name: string, change: (parcel: Parcel, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPD Austria HTTP adapter', () => {
  it('posts the fourteen digits to myDPD’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    // DPD's check character after the number is dropped, as the page drops spaces.
    await expect(new DpdAtTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0621 0000 0000 01 6 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(DPD_AT_SEARCH);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `"${DELIVERED}"`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpd-at', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an Austrian delivery newest first, in Vienna’s winter time, with each scan at its depot', () => {
    const result = parseDpdAt(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Paket wurde erfolgreich abgestellt', last_update: '2026-01-12T10:47:00+01:00', expected_delivery: null,
      delivered_at: '2026-01-12T10:47:00+01:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.provider_code, event.stage])).toEqual([
      ['2026-01-12T10:47:00+01:00', 'Sample Valley, AT', 'DELIVERED/ASG', 'delivered'],
      // The reply names a depot on its first scan there; the later ones keep it.
      ['2026-01-12T06:18:00+01:00', 'Sample Valley, AT', 'IN_DELIVERY', 'out_for_delivery'],
      // The repeated depot scan is kept once.
      ['2026-01-12T05:51:00+01:00', 'Sample Valley, AT', 'IN_DEPOT', 'in_transit'],
      ['2026-01-10T23:04:00+01:00', 'Example Hub, AT', 'ON_THE_WAY', 'in_transit'],
      ['2026-01-10T17:12:00+01:00', 'Sample Town, AT', 'ON_THE_WAY', 'in_transit'],
      // The order data names the depot only by its code, one of DPD Austria's.
      ['2026-01-09T18:30:00+01:00', null, 'ORDER_DATA', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The place the recipient chose, which the page adds to the delivery, is not kept.
    expect(JSON.stringify(result)).not.toMatch(/garage|banner|statusMessage|volume/i);
  });

  it('reads a parcel from German depots waiting in a Pickup station, in summer time on both sides of the border', () => {
    const result = parseDpdAt(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Paket wurde in der Pickup Paketstation hinterlegt', last_update: '2026-06-04T11:41:00+02:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('pickup_point');
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.provider_code, event.stage])).toEqual([
      ['2026-06-04T11:41:00+02:00', 'Sample Dorf, AT', 'HANDOVER/BOX', 'ready_for_pickup'],
      // Of two scans sharing a clock, the later in the reply is the newer.
      ['2026-06-04T11:30:00+02:00', 'Sample Dorf, AT', 'IN_DELIVERY/BOX', 'out_for_delivery'],
      ['2026-06-04T11:30:00+02:00', 'Sample Dorf, AT', 'NAB', 'failed_attempt'],
      ['2026-06-04T06:22:00+02:00', 'Sample Dorf, AT', 'IN_DELIVERY', 'out_for_delivery'],
      ['2026-06-04T06:15:00+02:00', 'Sample Dorf, AT', 'IN_DEPOT', 'in_transit'],
      ['2026-06-02T22:40:00+02:00', 'Example Hub, DE', 'ON_THE_WAY', 'in_transit'],
      ['2026-06-02T15:10:00+02:00', 'Sample Stadt, DE', 'ON_THE_WAY', 'in_transit'],
      // A German depot keeps Vienna's clock too: another of its scans names its country.
      ['2026-06-01T12:05:00+02:00', null, 'ORDER_DATA', 'registered'],
    ]);
    expect(result.events![2]).toMatchObject({ description: 'Empfänger leider nicht angetroffen.' });
  });

  it('reads a driver’s collection from a shop as the acceptance, a hand-over in transit, or the way back after the parcel waited there', () => {
    const collection = (entry: Scan, datetime: string) => ({ ...entry, datetime, state: { ...entry.state, datetime, name: 'DRIVER_PICKUP', additionalInfo: 'SHOP',
      text: 'Parcel was picked up by driver from Pickup parcel shop', textShort: 'Picked up by driver' } });
    const stages = (entries: (entries: Scan[]) => Scan[]) => parseDpdAt(changed('in-transit', (parcel) => {
      parcel.lifecycle.entries = entries(parcel.lifecycle.entries);
    }), IN_TRANSIT).events!.filter((event) => event.provider_code === 'DRIVER_PICKUP/SHOP').map((event) => event.stage);
    expect(stages(([order]) => [order!, collection(order!, '20260601150000')])).toEqual(['accepted']);
    expect(stages(([order, first]) => [order!, first!, collection(order!, '20260602160000')])).toEqual(['in_transit']);
    expect(stages((entries) => [...entries, collection(entries[0]!, '20260611090000')])).toEqual(['exception']);
  });

  it('keeps a wall clock local where the country’s clock differs from Vienna’s or is not known', () => {
    const reading = readDpdAt(changed('in-transit', (parcel) => {
      const entries = parcel.lifecycle.entries;
      entries[1]!.depotData = ['Sample Town', 'PT'];
      // A depot no scan places, outside DPD Austria's list.
      entries.push({ ...structuredClone(entries[3]!), depot: '0999', depotData: null, datetime: '20260605080000' });
    }), IN_TRANSIT);
    expect(reading.country).toBeNull();
    expect(reading.result).toMatchObject({ current_stage: 'in_transit', last_update: null, last_update_local: '2026-06-05T08:00:00' });
    expect(reading.result.events!.map((event) => [event.time ?? null, event.local_time ?? null, event.location ?? null])).toEqual([
      [null, '2026-06-05T08:00:00', null],
      ['2026-06-04T11:41:00+02:00', null, 'Sample Dorf, AT'],
      ['2026-06-04T11:30:00+02:00', null, 'Sample Dorf, AT'],
      ['2026-06-04T11:30:00+02:00', null, 'Sample Dorf, AT'],
      ['2026-06-04T06:22:00+02:00', null, 'Sample Dorf, AT'],
      ['2026-06-04T06:15:00+02:00', null, 'Sample Dorf, AT'],
      ['2026-06-02T22:40:00+02:00', null, 'Example Hub, DE'],
      [null, '2026-06-02T15:10:00', 'Sample Town, PT'],
      // The order data's depot is the Portuguese one now.
      [null, '2026-06-01T12:05:00', null],
    ]);
  });

  it('reads the country of the newest scan for recognition', () => {
    expect(readDpdAt(fixture('delivered'), DELIVERED).country).toBe('AT');
    expect(readDpdAt(fixture('in-transit'), IN_TRANSIT).country).toBe('AT');
    const left = readDpdAt(changed('delivered', (parcel) => {
      const entries = parcel.lifecycle.entries;
      entries.splice(5);
      entries.push({ ...structuredClone(entries[2]!), depot: '0180', depotData: ['Example Hub', 'DE'], datetime: '20260112070000' });
    }), DELIVERED);
    expect(left).toMatchObject({ country: 'DE', result: { current_stage: 'in_transit', last_update: '2026-01-12T07:00:00+01:00' } });
  });

  it('keeps people, places and messages the page adds to a scan out of the result', () => {
    const result = parseDpdAt(changed('delivered', (parcel) => {
      Object.assign(parcel.lifecycle.entries.at(-1)!.state, { infoType: 'pers', infoData: 'SAMPLE PERSON' });
      Object.assign(parcel.lifecycle.entries[5]!.state, { infoType: 'time', infoData: ['09:00', '12:00'] });
      Object.assign(parcel, { sender_name1: 'Sample Sender', consignee_name1: 'Sample Person', consignee_addr_street: 'Sample Street 1' });
      parcel.lifecycle.receiver = 'Sample Person';
    }), DELIVERED);
    expect(JSON.stringify(result)).not.toMatch(/sample (?:person|sender|street)|09:00/i);
  });

  it('falls back to the short text, and to the state’s clock, and accepts `pno` as the number', () => {
    const result = parseDpdAt(changed('delivered', (parcel) => {
      const delivery = parcel.lifecycle.entries.at(-1)!;
      delivery.state.text = null;
      delete delivery.datetime;
      delete parcel.parcelno;
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ time: '2026-01-12T10:47:00+01:00', description: 'Erfolgreich zugestellt' });
  });

  it('reads an unknown number as not found, a message for the page as inconclusive and a parcel without scans as no history', () => {
    expect(() => parseDpdAt(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDpdAt({ state: 'failure', popup: 'Synthetic notice' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const change of [
      (parcel: Parcel) => { parcel.lifecycle.entries = []; },
      (parcel: Parcel) => { delete (parcel.lifecycle as Row).entries; },
      (parcel: Parcel) => { (parcel as Row).lifecycle = null; },
    ]) {
      expect(() => parseDpdAt(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('counts a parcel only when it names the number asked', () => {
    expect(() => parseDpdAt(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'myDPD answered for another parcel' }));
    const both = fixture('delivered');
    both.data.unshift(fixture('in-transit').data[0]!);
    expect(parseDpdAt(both, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_parcel: Parcel, body: Reply) => { delete (body as Row).state; },
      (_parcel: Parcel, body: Reply) => { body.state = 'pending'; },
      (_parcel: Parcel, body: Reply) => { body.data = [] as never; },
      (_parcel: Parcel, body: Reply) => { body.data = 'parcel' as never; },
      (_parcel: Parcel, body: Reply) => { body.data.push('parcel' as never); },
      (parcel: Parcel) => { parcel.parcelno = Number(DELIVERED); },
      (parcel: Parcel) => { parcel.lifecycle = 'history' as never; },
      (parcel: Parcel) => { parcel.lifecycle.entries = 'scans' as never; },
      (parcel: Parcel) => { parcel.lifecycle.entries = Array.from({ length: 501 }, () => parcel.lifecycle.entries[0]!); },
      (parcel: Parcel) => { parcel.lifecycle.entries[0] = 'scan' as never; },
      (parcel: Parcel) => { delete (parcel.lifecycle.entries[0] as Row).state; },
      (parcel: Parcel) => { parcel.lifecycle.entries[0]!.datetime = '2026-01-09 18:30'; },
      (parcel: Parcel) => { parcel.lifecycle.entries[0]!.datetime = '20260230183000'; },
      (parcel: Parcel) => { parcel.lifecycle.entries[0]!.datetime = '20260109243000'; },
      (parcel: Parcel) => { delete parcel.lifecycle.entries[0]!.datetime; delete parcel.lifecycle.entries[0]!.state.datetime; },
      (parcel: Parcel) => { parcel.lifecycle.entries[0]!.depot = 'AT01'; },
      (parcel: Parcel) => { parcel.lifecycle.entries[1]!.depotData = 'Sample Town'; },
      (parcel: Parcel) => { parcel.lifecycle.entries[0]!.state.text = ['Paket']; },
      (parcel: Parcel) => { Object.assign(parcel.lifecycle.entries[0]!.state, { text: '', textShort: null }); },
      (parcel: Parcel) => { parcel.lifecycle.entries[0]!.state.name = 7; },
    ]) {
      expect(() => parseDpdAt(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a browser check, a moved route and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // Radware's page comes with HTTP 200 in place of the reply.
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://validate.perfdrive.com/sample?ssa=0' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.mydpd.at/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>myDPD</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a parcel whose newest scan is in Austria, and no other', async () => {
    const answer = (body: unknown) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).recognize!(DELIVERED);
    await expect(answer(fixture('delivered'))).resolves.toEqual({ known: true, lastActivityAt: '2026-01-12T09:47:00.000Z' });
    await expect(answer(fixture('not-found'))).resolves.toEqual({ known: false });
    // Gone on to another network's depot: that network's to claim.
    await expect(answer(changed('delivered', (parcel) => {
      parcel.lifecycle.entries.push({ ...structuredClone(parcel.lifecycle.entries[2]!), depot: '0180', depotData: ['Example Hub', 'DE'], datetime: '20260113060000' });
    }))).resolves.toEqual({ known: false });
    await expect(answer(changed('delivered', (parcel) => {
      parcel.lifecycle.entries.push({ ...structuredClone(parcel.lifecycle.entries[5]!), depot: '0999', datetime: '20260113060000' });
    }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(answer(CHALLENGE)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('rejects numbers DPD does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A check character that does not match is a typo, not another parcel.
    for (const number of ['0621000000000', '0621000000000100', '06210000000001Z', 'SAMPLETRACKING', `0621${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(dpdAtNumber('0621-0000-0000-01')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under DPD Austria to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'dpd-at' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dpd-at', source: 'dpd-at', result: { current_stage: 'ready_for_pickup' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === DPD_AT_SEARCH)).toBe(true);
  });
});

describe('DPD Austria numbers', () => {
  it('asks DPD Austria first about its depots’ numbers, and only those', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['dpd-at'] });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('dpd-at');
    expect(recognitionAskedCarriers(IN_TRANSIT)).not.toContain('dpd-at');
  });
});

describe('DPD Austria status vocabulary', () => {
  it('records every state the map knows with the stage it gives', () => {
    // The numeric codes are DPD's group tracker's scan types, which this adapter does not read.
    const states = (statuses.entries as { code?: string; wording: string; stage?: string }[])
      .filter((entry) => entry.stage && /^[A-Z_]+(?:\/[A-Z_]+)?$/.test(entry.code ?? ''));
    expect(states).toHaveLength(15);
    for (const entry of states) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(dpdAtStage(entry.code!, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'dpd-at', providerCode: 'NAB', description: 'Empfänger leider nicht angetroffen.' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'dpd-at', providerCode: 'SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A hand-over says nothing without where to; it falls to the shared wording rules.
    expect(statusMap.stage('HANDOVER', 'paket übergeben')).toBeUndefined();
    // Of myDPD's errors only the misload and the failed delivery are known.
    expect(statusMap.stage('ERROR/SYNTHETIC', 'synthetic note')).toBeUndefined();
    expect(dpdAtStage('IN_DELIVERY/SYNTHETIC', 'In Zustellung')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(dpdAtStage('SYNTHETIC', 'Synthetic note')).toBeNull();
    // A driver's collection from a shop takes its stage from the scans before it.
    expect(statusMapAnswer({ carrier: 'dpd-at', providerCode: 'DRIVER_PICKUP/SHOP', description: 'Parcel was picked up by driver from Pickup parcel shop' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
