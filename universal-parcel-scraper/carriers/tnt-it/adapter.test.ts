import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TNT_ITALY_API, TntItalyTracker } from './adapter.js';
import { normalizeTntItalyNumber, parseTntItaly } from './parser.js';
import { statusMap, tntItalyStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ00000001';
const IN_TRANSIT = 'ZZ00000002';
const UNKNOWN = 'ZZ00000009';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
// tnt.it sends its XML in ISO-8859-1 and labels the reply as HTML.
const reply = (body: string, init: ResponseInit = {}) => new Response(Buffer.from(body, 'latin1'),
  { ...init, headers: { 'Content-Type': 'text/html;charset=ISO-8859-1', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const consignment = (xml: string) => /<Consignment[\s\S]*<\/Consignment>/.exec(xml)![0];
const withConsignments = (...parts: string[]) => fixture('not-found').replace(/<RuntimeError>[\s\S]*<\/RuntimeError>/, parts.join(''));
const refusal = (code: string) => fixture('not-found').replace('00015', code);
// The page Akamai serves when it turns a client away.
const DENIED = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\nReference&#32;&#35;18&#46;0 https&#58;&#47;&#47;errors&#46;edgesuite&#46;net</BODY></HTML>';

describe('TNT Italy HTTP adapter', () => {
  it('posts the whole waybill to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TntItalyTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 0000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TNT_ITALY_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`wt=1&consigNos=${IN_TRANSIT}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tnt-it', step: 'direct', outcome: 'ok' }));
  });

  it('reads each scan’s clock in Italian time and keeps a depot only where the reply shows it', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'La spedizione e\' in transito', last_update: '2026-10-10T05:02:00+02:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toEqual([
      { time: '2026-10-10T05:02:00+02:00', description: 'La spedizione e\' in transito', location: 'FORLÌ SAMPLE', provider_code: '12',
        stage: 'in_transit', stage_source: 'carrier_map' },
      // A code the map does not know keeps its wording, and a depot the reply hides stays hidden.
      { time: '2026-10-10T01:30:00+02:00', description: 'Aggiornamento di prova', provider_code: 'XX' },
      { time: '2026-10-09T19:15:00+02:00', description: 'La spedizione e\' regolarmente partita', location: 'SAMPLETOWN', provider_code: '07',
        stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    // Winter scans are an hour closer to UTC.
    const winter = parseTntItaly(fixture('in-transit').replaceAll('/10/2026', '/01/2027'), IN_TRANSIT);
    expect(winter.events!.map((event) => event.time)).toEqual(['2027-01-10T05:02:00+01:00', '2027-01-10T01:30:00+01:00', '2027-01-09T19:15:00+01:00']);
  });

  it('keeps the delivery and its clock without the sender, recipient, reference, signatory or the repeated scan', () => {
    const result = parseTntItaly(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Spedizione consegnata', last_update: '2026-09-04T09:44:00+02:00', delivered_at: '2026-09-04T09:43:00+02:00' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-09-04T09:44:00+02:00', '90', 'delivered', 'SAMPLE DEPOT NORD'],
      ['2026-09-03T17:20:00+02:00', '20', 'ready_for_pickup', 'SAMPLE DEPOT NORD'],
      ['2026-09-03T13:07:00+02:00', '65', 'in_transit', 'SAMPLE DEPOT NORD'],
      ['2026-09-03T04:57:00+02:00', '12', 'in_transit', 'SAMPLE DEPOT NORD'],
      ['2026-09-01T18:41:00+02:00', '07', 'in_transit', 'SAMPLETOWN'],
      // A drop-off at a FedEx Location names no depot.
      ['2026-09-01T09:05:00+02:00', 'P', 'accepted', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE (?:SENDER|RECIPIENT|SIGNATORY|CITY)|VIA |SAMPLE-REF|00000\b|XX0000|Economy/);
    // Without a delivery scan, the delivery clock is not taken.
    const held = parseTntItaly(fixture('delivered').replace(/<StatusDetails><StatusCode><!\[CDATA\[90[\s\S]*?<\/StatusDetails>/, ''), DELIVERED);
    expect(held).toMatchObject({ current_stage: 'ready_for_pickup', last_update: '2026-09-03T17:20:00+02:00' });
    expect(held).not.toHaveProperty('delivered_at');
  });

  it('follows the newest shipment when a waybill was used again', () => {
    const older = consignment(fixture('delivered')).replace(DELIVERED, IN_TRANSIT);
    const other = consignment(fixture('delivered'));
    for (const xml of [withConsignments(older, consignment(fixture('in-transit')), other), withConsignments(consignment(fixture('in-transit')), older)]) {
      expect(parseTntItaly(xml, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_update: '2026-10-10T05:02:00+02:00' });
    }
    expect(parseTntItaly(withConsignments(older, other), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('counts a shipment only when it names the waybill asked', () => {
    expect(() => parseTntItaly(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'TNT Italy answered for another shipment' }));
    expect(parseTntItaly(fixture('in-transit').replace(IN_TRANSIT, 'zz 00000002'), IN_TRANSIT).events).toHaveLength(3);
  });

  it('reads an unknown waybill as not found, FedEx’s or another error as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseTntItaly(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTntItaly(refusal('40000'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TNT Italy sends this shipment to FedEx\'s tracker' }));
    expect(() => parseTntItaly(refusal('99999'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTntItaly(fixture('in-transit').replace(/<StatusDetails>[\s\S]*<\/StatusDetails>/, ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    const transit = fixture('in-transit');
    for (const xml of [
      '', 'not xml', transit.slice(0, 2000), transit.replace('traOU.dtd', 'other.dtd'),
      transit.replaceAll('ResultSet>', 'Results>'),
      withConsignments(), fixture('not-found').replace('</ResultSet>', `${/<RuntimeError>[\s\S]*<\/RuntimeError>/.exec(fixture('not-found'))![0]}</ResultSet>`),
      withConsignments(...Array.from({ length: 21 }, () => consignment(transit))),
      transit.replace(/(<StatusDetails>[\s\S]*?<\/StatusDetails>)/, (row) => row.repeat(301)),
      transit.replace('<![CDATA[12]]></StatusCode>', '<![CDATA[12]]></StatusCode><StatusCode><![CDATA[07]]></StatusCode>'),
      transit.replace('<![CDATA[Aggiornamento di prova]]>', '<b>Aggiornamento</b>'),
      transit.replace('<![CDATA[Aggiornamento di prova]]>', ''),
      transit.replace('10/10/2026]]', '31/02/2026]]'),
      transit.replace('05:02', '25:02'),
      transit.replace('05:02', ''),
      transit.replace('10/10/2026]]', '2026-10-10]]'),
    ]) {
      expect(() => parseTntItaly(xml, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown waybill, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every waybill: a missing route or a redirect is a moved service.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.tnt.it/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(DENIED, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(DENIED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>TNT - Tracking</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('reads a UTF-8 reply when the header says so', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('in-transit'), { headers: { 'Content-Type': 'text/xml; charset=UTF-8' } }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ events: [{ location: 'FORLÌ SAMPLE' }, {}, {}] });
  });

  it('recognizes a known waybill and the unknown-waybill answer, and asks nothing for a number TNT Italy does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-04T07:44:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ZZ0000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers TNT Italy does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ0000000', 'ZZ0000000012', 'Z000000001', '1200000001', 'ZZ00000001-15', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTntItalyNumber(' zz-0000 0001 ')).toBe(DELIVERED);
  });

  it('drops the check digit a label prints after the waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: `${DELIVERED}-5` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(String(fetcher.mock.calls[0]![1]!.body)).toBe(`wt=1&consigNos=${DELIVERED}`);
    expect(normalizeTntItalyNumber(`${DELIVERED}5`)).toBe(DELIVERED);
  });

  it('sends a read that failed to reach tnt.it once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 40.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a waybill filed under TNT Italy, or one it recognizes, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tnt-it' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tnt-it', source: 'tnt-it', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tnt-it', source: 'tnt-it' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === TNT_ITALY_API)).toBe(true);
  });
});

describe('TNT Italy numbers', () => {
  it('offers a branch’s two letters and eight digits to TNT Italy without claiming them', () => {
    for (const number of [DELIVERED, IN_TRANSIT, 'NA12345678']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['tnt-it']) });
    }
    for (const number of ['ZZ0000000', 'ZZ000000001', 'Z1000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('tnt-it');
    }
  });
});

describe('TNT Italy status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(tntItalyStage(entry.code), entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'tnt-it', providerCode: '90', description: 'Spedizione consegnata' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'tnt-it', providerCode: 'XX', description: 'Aggiornamento di prova' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'tnt-it', providerCode: '13',
      description: 'La spedizione verrà consegnata come da accordi presi con il destinatario' })).toMatchObject({ kind: 'intentional_gap' });
    expect(tntItalyStage(' p ')).toBe('accepted');
  });
});
