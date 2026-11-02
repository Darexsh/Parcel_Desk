import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DIREX_TRACK, DirexTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeDirexNumber, parseDirex } from './parser.js';
import { direxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '9900000017';
const IN_TRANSIT = '9900000025';
const RETURNED = '9900000033';
const UNKNOWN = '9999999999';

type Row = { [key: string]: unknown; pivot?: Record<string, unknown> };
type Shipment = { [key: string]: unknown; main_statuses: Row[]; api_label: Record<string, unknown>; partner_service: Record<string, unknown> };
/** Sets a field to a value its type does not allow, as a changed reply would. */
const set = (target: object, key: string, value: unknown) => { (target as Record<string, unknown>)[key] = value; };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const shipments = (name: string): Shipment[] => JSON.parse(fixture(name));
/** The fixture's reply after a change to its shipment. */
const changed = (name: string, change: (shipment: Shipment) => void): Shipment[] => {
  const reply = shipments(name);
  change(reply[0]!);
  return reply;
};
const row = (code: string | null, name: string, createdAt: string) => ({ id: 99, name, code, is_delivery: 0, key: 'main_status.synthetic',
  pivot: { shipment_id: 1, main_status_id: 99, created_at: createdAt } });
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
const urlFor = (number: string) => `${DIREX_TRACK}?itemNumbers[]=${number}`;
const timeline = (shipment: Shipment[], number: string) => parseDirex(shipment, number).events!
  .map((event) => [event.local_time, event.description, event.provider_code ?? null, event.stage ?? null]);

describe('Direx HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DirexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9900 0000-25 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(urlFor(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'direx', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first as wall clocks and hands it to USPS without the ZIP code', () => {
    const result = parseDirex(shipments('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-10T00:21:00', expected_delivery: null,
      service_name: 'DX TRACKED', destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: '9261299000000000000000' });
    expect(timeline(shipments('delivered'), DELIVERED)).toEqual([
      // Twenty-one past midnight.
      ['2026-03-10T00:21:00', 'Delivered', 'DLD', 'delivered'],
      // The reply lists the partner's rows out of order.
      ['2026-03-06T13:09:00', 'In Destination Country', 'ADC', 'in_transit'],
      ['2026-03-06T10:42:00', 'In Transit', 'ITT', 'in_transit'],
      // The repeated status is kept once.
      ['2026-03-03T16:05:44', 'Dispatched', 'DED', 'in_transit'],
      ['2026-03-02T15:40:12', 'Accepted by Direx', 'APO', 'accepted'],
      ['2026-03-02T08:14:05', 'Created', 'CRD', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time === undefined && event.location === undefined)).toBe(true);
    expect(deliveryHandoff('direx', DELIVERED, normalizeCarrierResult(result)))
      .toEqual({ carrier: 'usps', number: '9261299000000000000000', basis: 'partner' });
  });

  it('reads a parcel on its way with UPS', () => {
    const result = parseDirex(shipments('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Transit',
      last_update_local: '2026-05-13T21:40:00', service_name: 'DX XPRS', destination_country: 'DE',
      delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    expect(timeline(shipments('in-transit'), IN_TRANSIT).map(([, description]) => description))
      .toEqual(['In Transit', 'Dispatched', 'Accepted by Direx', 'Created']);
    expect(deliveryHandoff('direx', IN_TRANSIT, normalizeCarrierResult(result)))
      .toEqual({ carrier: 'ups', number: '1Z999AA10123456784', basis: 'partner' });
  });

  it('reads a parcel the partner sent back as returned', () => {
    const result = parseDirex(shipments('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Returned shipment added to expedition', last_update_local: '2026-07-13T13:56:26', destination_country: 'DE',
      delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10000000033' });
    expect(timeline(shipments('returned'), RETURNED)).toEqual([
      ['2026-07-13T13:56:26', 'Returned shipment added to expedition', 'RAD', 'returned'],
      ['2026-07-13T13:55:50', 'Returned shipment by partner', 'RWD', 'returned'],
      ['2026-07-06T17:26:31', 'Accepted by Direx', 'APO', 'accepted'],
      ['2026-07-06T14:02:22', 'Created', 'CRD', 'registered'],
    ]);
  });

  it('keeps no partner link, internal identifier or recipient detail', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT], ['returned', RETURNED]] as const) {
      const reply = changed(name, (shipment) => {
        shipment.receiver = { name: 'Sample Recipient', phone: '+359000000000', address: '1 Sample Street', city: 'Sampleton', post_code: '0000' };
        shipment.cod_method_text = 'Sample cash on delivery';
      });
      const text = JSON.stringify(parseDirex(reply, number));
      expect(text, name).not.toMatch(/apgecommerce|ups\.com|track_sequenceNo|tracknum|TRACKING_NUMBER|420000|1000017|main_status\.|Sample|\+359|APU|UPSB/);
    }
  });

  it('holds a delivery or a return against partner rows dated after it, and does not step back to a late registration', () => {
    const late = changed('delivered', (shipment) => shipment.main_statuses.push(row('ITT', 'In Transit', '2026-03-10 09:00:00')));
    expect(parseDirex(late, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'In Transit', last_update_local: '2026-03-10T09:00:00' });
    const back = changed('returned', (shipment) => shipment.main_statuses.push(row('DED', 'Dispatched', '2026-07-14 08:00:00')));
    expect(parseDirex(back, RETURNED)).toMatchObject({ current_stage: 'returned', last_status_text: 'Dispatched' });
    const registered = changed('in-transit', (shipment) => shipment.main_statuses.push(row('CRD', 'Created', '2026-05-14 08:00:00')));
    expect(parseDirex(registered, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Created' });
    // A failed attempt after the delivery is not covered up.
    const attempt = changed('delivered', (shipment) => shipment.main_statuses.push(row('DAT', 'Delivery Attempt', '2026-03-10 09:00:00')));
    expect(parseDirex(attempt, DELIVERED)).toMatchObject({ current_stage: 'failed_attempt' });
  });

  it('stages a status by its code, else its name in English or Bulgarian, else the shared rules, else leaves it unstaged', () => {
    const newest = (code: string | null, name: string) => {
      const result = parseDirex(changed('in-transit', (shipment) => shipment.main_statuses.push(row(code, name, '2026-05-14 08:00:00'))), IN_TRANSIT);
      return { current: result.current_stage, ...result.events![0] };
    };
    expect(newest(null, 'Processing at Partner')).toMatchObject({ current: 'in_transit', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(newest('dld', 'Synthetic note')).toMatchObject({ current: 'delivered', provider_code: 'DLD', stage_source: 'carrier_map' });
    expect(newest('XYZ', 'Опит за доставка')).toMatchObject({ current: 'failed_attempt', stage: 'failed_attempt', stage_source: 'carrier_map' });
    expect(newest(null, 'Планирано връщане от партньор')).toMatchObject({ current: 'returned', stage_source: 'carrier_map' });
    expect(newest('XYZ', 'Available for pickup')).toMatchObject({ current: 'ready_for_pickup', stage: 'ready_for_pickup',
      stage_source: expect.not.stringMatching(/^carrier_map$/) });
    const unstaged = newest('XYZ', 'Synthetic note');
    expect(unstaged).toMatchObject({ current: 'in_transit', description: 'Synthetic note', provider_code: 'XYZ' });
    expect(unstaged).not.toHaveProperty('stage');
    const blank = parseDirex(changed('in-transit', (shipment) => { shipment.main_statuses = [row('', 'Synthetic note', '2026-05-14 08:00:00')]; }), IN_TRANSIT);
    expect(blank).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
    expect(blank).not.toHaveProperty('current_stage');
    expect(blank.events![0]).not.toHaveProperty('provider_code');
  });

  it('names a partner only from a name the catalog knows and a link that agrees, and keeps its number', () => {
    const handed = (change: (shipment: Shipment) => void) => {
      const { delivery_carrier, delivery_tracking_number } = parseDirex(changed('in-transit', change), IN_TRANSIT);
      return { delivery_carrier, delivery_tracking_number };
    };
    const partner = (displayName: string, link: string | null) => (shipment: Shipment) => {
      shipment.partner_service = { ...shipment.partner_service, display_name: displayName, tracking_link: link };
    };
    expect(handed(partner('UPS', null))).toEqual({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    // A courier the catalog does not know by that name keeps only its number, whatever its link.
    expect(handed(partner('Sample Courier', 'https://www.ups.com/track?tracknum=[TRACKING_NUMBER]')))
      .toEqual({ delivery_carrier: undefined, delivery_tracking_number: '1Z999AA10123456784' });
    expect(handed(partner('', 'https://www.ups.com/track?tracknum=[TRACKING_NUMBER]')))
      .toEqual({ delivery_carrier: undefined, delivery_tracking_number: '1Z999AA10123456784' });
    // A known name with another carrier's link names nobody.
    expect(handed(partner('UPS', 'https://www.royalmail.com/track-your-item#/tracking-results/[TRACKING_NUMBER]')))
      .toEqual({ delivery_carrier: undefined, delivery_tracking_number: '1Z999AA10123456784' });
    // The consolidator's tracker is not another carrier's link.
    expect(handed(partner('UPS', 'https://apgecommerce.com/track-result/?track_sequenceNo=[TRACKING_NUMBER]')))
      .toEqual({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    expect(handed((shipment) => set(shipment, 'partner_service', null)))
      .toEqual({ delivery_carrier: undefined, delivery_tracking_number: '1Z999AA10123456784' });
    // The label's number is read whole, and Direx's own number or no number hands nothing on.
    expect(handed((shipment) => { shipment.api_label.item = ' 1z999aa1 0123456784 '; }))
      .toEqual({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    expect(handed((shipment) => { shipment.api_label.item = IN_TRANSIT; })).toEqual({ delivery_carrier: undefined, delivery_tracking_number: undefined });
    expect(handed((shipment) => { shipment.api_label.item = ''; })).toEqual({ delivery_carrier: undefined, delivery_tracking_number: undefined });
    expect(handed((shipment) => { shipment.api_label.item = 'SAMPLE/0001'; })).toEqual({ delivery_carrier: undefined, delivery_tracking_number: undefined });
    const unlabelled = parseDirex(changed('in-transit', (shipment) => set(shipment, 'api_label', null)), IN_TRANSIT);
    expect(unlabelled).not.toHaveProperty('delivery_carrier');
    expect(unlabelled).not.toHaveProperty('delivery_tracking_number');
    expect(deliveryHandoff('direx', IN_TRANSIT, normalizeCarrierResult(unlabelled))).toBeNull();
  });

  it('names the destination by its code, else by its name', () => {
    const destination = (country: unknown) => {
      const { destination_country, destination_country_name } = parseDirex(changed('in-transit', (shipment) => { shipment.country = country; }), IN_TRANSIT);
      return { destination_country, destination_country_name };
    };
    expect(destination({ code: 'de', name_en: 'Germany' })).toEqual({ destination_country: 'DE', destination_country_name: undefined });
    expect(destination({ name_en: 'Germany', name: 'Германия' })).toEqual({ destination_country: 'DE', destination_country_name: undefined });
    expect(destination({ name: 'Sampleland' })).toEqual({ destination_country: undefined, destination_country_name: 'Sampleland' });
    expect(destination(null)).toEqual({ destination_country: undefined, destination_country_name: undefined });
  });

  it('counts a shipment only when its own Direx number is the one asked', () => {
    expect(() => parseDirex(shipments('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Direx answered for another shipment' }));
    // The lookup also finds a shipment by its partner's number.
    const twice = [...shipments('delivered'), ...shipments('delivered')];
    expect(() => parseDirex(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Direx answered for several shipments' }));
    expect(parseDirex([...shipments('in-transit'), ...shipments('delivered')], DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(parseDirex(changed('delivered', (shipment) => { shipment.tracking_code = Number(DELIVERED); }), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    for (const statuses of [[], null]) {
      expect(() => parseDirex(changed('delivered', (shipment) => set(shipment, 'main_statuses', statuses)), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('rejects a changed reply', () => {
    const many = Array.from({ length: 51 }, () => shipments('delivered')[0]);
    const long = changed('delivered', (shipment) => { shipment.main_statuses = Array.from({ length: 201 }, (_, index) => row('ITT', 'In Transit', `2026-03-0${1 + (index % 9)} 10:00:00`)); });
    for (const payload of [
      {}, null, 'Synthetic', [1], [null], many, long,
      changed('delivered', (shipment) => { shipment.tracking_code = { value: DELIVERED }; }),
      changed('delivered', (shipment) => set(shipment, 'main_statuses', {})),
      changed('delivered', (shipment) => set(shipment.main_statuses, '0', 'Created')),
      changed('delivered', (shipment) => { delete shipment.main_statuses[0]!.name; }),
      changed('delivered', (shipment) => { shipment.main_statuses[0]!.name = 1; }),
      changed('delivered', (shipment) => { shipment.main_statuses[0]!.code = 1; }),
      changed('delivered', (shipment) => { delete shipment.main_statuses[0]!.pivot; }),
      changed('delivered', (shipment) => set(shipment.main_statuses[0]!, 'pivot', '2026-03-02 08:14:05')),
      changed('delivered', (shipment) => { shipment.main_statuses[0]!.pivot!.created_at = '2026-03-02T08:14:05Z'; }),
      changed('delivered', (shipment) => { shipment.main_statuses[0]!.pivot!.created_at = '2026-03-02 08:14'; }),
      changed('delivered', (shipment) => { shipment.main_statuses[0]!.pivot!.created_at = '2026-02-30 08:14:05'; }),
      changed('delivered', (shipment) => { shipment.main_statuses[0]!.pivot!.created_at = '2026-03-02 24:14:05'; }),
      changed('delivered', (shipment) => { shipment.main_statuses[0]!.pivot!.created_at = 1772439245; }),
      changed('delivered', (shipment) => { shipment.country = 'US'; }),
      changed('delivered', (shipment) => set(shipment, 'api_label', '420000009261299000000000000000')),
      changed('delivered', (shipment) => { shipment.api_label.item = 2 ** 60; }),
      changed('delivered', (shipment) => set(shipment, 'partner_service', 'USPS')),
      changed('delivered', (shipment) => { shipment.product = 'DX TRACKED'; }),
    ]) {
      expect(() => parseDirex(payload, DELIVERED), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only an empty list as not found, and keeps a moved lookup, a bot check and a broken reply apart', async () => {
    await expect(lookup('[]', {}, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://direx.bg/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="cf-turnstile" data-sitekey="synthetic"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['', '<html><title>Direx</title><body>Проследете вашата пратка</body></html>', '{"message":"Server Error"}', '{}', 'null']) {
      await expect(lookup(body), body).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('[]', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a reply over its size limit', async () => {
    await expect(lookup('[]', { headers: { 'Content-Length': String(3_000_000) } })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects numbers Direx does not issue and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['990000001', '99000000170', 'ZZ123456785BG', '1Z999AA10123456784', 'R9900000017', '', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDirexNumber('99-0000-0017')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('routes a number filed under Direx to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).startsWith(DIREX_TRACK) ? reply(fixture('delivered')) : new Response('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'direx' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'direx', source: 'direx', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === urlFor(DELIVERED))).toBe(true);
  });
});

describe('Direx numbers', () => {
  it('accepts every public Direx number, which no rule or recognition claims, and reads the tracking page link', () => {
    const own = numbers.records.filter((record) => record.context.assessment === 'confirmed');
    expect(own.length).toBeGreaterThan(0);
    for (const record of own) {
      expect(normalizeDirexNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number).carrier, record.number).not.toBe('direx');
      expect(recognitionCandidates(record.number), record.number).not.toContain('direx');
    }
    expect(parseTrackingInput(`https://direx.bg/track/?code=${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'direx' });
  });
});

describe('Direx status vocabulary', () => {
  it('records every code and name the map knows with the stage it gives', () => {
    expect(statuses.entries).toHaveLength(32);
    for (const entry of statuses.entries) {
      const code = 'code' in entry && entry.code ? entry.code : null;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(direxStage(code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'direx', providerCode: code ?? undefined, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'direx', providerCode: 'SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(direxStage('SYNTHETIC', 'Synthetic note')).toBeNull();
  });
});
