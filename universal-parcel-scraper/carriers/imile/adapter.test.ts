import { constants, createHash, generateKeyPairSync, privateDecrypt, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, IMILE_API, IMILE_PAGE, IMILE_SIGNING, ImileTracker, imileSignature, scriptSigning, type ImileSigning } from './adapter.js';
import { cainiaoScans, withCainiaoLeg } from './cainiao.js';
import { imileSummary, imileWording, normalizeImileNumber, parseImile } from './parser.js';
import { imileStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '6000000000001';
const IN_TRANSIT = '6000000000002';
const UNKNOWN = '6000000000000';
// A waybill made on 1 January 2024, as the dated layout writes it.
const DATED = '6010124000001';

type Row = Record<string, unknown>;
type Shipment = Row & { trackInfos: Row[] };
type Reply = Row & { resultObject: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** Cainiao's global feed, which holds the China leg of the parcels Cainiao hands to iMile. */
const CAINIAO_DETAIL = 'https://global.cainiao.com/global/detail.json';
type CainiaoReply = { module: (Row & { detailList: Row[] })[] };
const cainiaoFixture = () => JSON.parse(readFileSync(new URL('./fixtures/cainiao-delivered.json', import.meta.url), 'utf8')) as CainiaoReply;
/** Cainiao's answer for a number it has no record of. */
const cainiaoUnknown = (number: string) => ({ module: [{ mailNo: number, mailNoSource: 'EXTERNAL', detailList: [] }], success: true });
const toCainiao = ([url]: Parameters<typeof fetch>) => String(url).startsWith(`${CAINIAO_DETAIL}?`);
/** The requests a lookup made to iMile itself. */
const imileCalls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.filter((call) => !toCainiao(call));
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.resultObject, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// Two synthetic key pairs: the page's values, and the ones it changes to.
const pair = (salt: string) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, signing: { key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), salt } };
};
const FIRST = pair('syntheticSalt');
const SECOND = pair('otherSalt');
const decrypt = (privateKey: KeyObject, sign: string) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(sign, 'base64')).toString();

const SCRIPT_PATH = '/_next/static/chunks/pages/%5BcountryAndLang%5D/track-0123456789abcdef.js';
const page = (body = `<script src="${SCRIPT_PATH}" defer=""></script>`) => `<!DOCTYPE html><html><head>${body}</head><body></body></html>`;
// The track page's signing, as its script writes it.
const script = (signing: ImileSigning) => `V=async e=>{let t=new v.v;t.setPublicKey("${signing.key}");let i=t.encrypt(e),`
  + `n="/saastms/mobileWeb/track/query?waybillNo=".concat(e,"&code=").concat(g().MD5("".concat(e,"${signing.salt}")).toString());`
  + 'return window.fetch(n,{headers:{lang:a,sign:i}})}';

/**
 * iMile's site: the lookup answers a shipment only when its sign decrypts to
 * the number under the key in use, and the same empty reply otherwise.
 */
function site(key: { privateKey: KeyObject; signing: ImileSigning }, shipments: Record<string, unknown>,
  pages: { page?: () => Response; script?: () => Response; cainiao?: (number: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` === CAINIAO_DETAIL) {
      const number = url.searchParams.get('mailNos')!;
      return pages.cainiao?.(number, init) ?? reply(cainiaoUnknown(number));
    }
    if (`${url.origin}${url.pathname}` === IMILE_API) {
      const number = url.searchParams.get('waybillNo')!;
      const sign = new Headers(init?.headers).get('sign') ?? '';
      let known = false;
      // A ciphertext from another key can also fail RSA decoding. The service
      // rejects either case with its empty reply, rather than a network error.
      try { known = shipments[number] !== undefined && decrypt(key.privateKey, sign) === number; } catch { /* Rejected signature. */ }
      return reply(known ? shipments[number] : fixture('not-found'));
    }
    if (String(input) === IMILE_PAGE) return pages.page?.() ?? new Response(page(), { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname === SCRIPT_PATH) return pages.script?.() ?? new Response(script(key.signing), { headers: { 'Content-Type': 'application/javascript' } });
    throw new Error(`unexpected request to ${String(input)}`);
  });
}

describe('iMile HTTP adapter', () => {
  it('asks the tracking page’s lookup once in English, signed as the page signs it, through the supplied transport', async () => {
    const fetcher = site(FIRST, { [IN_TRANSIT]: fixture('in-transit') });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ImileTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', signing: FIRST.signing }).fetch(' 6000-0000-00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    // iMile once, then Cainiao for the leg before iMile's.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${CAINIAO_DETAIL}?mailNos=${IN_TRANSIT}&lang=en-US`);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    const [url, init] = fetcher.mock.calls[0]!;
    const code = createHash('md5').update(`${IN_TRANSIT}syntheticSalt`).digest('hex');
    expect(String(url)).toBe(`${IMILE_API}?waybillNo=${IN_TRANSIT}&code=${code}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', lang: 'en_US', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(decrypt(FIRST.privateKey, (init!.headers as Record<string, string>).sign!)).toBe(IN_TRANSIT);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'imile', step: 'direct', outcome: 'ok' }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'imile', step: 'cainiao', attempt: 2, outcome: 'not_found' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('signs with the values the tracking script holds', () => {
    expect(scriptSigning(script(FIRST.signing))).toEqual(FIRST.signing);
    const { code, sign } = imileSignature('CNBR00000000001', SECOND.signing);
    expect(code).toBe(createHash('md5').update('CNBR00000000001otherSalt').digest('hex'));
    expect(decrypt(SECOND.privateKey, sign)).toBe('CNBR00000000001');
    // The values shipped with the adapter read as a key.
    expect(imileSignature(DELIVERED, IMILE_SIGNING).sign).toMatch(/^[A-Za-z0-9+/]{342}==$/);
    expect(() => scriptSigning('t.setPublicKey("short");')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => scriptSigning(script({ key: 'A'.repeat(300), salt: 'syntheticSalt' }))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => scriptSigning(script(FIRST.signing).replace('/saastms/mobileWeb/track/query', '/other')))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('places each scan on the recipient country’s clock and stages it by its code and sentence', () => {
    const result = parseImile(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'SMP: Clearance start.', last_update: '2026-06-04T02:15:00-05:00', expected_delivery: null,
      destination_country: 'CO' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-06-04T02:15:00-05:00', null, 'customs', null],
      ['2026-06-03T23:15:00-05:00', '1002', 'customs', null],
      // The flight booked before it, still to come, is left out.
      ['2026-06-02T18:00:00-05:00', '1002', 'in_transit', null],
      ['2026-05-31T12:02:11-05:00', '2005', 'accepted', 'Sample Origin Center'],
      ['2026-05-31T08:40:00-05:00', null, 'registered', null],
      ['2026-05-30T19:16:16-05:00', '1001', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Flight Schedule/);
    // A scan the booked flight follows keeps its own words.
    const received = parseImile(changed('in-transit', (shipment) => {
      shipment.trackInfos[3]!.content = 'Origin port warehouse receive，Flight Schedule ETD【HKG】<2026-06-03 02:00:00>, ETA【SMP】<2026-06-03 12:00:00>.';
      shipment.trackInfos[3]!.trackStage = null;
    }), IN_TRANSIT);
    expect(received.events![3]).toMatchObject({ description: 'Origin port warehouse receive', stage: 'in_transit' });
    // The last-mile number names no courier, so there is no hand-off.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLELM|delivery_tracking_number|Sample Origin Center"?,"dispatch/);
  });

  it('keeps the delivery without the driver’s phone, who took it, its proof or the repeated scan', () => {
    const result = parseImile(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your order has been delivered successfully.', last_update: '2026-05-20T15:42:10+03:00',
      destination_country: 'SA' });
    expect(result.events).toHaveLength(15);
    expect(result.events!.slice(0, 8).map((event) => [event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['2060', 'delivered', 'Your order has been delivered successfully.'],
      ['1003', 'out_for_delivery', 'Our delivery associate is out for delivery.'],
      // A delivery day booked moves nothing.
      ['1003', null, 'Shipment is scheduled to [2026-05-20].'],
      ['1003', 'failed_attempt', 'Delivery attempt finished,return to Local logistics company warehouse.'],
      ['1003', 'failed_attempt', 'User not at home'],
      ['1003', 'out_for_delivery', 'Our delivery associate is out for delivery.'],
      ['1003', 'in_transit', 'Your order has assigned delivery drvier.'],
      ['1003', 'in_transit', 'Your order has arrived at SMP DS01'],
    ]);
    // A name opening a scan is its centre, which the location shows, or else heads the sentence.
    expect(result.events!.slice(9, 14).map((event) => [event.stage ?? null, event.description, event.location ?? null])).toEqual([
      ['in_transit', 'Your order has been received.', 'Sample Distribution Center'],
      ['in_transit', 'SMP: AirPlane clearance finish,ready to ship to Sample Distribution Center.', null],
      ['customs', 'Clearance Processing', null],
      ['customs', 'SMP: Flight Arrived - Waiting for customs clearance.', null],
      ['in_transit', 'HKG: The flight has taken off.', null],
    ]);
    // The flight booked for the parcel is still to come: no scan.
    expect(JSON.stringify(result)).not.toMatch(/Flight Schedule/);
    expect(result.events!.find((event) => event.description === 'Clearance Processing')).toMatchObject({ stage: 'customs' });
    expect(result.events!.find((event) => event.description === 'Clearance Processing')).not.toHaveProperty('provider_code');
    expect(JSON.stringify(result)).not.toMatch(/Self|Receiver|viewPic|example\.invalid|contact him|\+000|0500000001/);
  });

  it('reads return handling as a return under way, until the sender has the parcel back', () => {
    const failed = parseImile(changed('delivered', (shipment) => {
      Object.assign(shipment.trackInfos[0]!, { trackStage: 1008, trackStageTx: 'Return Handling Process',
        content: 'Order delivery failed, returning to sender. If you have any question, please contact us through cs  ' });
    }), DELIVERED);
    expect(failed).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Order delivery failed, returning to sender.' });
    // A centre receiving the parcel and a driver's reason are the way back.
    for (const content of ['【Sample Hub】Shipment received.', '<No Answer>']) {
      const back = parseImile(changed('delivered', (shipment) => {
        Object.assign(shipment.trackInfos[0]!, { trackStage: 1008, trackStageTx: 'Return Handling Process', content });
      }), DELIVERED);
      expect(back).toMatchObject({ current_stage: 'exception', last_status_text: content === '<No Answer>' ? 'No Answer' : 'Sample Hub: Shipment received.' });
    }
    const signed = parseImile(changed('delivered', (shipment) => {
      Object.assign(shipment.trackInfos[0]!, { trackStage: 2065, trackStageTx: 'Returned to Client', content: '【Sample Hub】Return signature' });
    }), DELIVERED);
    expect(signed).toMatchObject({ current_stage: 'returned' });
  });

  it('reads a pickup point notice, its names in 【】 as the page writes them, as waiting there', () => {
    const waiting = parseImile(changed('delivered', (shipment) => {
      Object.assign(shipment.trackInfos[0]!, { trackStage: 1003,
        content: 'The parcel has been delivered to 【Sample Shop】. Please collect your parcel promptly at 【Sample Street 1】 using your pickup code.' });
    }), DELIVERED);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'The parcel has been delivered to Sample Shop. Please collect your parcel promptly at Sample Street 1 using your pickup code.' });
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parseImile(changed('in-transit', (shipment) => { shipment.trackInfos.reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-06-04T02:15:00-05:00', current_stage: 'customs' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '1001' });
  });

  it('places New Zealand’s scans on Auckland’s clock and Peru’s on Lima’s', () => {
    const placed = (country: string) => parseImile(changed('in-transit', (shipment) => { shipment.country = country; }), IN_TRANSIT);
    expect(placed('NZL')).toMatchObject({ last_update: '2026-06-04T02:15:00+12:00', destination_country: 'NZ' });
    expect(placed('PER')).toMatchObject({ last_update: '2026-06-04T02:15:00-05:00', destination_country: 'PE' });
    // A delivery at an Auckland station on New Zealand's summer time, not China's clock.
    const delivered = parseImile(changed('delivered', (shipment) => {
      shipment.country = 'NZL';
      shipment.trackInfos[0]!.time = '2026-11-01 15:08:15';
      shipment.trackInfos[0]!.operateStationName = 'AucklandDS';
    }), DELIVERED);
    expect(delivered).toMatchObject({ current_stage: 'delivered', last_update: '2026-11-01T15:08:15+13:00' });
    expect(delivered.events![0]).toMatchObject({ time: '2026-11-01T15:08:15+13:00', location: 'AucklandDS' });
  });

  it('keeps the wall clocks of a country with several zones or none named', () => {
    for (const country of ['MEX', 'BRA', 'USA', 'XXX', '']) {
      const result = parseImile(changed('in-transit', (shipment) => { shipment.country = country; }), IN_TRANSIT);
      expect(result).toMatchObject({ last_update: null, last_update_local: '2026-06-04T02:15:00' });
      expect(result.events!.every((event) => event.time === undefined && event.local_time !== undefined)).toBe(true);
    }
  });

  it('takes people, phones, proof links and support contacts out of the wording', () => {
    expect(imileWording('【DS SMP】Your package was received by 【Sample Person】. If you have any questions, please contact us so we can assist you.'
      + '📞 WhatsApp: +00 00 0000-0000📧 Email: support@example.invalid🌐 Official website: https://example.invalid/'))
      .toBe('【DS SMP】Your package was received.');
    expect(imileWording('Your order has been delivered successfully, Receiver Type:【Family】.')).toBe('Your order has been delivered successfully.');
    expect(imileWording('Our delivery associate is out for delivery.You can contact him by clicking +000 0500000000.'))
      .toBe('Our delivery associate is out for delivery.');
    expect(imileWording('Your order has been delivered successfully.<div class="viewPic" data-pic="https://example.invalid/a.jpg">View</div>'))
      .toBe('Your order has been delivered successfully.');
    expect(imileWording('Driver called 000 000 0000 , no answer')).toBe('Driver called, no answer');
    // Dates, flight clocks and centre names stay.
    expect(imileWording('Shipment is scheduled to [2026-05-20] .')).toBe('Shipment is scheduled to [2026-05-20].');
    expect(imileWording('Flight Schedule ETD【<HKG>】<2026-05-17 11:40:00>, ETA【<SMP>】<2026-05-17 16:15:00>.'))
      .toBe('Flight Schedule ETD【<HKG>】<2026-05-17 11:40:00>, ETA【<SMP>】<2026-05-17 16:15:00>.');
    expect(imileWording(' Customer Wants to Change Location')).toBe('Customer Wants to Change Location');
  });

  it('reads the empty reply as not found, a failed lookup as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseImile(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseImile({ ...fixture('not-found'), status: 'fail', message: 'System error' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseImile({ ...fixture('not-found'), status: 'fail', message: 'Requests are too frequent' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseImile(changed('delivered', (shipment) => { shipment.trackInfos = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseImile(changed('delivered', (shipment) => { delete (shipment as Row).trackInfos; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseImile(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'iMile answered for another shipment' }));
    const reference = parseImile(changed('in-transit', (shipment) => { shipment.waybillNo = 'CNBR00000000001'; }), 'cnbr00000000001');
    expect(reference.events).toHaveLength(6);
    expect(() => parseImile(changed('in-transit', (shipment) => { shipment.waybillNo = 'CNBR00000000001'; }), 'CNBR0000000000'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).status; },
      (_shipment: Shipment, body: Reply) => { body.resultObject = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.waybillNo; },
      (shipment: Shipment) => { shipment.trackInfos = 'scans' as never; },
      (shipment: Shipment) => { shipment.trackInfos = Array.from({ length: 501 }, () => shipment.trackInfos[0]!); },
      (shipment: Shipment) => { shipment.trackInfos[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = '20/05/2026 15:42'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = '2026-05-20T15:42:10Z'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = '2026-05-20 24:00:00'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = '2026-02-30 10:00:00'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = 1_780_000_000_000; },
      (shipment: Shipment) => { delete shipment.trackInfos[0]!.time; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.trackStage = 'Delivered'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.trackStage = -1; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.content = ['Delivered']; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.content = ''; shipment.trackInfos[0]!.trackStageTx = null; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.operateStationName = 7; },
    ]) {
      expect(() => parseImile(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A scan whose own sentence is empty takes its code's label.
    expect(parseImile(changed('delivered', (shipment) => { shipment.trackInfos[0]!.content = null; }), DELIVERED).events![0])
      .toMatchObject({ description: 'Delivered', stage: 'delivered' });
  });

  it('checks the page’s values once an hour before calling an empty reply not found', async () => {
    let clock = 0;
    const fetcher = site(FIRST, {});
    const tracker = new ImileTracker({ fetcher, signing: FIRST.signing, now: () => clock });
    await expect(tracker.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/saastms/mobileWeb/track/query', '/AE-en/track', SCRIPT_PATH]);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
    clock += 59 * 60_000;
    await expect(tracker.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    clock += 2 * 60_000;
    await expect(tracker.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it('signs again with the page’s new values when they changed, and keeps them', async () => {
    const fetcher = site(SECOND, { [DELIVERED]: fixture('delivered'), [IN_TRANSIT]: fixture('in-transit') });
    const tracker = new ImileTracker({ fetcher, signing: FIRST.signing });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(imileCalls(fetcher)).toHaveLength(4);
    const retried = new URL(String(fetcher.mock.calls[3]![0]));
    expect(retried.searchParams.get('code')).toBe(createHash('md5').update(`${DELIVERED}otherSalt`).digest('hex'));
    await expect(tracker.fetch(IN_TRANSIT)).resolves.toMatchObject({ current_stage: 'customs' });
    expect(imileCalls(fetcher)).toHaveLength(5);
  });

  it('keeps a changed or blocked page apart from an unknown number', async () => {
    const lookup = (pages: Parameters<typeof site>[2]) => new ImileTracker({ fetcher: site(FIRST, {}, pages), signing: FIRST.signing }).fetch(UNKNOWN);
    const html = (body: string, status = 200) => () => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    await expect(lookup({ page: html(page('<script src="/_next/static/chunks/main-0.js"></script>')) })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ page: html(page('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>')) }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ page: html('', 403) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ page: html('', 404) })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ script: html('console.log("moved")') })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The page answers its own lookup with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.imile.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>iMile</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ ...fixture('not-found'), status: 'fail', message: 'System busy' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers iMile does not answer and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['6000000', 'SAMPLETRACKING', `6${'0'.repeat(40)}`, '6000000000001!']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeImileNumber('cnbr 0000-0000-001')).toBe('CNBR00000000001');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')))
      .mockResolvedValueOnce(reply(cainiaoUnknown(IN_TRANSIT)));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(imileCalls(fetcher)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
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

  it('recognizes a waybill with scans and the empty reply, keeps a refusal an error and asks nothing for another number', async () => {
    const known = vi.fn<typeof fetch>().mockImplementation(async () => reply(changed('in-transit', (shipment) => { shipment.waybillNo = DATED; })));
    await expect(carrier(known).recognize!(DATED)).resolves.toMatchObject({ known: true });
    // The page still signs with the values the adapter holds, so the empty reply is an unknown number.
    await expect(carrier(site({ privateKey: FIRST.privateKey, signing: IMILE_SIGNING }, {})).recognize!(DATED)).resolves.toEqual({ known: false });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }))).recognize!(DATED))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    const unasked = vi.fn<typeof fetch>();
    await expect(carrier(unasked).recognize!('SAMPLETRACKING')).resolves.toEqual({ known: false });
    expect(unasked).not.toHaveBeenCalled();
    // Recognition asks iMile alone.
    expect(known.mock.calls.some(toCainiao)).toBe(false);
  });

  it('routes a number filed under iMile to the adapter, and suggests iMile for a dated waybill only', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'imile' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'imile', source: 'imile', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(`${IMILE_API}?`))).toBe(true);
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('imile');
    expect(detectCarrierMatch(DATED)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['imile']) });
    // Month 13 is no date.
    expect(detectCarrierMatch('6130124000001').candidates).not.toContain('imile');
  });

  it('lists iMile first for a dated waybill, beside the other thirteen-digit carriers, whatever the country hint', () => {
    expect(detectCarrierMatch(DATED)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['imile'],
      candidates: expect.arrayContaining(['la-poste', 'correos-chile', 'delhivery', 'yunda', 'korea-post', 'imile']) });
    expect(detectCarrierMatch(DATED).candidates?.[0]).toBe('imile');
    // A parcel bought abroad keeps its buyer's country hint, so iMile is asked first without its own countries too.
    for (const countryHint of [undefined, 'CO', 'DE', 'ES', 'HU', 'KR', 'IN']) {
      const asked = recognitionAskedCarriers(DATED, { countryHint });
      expect(asked[0], countryHint ?? 'no hint').toBe('imile');
      expect(asked, countryHint ?? 'no hint').toContain('la-poste');
    }
    // A waybill dated before 2024 or a bare counter is not preferred.
    for (const number of ['6010123000001', '3010124000001']) expect(detectCarrierMatch(number).preferred ?? [], number).not.toContain('imile');
  });

  it('lists iMile first for 49 and twelve digits, which its tracker answered for Italian parcels, beside the other fourteen-digit carriers', () => {
    for (const number of ['49000000000017', '49 0000 0000 0017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['imile'],
        candidates: expect.arrayContaining(['imile', 'brt', 'dpd']) });
      expect(detectCarrierMatch(number).candidates?.[0], number).toBe('imile');
    }
    // Every parcel the app tracked in the layout was iMile's, so it is asked before the hinted country's carriers.
    for (const [countryHint, next] of [[undefined, 'dpd-be'], ['IT', 'brt'], ['DE', 'dpd-de']] as const) {
      expect(recognitionAskedCarriers('49000000000017', { countryHint }).slice(0, 2), countryHint ?? 'no hint').toEqual(['imile', next]);
    }
    for (const number of ['48000000000017', '4900000000017', '490000000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('imile');
    }
  });
});

describe('Cainiao’s leg in front of iMile’s history', () => {
  type Step = { step: string; attempt: number; outcome: string; errorType: string | null; durationMs: number };
  const lookup = (cainiao: (number: string, init?: RequestInit) => Response | Promise<Response>, budgetMs?: number, shipment: Reply = fixture('delivered')) => {
    const recorder = { ...NOOP_RECORDER, step: vi.fn<(step: Step) => void>(), lookup: vi.fn() };
    const fetcher = site(FIRST, { [DELIVERED]: shipment }, { cainiao });
    const result = new ImileTracker({ fetcher, recorder, signing: FIRST.signing }).fetch(DELIVERED, budgetMs ? { budgetMs } : {});
    const step = () => recorder.step.mock.calls.map(([recorded]) => recorded).find((recorded) => recorded.step === 'cainiao');
    return { fetcher, result, step };
  };
  const codes = (result: { events?: readonly { provider_code?: unknown }[] }) => result.events!.map((event) => event.provider_code ?? null);
  const CAINIAO_CODE = /^[A-Z_]+$/;
  /** Cainiao's record with its scans from `from` on, newest first. */
  const cainiaoFrom = (from: string) => {
    const record = cainiaoFixture();
    const scans = record.module[0]!.detailList;
    record.module[0]!.detailList = scans.slice(scans.findIndex((scan) => scan.actionCode === from));
    return record;
  };

  it('puts Cainiao’s China leg in front of iMile’s scans and keeps iMile’s scans and status', async () => {
    const own = parseImile(fixture('delivered'), DELIVERED);
    const { result, step } = lookup(() => reply(cainiaoFixture()));
    const merged = await result;
    expect({ ...merged, events: own.events }).toEqual(own);
    expect(merged.events!.filter((event) => !CAINIAO_CODE.test(String(event.provider_code ?? '')))).toEqual(own.events);
    // Cainiao's scans count up to iMile's flight; its relays of iMile's own scans, and of iMile's order, stay out.
    expect(codes(merged).slice(13)).toEqual(['1002', 'LH_DEPART', 'LH_HO_AIRLINE', 'CC_EX_SUCCESS', 'CC_EX_START', 'LH_HO_IN_SUCCESS',
      '1001', 'SC_OUTBOUND_SUCCESS', 'SC_INBOUND_SUCCESS', 'PU_PICKUP_SUCCESS']);
    expect(merged.events).toHaveLength(own.events!.length + 8);
    const scan = (code: string) => merged.events!.find((event) => event.provider_code === code);
    expect(scan('SC_OUTBOUND_SUCCESS')).toEqual({ time: '2026-05-14T23:50:00+08:00', location: 'Sampletown',
      description: 'Departed from sorting center', provider_code: 'SC_OUTBOUND_SUCCESS', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(scan('PU_PICKUP_SUCCESS')).toMatchObject({ time: '2026-05-14T15:30:00+08:00', stage: 'accepted' });
    // Cainiao's handover to the airline has a day and no clock.
    expect(scan('LH_HO_AIRLINE')).toMatchObject({ local_time: '2026-05-17', stage: 'in_transit' });
    expect(scan('LH_HO_AIRLINE')).not.toHaveProperty('time');
    expect(step()).toMatchObject({ attempt: 2, outcome: 'ok', errorType: null });
  });

  it('keeps iMile’s answer when Cainiao does not name iMile as the parcel’s carrier', async () => {
    const stranger = cainiaoFixture();
    const module = stranger.module[0]!;
    module.destCpInfo = { cpName: 'Sample Express' };
    for (const trace of [module.globalCombinedLogisticsTraceDTO, module.latestTrace]) delete (trace as Row).currentStatusCpInfo;
    const { result, step } = lookup(() => reply(stranger));
    await expect(result).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
    expect(step()).toMatchObject({ outcome: 'indeterminate' });
    expect(() => cainiaoScans(stranger, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'carrier_unconfirmed' }));
  });

  it.each([
    ['its slider', () => new Response('<!DOCTYPE html><html><body><punish-component />\n<!--rgv587_flag:sm-->\n</body></html>',
      { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
    ['HTTP 429', () => new Response('', { status: 429 }), 'rate_limited'],
    ['a changed reply', () => reply({ success: true, module: 'none' }), 'schema'],
    // Cainiao's reader reports a reply that is not JSON as an error of its own.
    ['a page in place of its reply', () => reply('<html><title>Cainiao</title></html>'), 'error'],
    ['no record of the number', () => reply(cainiaoUnknown(DELIVERED)), 'not_found'],
  ] as const)('keeps iMile’s answer as it is when Cainiao answers with %s, and records %s', async (_name, answer, kind) => {
    const { result, step } = lookup(answer);
    await expect(result).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
    expect(step()).toMatchObject({ step: 'cainiao', outcome: kind });
  });

  it('gives Cainiao half of the time iMile left, and nothing when that is too short to ask', async () => {
    const hanging = vi.fn((_number: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = performance.now();
    const slow = lookup(hanging, 600);
    await expect(slow.result).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
    expect(performance.now() - started).toBeLessThan(600);
    expect(hanging).toHaveBeenCalledTimes(1);
    // A hang is a transport failure, as the runner records one, after about half of the budget.
    expect(slow.step()).toMatchObject({ outcome: 'transport' });
    expect(slow.step()!.durationMs).toBeLessThan(450);

    const unasked = vi.fn((number: string) => reply(cainiaoUnknown(number)));
    const short = lookup(unasked, 300);
    await expect(short.result).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
    expect(unasked).not.toHaveBeenCalled();
    expect(short.step()).toMatchObject({ outcome: 'budget' });
  });

  it('asks Cainiao only once iMile answered with scans', async () => {
    const unasked = vi.fn((number: string) => reply(cainiaoUnknown(number)));
    const fetcher = site(FIRST, { [DELIVERED]: changed('delivered', (shipment) => { shipment.trackInfos = []; }) }, { cainiao: unasked });
    const tracker = new ImileTracker({ fetcher, signing: FIRST.signing });
    await expect(tracker.fetch(DELIVERED)).rejects.toMatchObject({ name: 'NoHistoryError' });
    await expect(tracker.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(unasked).not.toHaveBeenCalled();
  });

  it('lets Cainiao’s leg give the status while iMile holds only its order record', async () => {
    const ordered = changed('delivered', (shipment) => { shipment.trackInfos = shipment.trackInfos.slice(-1); });
    expect(parseImile(ordered, DELIVERED)).toMatchObject({ status: 'pending', current_stage: 'registered' });
    const { result } = lookup(() => reply(cainiaoFrom('LH_DEPART')), undefined, ordered);
    const merged = await result;
    expect(codes(merged)).toEqual(['LH_DEPART', 'LH_HO_AIRLINE', 'CC_EX_SUCCESS', 'CC_EX_START', 'LH_HO_IN_SUCCESS', '1001',
      'SC_OUTBOUND_SUCCESS', 'SC_INBOUND_SUCCESS', 'PU_PICKUP_SUCCESS']);
    expect(merged).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departed from departure country/region', last_update: '2026-05-17T09:20:00+08:00', destination_country: 'SA' });
    expect(merged).not.toHaveProperty('last_update_local');
    // A notice of Cainiao's keeps the stage of the scan before it and moves nothing: that scan gives the stage.
    expect(cainiaoScans(cainiaoFrom('LAST_MILE_ASN_NOTIFY'), DELIVERED)[0]).toMatchObject({ provider_code: 'LAST_MILE_ASN_NOTIFY', stage: 'in_transit', stage_source: 'none' });
    expect(imileSummary([
      { time: '2026-05-15T00:30:00+08:00', description: 'Carrier update', provider_code: 'LAST_MILE_ASN_NOTIFY', stage: 'in_transit', stage_source: 'none' },
      { time: '2026-05-14T23:50:00+08:00', description: 'Departed from sorting center', provider_code: 'SC_OUTBOUND_SUCCESS', stage: 'in_transit', stage_source: 'carrier_map' },
    ])).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Carrier update' });
  });

  it('keeps only the Cainiao scans older than iMile’s at any offset when iMile’s clocks have no zone', () => {
    const own = parseImile(changed('delivered', (shipment) => { shipment.country = 'BRA'; }), DELIVERED);
    expect(own.events![0]).not.toHaveProperty('time');
    const merged = withCainiaoLeg(own, cainiaoScans(cainiaoFixture(), DELIVERED));
    expect({ ...merged, events: own.events }).toEqual(own);
    // iMile's flight may have left up to 14 hours before its wall clock: Cainiao's departure and handover may be later.
    expect(codes(merged).filter((code) => CAINIAO_CODE.test(String(code))).slice(0, 3)).toEqual(['CC_EX_SUCCESS', 'CC_EX_START', 'LH_HO_IN_SUCCESS']);
    expect(codes(merged).slice(0, 14)).toEqual(codes(own).slice(0, 14));
  });

  it('adds nothing to a history iMile cut short or to none', () => {
    const scans = cainiaoScans(cainiaoFixture(), DELIVERED);
    const truncated = { ...parseImile(fixture('delivered'), DELIVERED), history_truncated: true };
    expect(withCainiaoLeg(truncated, scans)).toBe(truncated);
    const empty = { status: 'unknown' as const, events: [] };
    expect(withCainiaoLeg(empty, scans)).toBe(empty);
  });
});

describe('iMile status vocabulary', () => {
  it('records every code and wording seen with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? '';
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(imileStage(code, entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(imileStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'Lost order' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'User not at home' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'The delivery method has been confirmed with the recipient as Self-Pickup.' }))
      .toMatchObject({ kind: 'intentional_gap' });
    // The pickup point and its address vary; the parcel waits there for the recipient.
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003',
      description: 'The parcel has been delivered to Sample Shop. Please collect your parcel promptly at Sample Street 1 using your pickup code.' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '9999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A delivery-stage sentence the map does not know is read by the shared rules, else stays in transit.
    expect(imileStage('1003', 'Synthetic note')).toEqual({ stage: 'in_transit', source: expect.any(String) });
    expect(imileStage('9999', 'Synthetic note')).toBeNull();
    // The return codes decide whatever the sentence says, but a return is under way until the sender has the parcel.
    expect(imileStage('1008', '【Sample Hub】Received.')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(imileStage('1008', '【Sample Hub】Return signature')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(imileStage('2065', '【Sample Hub】Received.')).toEqual({ stage: 'returned', source: 'carrier_map' });
    // A stored wording shows the name iMile put in 【】 before the sentence.
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1002', description: 'SMP: Clearance start.' })).toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'Contact Error: need to return.' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
  });
});
