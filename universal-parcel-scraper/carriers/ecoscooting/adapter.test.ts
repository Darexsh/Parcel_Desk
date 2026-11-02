import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, EcoscootingTracker } from './adapter.js';
import { normalizeEcoscootingNumber, parseEcoscooting } from './parser.js';
import { ecoscootingStatus } from './status.js';
import metadata from './carrier.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';

const NUMBER = '000000000000000001';
const OTHER = '000000000000000002';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const PORTUGAL_NUMBER = 'CNPRT00000000000000000001';
const SPAIN_NUMBER = 'CNESP00000000000000000001';
const portugalFixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered-portugal.json', import.meta.url), 'utf8'));
const referenceFixture = (number: string) => { const value = portugalFixture(); value.packageParam.trackingNumber = number; return value; };
const pickupFixture = () => JSON.parse(readFileSync(new URL('./fixtures/collected-pickup-point.json', import.meta.url), 'utf8'));
const returnedFixture = () => JSON.parse(readFileSync(new URL('./fixtures/returned-pickup-point.json', import.meta.url), 'utf8'));
const PICKUP_POINT = 'Example Parcel Shop\nCalle Ejemplo 1, 00000 Ejemplo';

describe('Ecoscooting parcel history', () => {
  it.each([PORTUGAL_NUMBER, SPAIN_NUMBER])('binds %s history and its separate affirmative completion schema', number => {
    const result = normalizeCarrierResult(parseEcoscooting(referenceFixture(number), number));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Your shipment has been delivered successfully',
      last_update: '2026-01-10T12:00:00Z', delivered_at: '2026-01-10T12:00:00Z', weight_kg: 4.301 });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'registered']);
    // Sorting scans carry another local offset than last-mile scans; epochs keep them in order.
    expect(result.events?.slice(2, 4).map(event => event.time)).toEqual(['2026-01-08T12:00:00Z', '2026-01-07T12:00:00Z']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|imgUrl|opCode|Latitude|Longitude|outOrder|toZip|feature|cainiaoId|solution/);
    for (const entry of statuses.entries) expect(ecoscootingStatus(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    // The app's review reads the same records through the declared map.
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'ecoscooting', providerCode: entry.code, description: entry.wording }), entry.code).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    const wrong = referenceFixture(number.replace(/1$/, '2'));
    expect(() => parseEcoscooting(wrong, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const wrongScan = referenceFixture(number); wrongScan.statuses[1].mailNo = NUMBER;
    expect(() => parseEcoscooting(wrongScan, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('reads either code family as delivered with or without affirmative flags', () => {
    const value = referenceFixture(NUMBER);
    value.statuses.splice(1, 0, { ...value.statuses[1], actionCode: 'LM_DELIVERY_FAILURE', statusName: 'Delivery Attempt Failure',
      description: 'Your shipment delivery attempt failed [Recipient not at home]' });
    const result = normalizeCarrierResult(parseEcoscooting(value, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-10T12:00:00Z' });
    expect(result.events?.slice(0, 3).map(event => event.stage)).toEqual(['delivered', 'failed_attempt', 'out_for_delivery']);
    Object.assign(value.statuses[0], { status: 'finish', statusGroup: 'delivered' });
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'delivered' });
    const numeric = fixture(); delete numeric.statuses[0].status; delete numeric.statuses[0].statusGroup;
    expect(parseEcoscooting(numeric, NUMBER)).toMatchObject({ status: 'delivered', delivered_at: '2026-01-04T19:00:00Z' });
  });
  it('reads GTMS_SIGNED in the last-mile wording as delivered', () => {
    const numeric = fixture(); delete numeric.statuses[0].status; delete numeric.statuses[0].statusGroup;
    numeric.statuses[0].description = 'Your shipment has been delivered successfully';
    expect(parseEcoscooting(numeric, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-04T19:00:00Z' });
  });
  it.each([
    ['another description', { description: 'Your shipment has been collected by consignee at the parcelshop' }],
    ['another status name', { statusName: 'Different' }],
    ['one flag alone', { statusGroup: 'delivered' }],
    ['a failure flag', { status: 'error', statusGroup: 'delivered' }],
  ])('keeps GTMS_SIGNED without flags inconclusive with %s', (_label, change) => {
    const numeric = fixture(); delete numeric.statuses[0].status; delete numeric.statuses[0].statusGroup;
    Object.assign(numeric.statuses[0], change);
    expect(() => parseEcoscooting(numeric, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it.each(['status', 'statusGroup', 'description', 'statusName'])('rejects contradictory CN reference completion %s', field => {
    const value = portugalFixture(); value.statuses[0][field] = field === 'description' ? 'Not delivered' : 'Different';
    expect(() => parseEcoscooting(value, PORTUGAL_NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('reads a pickup-point collection as delivered and the earlier pickup-point scans as waiting there', () => {
    const result = normalizeCarrierResult(parseEcoscooting(pickupFixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Your shipment has been collected by consignee at the parcelshop',
      last_update: '2026-02-06T17:30:00Z', delivered_at: '2026-02-06T17:30:00Z', weight_kg: 1.25, pickup_point: PICKUP_POINT });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'ready_for_pickup', 'failed_attempt', 'out_for_delivery', 'in_transit', 'registered', 'registered']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|imgUrl|opCode|opRemark|Latitude|Longitude|outOrder|toZip|feature|cainiaoId|popStation|pinCode/);
    // "Delivered to PUDO" is the pickup point's signature, not the recipient's.
    const waiting = pickupFixture(); waiting.statuses.shift();
    expect(parseEcoscooting(waiting, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: PICKUP_POINT });
    expect(parseEcoscooting(waiting, NUMBER)).not.toHaveProperty('delivered_at');
    waiting.statuses.shift();
    expect(parseEcoscooting(waiting, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: PICKUP_POINT });
  });
  it('names the pickup point only once a scan places the parcel there', () => {
    const beforeArrival = pickupFixture(); beforeArrival.statuses = beforeArrival.statuses.slice(3);
    expect(parseEcoscooting(beforeArrival, NUMBER)).not.toHaveProperty('pickup_point');
    const nameOnly = pickupFixture(); nameOnly.popStationParam.detailAddress = ' ';
    expect(parseEcoscooting(nameOnly, NUMBER).pickup_point).toBe('Example Parcel Shop');
    const emptyPart = pickupFixture(); emptyPart.popStationParam.detailAddress = 'Calle Ejemplo 1, NaN, Ejemplo';
    expect(parseEcoscooting(emptyPart, NUMBER).pickup_point).toBe('Example Parcel Shop\nCalle Ejemplo 1, Ejemplo');
    const unnamed = pickupFixture(); unnamed.popStationParam = { pinCode: 'PRIVATE_SYNTHETIC_PICKUP_PIN' };
    expect(parseEcoscooting(unnamed, NUMBER)).not.toHaveProperty('pickup_point');
  });
  it('names no pickup point once the parcel goes back to the sender', () => {
    // From the deadline passing at the shop to the sender signing for it.
    for (const scans of [6, 0]) {
      const returned = returnedFixture(); returned.statuses = returned.statuses.slice(scans);
      returned.popStationParam = pickupFixture().popStationParam;
      expect(parseEcoscooting(returned, NUMBER)).toMatchObject({ current_stage: 'returned' });
      expect(parseEcoscooting(returned, NUMBER)).not.toHaveProperty('pickup_point');
    }
  });
  it('names no pickup point once the courier delivers the parcel instead', () => {
    const atDoor = pickupFixture();
    atDoor.statuses.splice(0, 2,
      { opTimestamp: '1770399000000', actionCode: 'GTMS_SIGNED', statusName: 'Delivery Success', description: 'Parcel has been delivered successfully' },
      { opTimestamp: '1770372000000', actionCode: 'GTMS_DO_DEPART', statusName: 'Out for Delivery', description: 'Your shipment is out for delivery' });
    expect(parseEcoscooting(atDoor, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parseEcoscooting(atDoor, NUMBER)).not.toHaveProperty('pickup_point');
    // The delivery code alone says so, with or without the round before it.
    atDoor.statuses.splice(1, 1);
    expect(parseEcoscooting(atDoor, NUMBER)).not.toHaveProperty('pickup_point');
  });

  it.each([['statusName', 'Different'],['description', 'Not collected'], ['status', 'finish'], ['statusGroup', 'delivered']])('keeps a pickup-point collection inconclusive when %s changes or a flag appears', (field, value) => {
    const collected = pickupFixture(); collected.statuses[0][field] = value;
    expect(() => parseEcoscooting(collected, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('reads the last-mile family\'s pickup-point codes like the GTMS ones', () => {
    const value = pickupFixture();
    const codes: Record<string, string> = { GTMS_PUDO_SIGNED: 'PUDO_SIGN_SUCCESS', GTMS_STA_SIGNED: 'PUDO_DELIVERY', GTMS_PUDO_INBOUND: 'PUDO_INBOUND' };
    for (const row of value.statuses) row.actionCode = codes[row.actionCode] ?? row.actionCode;
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-02-06T17:30:00Z' });
    value.statuses.shift();
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: PICKUP_POINT });
    const flagged = pickupFixture(); flagged.statuses[0].actionCode = 'PUDO_SIGN_SUCCESS'; flagged.statuses[0].status = 'error';
    expect(() => parseEcoscooting(flagged, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('reads an uncollected pickup-point parcel and its whole journey back as returned', () => {
    const result = normalizeCarrierResult(parseEcoscooting(returnedFixture(), NUMBER));
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Your shipment has been returned successfully to sender', weight_kg: 0.8 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events?.map(event => event.stage)).toEqual([...Array(7).fill('returned'), 'ready_for_pickup', 'ready_for_pickup', 'out_for_delivery',
      'in_transit', 'in_transit', 'in_transit', 'registered']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|imgUrl|opCode|opRemark|Latitude|Longitude|outOrder|toZip|feature|cainiaoId/);
    const expired = returnedFixture(); expired.statuses = expired.statuses.slice(6);
    expect(parseEcoscooting(expired, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned',
      last_status_text: 'Your shipment has expired at the parcelshop, and will be returned to sender' });
    const numeric = fixture(); numeric.statuses.unshift({ ...numeric.statuses[1], actionCode: 'RT_SIGNIN_SUCCESS', statusName: 'Return Success',
      description: 'Parcel has been returned back to the sender', opTimestamp: '1767900000000' });
    expect(parseEcoscooting(numeric, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });
  it('reads the exception wording under the GTMS failure code as a problem', () => {
    const value = fixture();
    value.statuses.unshift({ ...value.statuses[1], actionCode: 'GTMS_DEL_FAILURE', statusName: 'Delivery Failure',
      description: 'Your shipment has encountered an exception at last mile station [Parcel lost]', opTimestamp: '1767900000000' });
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception' });
    // The carrier labels a stolen parcel a failed attempt.
    value.statuses[0].description = 'Package stolen';
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    value.statuses[0].description = 'Delivery attempt failure, Not at home';
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(parseEcoscooting(value, NUMBER).events?.[0]?.stage).toBe('failed_attempt');
  });
  it('puts the return ahead of the station exception listed first at the same second', () => {
    const value = fixture(); value.statuses.shift();
    const at = (opTimestamp: string, actionCode: string, statusName: string, description: string) =>
      ({ ...value.statuses[0], actionCode, statusName, description, opTimestamp });
    const exception = at('1768100000000', 'LM_PARCEL_EXCEPTION', 'Your shipment has encountered an exception at last mile station',
      'Your shipment has encountered an exception at last mile station');
    const back = at('1768100000000', 'LM_UNREACHABLE_RETURN', 'Return to Origin', 'Your shipment will be returned to its origin');
    value.statuses.unshift(exception, back);
    const result = parseEcoscooting(value, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Your shipment will be returned to its origin' });
    expect(result.events?.slice(0, 2).map(event => event.provider_code)).toEqual(['LM_UNREACHABLE_RETURN', 'LM_PARCEL_EXCEPTION']);
    // An exception after the return, a second later, stays the newest scan.
    value.statuses[0] = { ...exception, opTimestamp: '1768100001000' };
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ current_stage: 'exception' });
  });
  it('reads the first-mile order scans as registered rather than in transit', () => {
    const value = pickupFixture(); value.statuses = value.statuses.slice(-2);
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Shipment order created' });
  });
  it('keeps CN reference movement active and retains missing epochs without inferring display instants', () => {
    const value = portugalFixture(); delete value.statuses[0].opTimestamp;
    const result = parseEcoscooting(value, PORTUGAL_NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null });
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-01-10 12:00:00 UTC+0' });
    expect(result).not.toHaveProperty('delivered_at');
    value.statuses.shift();
    expect(parseEcoscooting(value, PORTUGAL_NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    value.statuses[0].actionCode = 'UNKNOWN';
    expect(parseEcoscooting(value, PORTUGAL_NUMBER)).toMatchObject({ status: 'unknown' });
  });
  it('binds the parcel and uses milliseconds while projecting only labelled grams and public scans', () => {
    const result = normalizeCarrierResult(parseEcoscooting(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-04T19:00:00Z', delivered_at: '2026-01-04T19:00:00Z', expected_delivery: null, weight_kg: 4.301 });
    expect(result.events).toHaveLength(4); expect(result.events?.[2]).toMatchObject({ stage: 'failed_attempt' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Latitude|Longitude|outOrder|toZip|feature/);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    const evidence: Record<string, boolean> = { history: !!result.events?.length, weight: result.weight_kg === 4.301, delivered_at: !!result.delivered_at,
      pickup_point: parseEcoscooting(pickupFixture(), NUMBER).pickup_point === PICKUP_POINT };
    for (const capability of metadata.capabilities) expect(evidence[capability], capability).toBe(true);
  });
  it('rejects wrong parcel and per-scan identities, malformed or excessive history', () => {
    const wrong = fixture(); wrong.packageParam.trackingNumber = OTHER;
    const scan = fixture(); scan.statuses[1].mailNo = OTHER;
    const excessive = fixture(); excessive.statuses = Array(501).fill(excessive.statuses[0]);
    const malformed = fixture(); malformed.statuses[1] = null;
    for (const value of [null, wrong, scan, excessive, malformed]) expect(() => parseEcoscooting(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps query errors and failures inconclusive instead of claiming absence', () => {
    for (const value of [{ success: 'false', errorCode: 'P-011-0201-00-00-502', errorMsg: 'query logisticOrder by mailNo error' }, { success: true }, {}]) {
      expect(() => parseEcoscooting(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // Only the order query names the reason: a label not yet announced gets it too.
    expect(() => parseEcoscooting({ success: 'false', errorCode: 'P-011-0201-00-00-502', errorMsg: 'query logisticOrder by mailNo error' }, NUMBER))
      .toThrow(expect.objectContaining({ reason: 'portal_not_found' }));
    expect(() => parseEcoscooting({ success: 'false', errorCode: 'S99', errorMsg: 'gateway error' }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
  });
  it('recognizes a label it tracks and asks nothing for a number it does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(fixture())))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: 'false', errorCode: 'P-011-0201-00-00-502', errorMsg: 'query logisticOrder by mailNo error' })));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    // The query error also comes for a label not yet announced, so it settles nothing.
    await expect(instance.recognize!(OTHER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(instance.recognize!('ZZ')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('reads a parcel listed without scans as having no history yet', async () => {
    const announced = fixture(); announced.statuses = []; announced.packageParam.dimWeight = {};
    expect(() => parseEcoscooting(announced, NUMBER)).toThrow(NoHistoryError);
    const other = fixture(); other.statuses = []; other.packageParam.trackingNumber = OTHER;
    expect(() => parseEcoscooting(other, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The listing names the parcel, so recognition knows it before its first scan.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(announced)))
      .mockResolvedValueOnce(new Response(JSON.stringify(other)));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
  it.each(['1767553200', 1767553200000, '0', '-1767553200000', '1767553200000.5', 'not a clock'])('rejects wrong epoch units or shape %s', opTimestamp => {
    const value = fixture(); value.statuses[0].opTimestamp = opTimestamp;
    expect(() => parseEcoscooting(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('retains missing latest epoch as provider text without borrowing the display offset or older delivery', () => {
    const value = fixture(); delete value.statuses[0].opTimestamp;
    const result = parseEcoscooting(value, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null });
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-01-04 20:00:00 UTC+1' });
    expect(result.events?.[0]).not.toHaveProperty('time'); expect(result).not.toHaveProperty('delivered_at');
    delete value.statuses[0].datetime; expect(parseEcoscooting(value, NUMBER).events?.[0]).not.toHaveProperty('time');
  });
  it('requires affirmative completion and takes status from the actual newest scan', () => {
    const incomplete = fixture(); incomplete.statuses[0].status = 'error';
    expect(() => parseEcoscooting(incomplete, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const contradiction = fixture(); contradiction.statuses[0].description = 'Not delivered';
    expect(() => parseEcoscooting(contradiction, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const value = fixture(); value.statuses.shift(); value.feature = 'Delivered';
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    value.statuses.shift(); expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(parseEcoscooting(value, NUMBER)).not.toHaveProperty('delivered_at');
  });
  it.each([{ weight: '4301', weightUnit: 'kg' }, { weight: '-1', weightUnit: 'g' }, { weight: 4301, weightUnit: 'g' }, { weight: '0', weightUnit: 'g' }, { weight: 'garbage', weightUnit: 'g' }])('omits ambiguous weight %s', dimWeight => {
    const value = fixture(); value.packageParam.dimWeight = dimWeight; expect(parseEcoscooting(value, NUMBER)).not.toHaveProperty('weight_kg');
  });
  it('preserves unknown/equal-time scans and provider order, deduplicating and bounding projection', () => {
    const value = fixture(); value.statuses.unshift({ ...value.statuses[0], actionCode: '__proto__', description: 'Awaiting review' });
    expect(parseEcoscooting(value, NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Awaiting review' });
    expect(ecoscootingStatus('__proto__')).toBeUndefined();
    value.statuses.push(value.statuses[0]); expect(parseEcoscooting(value, NUMBER).events).toHaveLength(5);
    for (let i = 0; i < 110; i++) value.statuses.push({ ...value.statuses[0], description: `Public event ${i}` });
    expect(parseEcoscooting(value, NUMBER).events).toHaveLength(100);
  });
});

describe('Ecoscooting direct retrieval', () => {
  it('preserves full CN references in each fresh factory request and aligns detection boundaries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
      new Response(JSON.stringify(referenceFixture(JSON.parse(new URLSearchParams(String(init?.body)).get('logistics_interface')!).mailNo))));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    for (const [input, number] of [[PORTUGAL_NUMBER, PORTUGAL_NUMBER], ['cnprt-00000000000000000001', PORTUGAL_NUMBER],
      [SPAIN_NUMBER, SPAIN_NUMBER], ['cnesp 00000000000000000001', SPAIN_NUMBER]] as const) {
      await expect(instance.track({ number: input })).resolves.toMatchObject({ status: 'delivered' });
      const form = new URLSearchParams(String(fetcher.mock.lastCall?.[1]?.body));
      expect(JSON.parse(form.get('logistics_interface')!).mailNo).toBe(number);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    const patterns = metadata.detection.map(rule => new RegExp(rule.pattern));
    for (const number of [NUMBER, PORTUGAL_NUMBER, SPAIN_NUMBER]) {
      expect(patterns.some(pattern => pattern.test(number)), number).toBe(true);
      expect(normalizeEcoscootingNumber(number)).toBe(number);
    }
    // Cainiao issues other CN families elsewhere (CNUSUP in the US, CNFR…HD in
    // France); only the Spanish and Portuguese references belong to Ecoscooting.
    for (const number of ['CNPRT0000000000000000001', 'CNPRT000000000000000000001', 'CNESP0000000000000000001', 'CNFRA00000000000000000001',
      'CNUSUP00000000001', 'CNPRT00000000000000000001&x=1']) {
      expect(patterns.some(pattern => pattern.test(number)), number).toBe(false);
      await expect(instance.track({ number })).rejects.toThrow(InvalidInputError);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('puts back the CN of a reference typed without it, and names the full reference', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
      new Response(JSON.stringify(referenceFixture(JSON.parse(new URLSearchParams(String(init?.body)).get('logistics_interface')!).mailNo))));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const patterns = metadata.detection.map(rule => new RegExp(rule.pattern));
    for (const [input, number] of [['PRT00000001234000000001', 'CNPRT00000001234000000001'], ['prt 0000000 1234 000000001', 'CNPRT00000001234000000001'],
      ['ESP00000123400000000001', 'CNESP00000123400000000001']] as const) {
      expect(normalizeEcoscootingNumber(input)).toBe(number);
      expect(patterns.some(pattern => pattern.test(input.replace(/[^A-Z0-9]/gi, '').toUpperCase())), input).toBe(true);
      await expect(instance.track({ number: input })).resolves.toMatchObject({ status: 'delivered', canonical_tracking_number: number });
      expect(JSON.parse(new URLSearchParams(String(fetcher.mock.lastCall?.[1]?.body)).get('logistics_interface')!).mailNo).toBe(number);
    }
    // The full reference needs no canonical number.
    await expect(instance.track({ number: 'CNPRT00000001234000000001' })).resolves.not.toHaveProperty('canonical_tracking_number');
    expect(fetcher).toHaveBeenCalledTimes(4);
    // Only the Spanish and Portuguese layouts, with the postcode's length and 1234, lose their CN.
    for (const number of ['PRT00000000000000000001', 'ESP00000000000000000001', 'FRA00000001234000000001', 'PRT0000000123400000001', 'ESP0000012340000000001']) {
      expect(patterns.some(pattern => pattern.test(number)), number).toBe(false);
      expect(() => normalizeEcoscootingNumber(number)).toThrow(InvalidInputError);
    }
  });
  it('tracks a SHEIN package number by the label Ecoscooting lists for it, without naming the label', async () => {
    const shein = 'C26010100000001';
    const listed = () => { const value = fixture(); value.packageParam.outOrderId = shein; return value; };
    expect(normalizeCarrierResult(parseEcoscooting(listed(), shein))).toMatchObject({ status: 'delivered', delivered_at: '2026-01-04T19:00:00Z' });
    const ownScan = listed(); ownScan.statuses[1].mailNo = NUMBER;
    expect(parseEcoscooting(ownScan, shein)).toMatchObject({ status: 'delivered' });
    // In Portugal the label is a CN reference, and an announced parcel is listed without scans.
    const portugal = () => { const value = portugalFixture(); value.packageParam.outOrderId = shein; return value; };
    const fromPortugal = parseEcoscooting(portugal(), shein);
    expect(fromPortugal).toMatchObject({ status: 'delivered' });
    expect(JSON.stringify(fromPortugal)).not.toContain(PORTUGAL_NUMBER);
    const announced = portugal(); announced.statuses = [];
    expect(() => parseEcoscooting(announced, shein)).toThrow(NoHistoryError);
    // The listing must name the SHEIN number beside one of Ecoscooting's labels, and scans that label.
    const otherOrder = listed(); otherOrder.packageParam.outOrderId = 'C26010100000002';
    const shortLabel = listed(); shortLabel.packageParam.trackingNumber = NUMBER.slice(1);
    const foreignLabel = portugal(); foreignLabel.packageParam.trackingNumber = 'CNFRA00000000000000000001';
    const otherScan = listed(); otherScan.statuses[1].mailNo = OTHER;
    for (const value of [otherOrder, shortLabel, foreignLabel, otherScan]) expect(() => parseEcoscooting(value, shein)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(listed())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const result = await instance.track({ number: shein });
    // The label starts with the delivery postcode, so the result never carries it.
    expect(result).toMatchObject({ status: 'delivered' });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(JSON.stringify(result)).not.toContain(NUMBER);
    expect(JSON.parse(new URLSearchParams(String(fetcher.mock.lastCall?.[1]?.body)).get('logistics_interface')!).mailNo).toBe(shein);
    await expect(instance.recognize!(shein)).resolves.toMatchObject({ known: true });
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify(announced)));
    await expect(instance.recognize!(shein)).resolves.toEqual({ known: true, lastActivityAt: null });
    expect(fetcher).toHaveBeenCalledTimes(3);
    // A date SHEIN cannot have issued is refused before any request.
    for (const number of ['C26130100000001', 'D26010100000001']) await expect(instance.track({ number })).rejects.toThrow(InvalidInputError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('sends one fresh anonymous form using exact public client configuration and identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(fixture())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await instance.track({ number: NUMBER }); await instance.track({ number: NUMBER }); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe('https://de-link.cainiao.com/gateway/link.do'); expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
      const form = new URLSearchParams(String(init?.body));
      expect(JSON.parse(form.get('logistics_interface')!)).toEqual({ mailNo: NUMBER, locale: 'en_US', role: 'endUser' });
      expect(Object.fromEntries([...form].filter(([key]) => key !== 'logistics_interface'))).toEqual({ msg_type: 'CN_OVERSEA_LOGISTICS_INQUIRY_TRACKING', logistic_provider_id: 'DISTRIBUTOR_30250031', data_digest: 'suibianxie', to_code: 'CNL_EU' });
      const headers = new Headers(init?.headers); expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(headers.has('Cookie') || headers.has('Authorization')).toBe(false); expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('sends a query that fails to reach the gateway once more, and one that hangs inside the budget', async () => {
    const dropped = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture())));
    await expect(new EcoscootingTracker({ fetcher: dropped }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(dropped).toHaveBeenCalledTimes(2);
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(new EcoscootingTracker({ fetcher }).fetch(NUMBER, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });
  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s distinct from parcel absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new EcoscootingTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds invalid inputs, cancellation, fractional deadlines, body size and malformed JSON', async () => {
    const unused = vi.fn<typeof fetch>(); await expect(new EcoscootingTracker({ fetcher: unused }).fetch('ICP000000000000000001')).rejects.toThrow(InvalidInputError);
    await expect(new EcoscootingTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow(); expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true })); init?.signal?.throwIfAborted(); return new Response('{}'); });
    await expect(new EcoscootingTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001))); await expect(new EcoscootingTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Failure</html>')); await expect(new EcoscootingTracker({ fetcher: malformed }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
});
