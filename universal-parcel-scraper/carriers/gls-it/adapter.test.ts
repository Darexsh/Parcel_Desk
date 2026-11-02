import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, GLSItalyTracker, glsItalyLookupUrl } from './adapter.js';
import { normalizeGLSItalyNumber, parseGLSItaly, parseGLSItalyReply } from './parser.js';
import { glsItalyEnglish, glsItalyScanStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'ZZ900000001';
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
type Row = Record<string, unknown> & { history: Record<string, unknown>[]; progressBar: Record<string, unknown> };
/** The fixture's one shipment row, changed by `change`. */
const shipment = (change: (row: Row) => void = () => {}) => {
  const value = fixture();
  change(value.tuStatus[0]);
  return value;
};
const reply = (body: unknown = fixture(), status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'HostAgent/1.0',
  recorder: { step() {}, lookup() {} } });

describe('GLS Italy direct tracking', () => {
  it('reads the scans newest first in Italian time, with the weight and nothing private', () => {
    const result = normalizeCarrierResult(parseGLSItaly(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered.', last_update: '2026-03-05T11:42:00+01:00', expected_delivery: null, weight_kg: 1.4 });
    expect(result).not.toHaveProperty('last_update_local');
    // The repeated scan is kept once.
    expect(result.events).toHaveLength(9);
    expect(result.events?.[0]).toEqual({ time: '2026-03-05T11:42:00+01:00', description: 'Delivered.', location: 'Sample Village',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events?.[2]).toMatchObject({ stage: 'exception', description: expect.stringMatching(/^Not in delivery\./) });
    expect(result.events?.[3]).toMatchObject({ stage: 'failed_attempt', time: '2026-03-04T12:03:00+01:00',
      description: 'Parcel not delivered as the consignee was absent, please book redelivery within 3 working days as per instructions provided by email or sms.' });
    expect(result.events?.[4]).toMatchObject({ stage: 'out_for_delivery' });
    expect(result.events?.[6]).toMatchObject({ stage: 'in_transit', location: 'Centro Di Smistamento - HUB' });
    // A scan with a date and no time keeps its day.
    expect(result.events?.at(-1)).toMatchObject({ local_time: '2026-03-01', stage: 'registered', location: 'Sample Depot Town' });
    expect(result.events?.slice(0, -1).every((event) => event.time && !('local_time' in event))).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Pr\*{4}|PR\*{4}|Secretville|Privatetown|SAMPLE DEPOT|EXAMPLE DEPOT|Departure|02\/03\/2026|Volume|2,0/);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.capabilities).toEqual(['history', 'location', 'weight']);
    expect(metadata.tracking).toMatchObject({ adapter: 'gls-it', steps: ['direct', 'retry'], localClocks: true });
  });

  it('reads summer scans at Italian summer time, the repeated hour once, and keeps a skipped hour local', () => {
    const result = parseGLSItaly(shipment((row) => {
      row.history.unshift(
        { time: '02:30:00', date: '2026-10-25', evtDscr: 'Zxq.', address: { city: 'Sample Village' } },
        { time: '02:30:00', date: '2026-03-29', evtDscr: 'Zxq.', address: { city: 'Sample Village' } },
        { time: '09:15', date: '2026-07-01', evtDscr: 'Zxq.', address: { city: 'Sample Village' } },
      );
    }), NUMBER);
    expect(result.events?.slice(0, 3).map((event) => event.time ?? event.local_time))
      .toEqual(['2026-10-25T02:30:00+02:00', '2026-03-29T02:30:00', '2026-07-01T09:15:00+02:00']);
    expect(result.events?.[1]).not.toHaveProperty('time');
  });

  it('takes the stage from the newest scan, the rail only when its sentence says nothing, and the return flag first', () => {
    const pending = parseGLSItaly(shipment((row) => { row.history.splice(0, 9); }), NUMBER);
    expect(pending).toMatchObject({ status: 'pending', current_stage: 'registered', last_update_local: '2026-03-01' });
    // A sentence nothing reads leaves the scan without a stage; the rail's current step stands in.
    const unread = parseGLSItaly(shipment((row) => {
      row.history.unshift({ time: '13:00:00', date: '2026-03-05', evtDscr: 'Zxq.', address: { city: 'Sample Village' } });
    }), NUMBER);
    expect(unread).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Zxq.' });
    expect(unread.events?.[0]).not.toHaveProperty('stage');
    const railUnknown = parseGLSItaly(shipment((row) => {
      row.history.unshift({ time: '13:00:00', date: '2026-03-05', evtDscr: 'Zxq.' });
      row.progressBar.statusInfo = 'SOMETHINGNEW';
    }), NUMBER);
    expect(railUnknown).toMatchObject({ status: 'unknown', last_status_text: 'Zxq.' });
    expect(railUnknown).not.toHaveProperty('current_stage');
    expect(railUnknown.events?.[0]).not.toHaveProperty('location');
    // A sentence the map does not hold goes to the shared wording rules.
    const worded = parseGLSItaly(shipment((row) => {
      row.history.unshift({ time: '13:00:00', date: '2026-03-05', evtDscr: 'Spedizione consegnata al destinatario.', address: { city: 'Sample Village' } });
    }), NUMBER);
    expect(worded.events?.[0]).toMatchObject({ stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) });
    expect(worded.current_stage_source).toMatch(/^wording:/);
    const returning = parseGLSItaly(shipment((row) => { row.progressBar.retourFlag = true; }), NUMBER);
    expect(returning).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });

  it('keeps the weight only when the page prints one', () => {
    for (const value of ['   0,0 Kg', '', 'n/a', '1.4 kg; 2 kg']) {
      const result = parseGLSItaly(shipment((row) => { (row.infos as Record<string, unknown>[])[1]!.value = value; }), NUMBER);
      expect(result, value).not.toHaveProperty('weight_kg');
    }
    expect(parseGLSItaly(shipment((row) => { (row.infos as Record<string, unknown>[])[1]!.value = '12 kg'; }), NUMBER).weight_kg).toBe(12);
  });

  it('maps every recorded sentence, and the status map answers as the parser stages', () => {
    for (const entry of statuses.entries) {
      if (!('wording' in entry)) continue;
      expect(glsItalyScanStage(entry.wording!), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'gls-it', description: entry.wording! })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'gls-it', description: '  DELIVERED. ' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'gls-it', providerCode: 'DELIVERED', description: 'Delivered.' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'gls-it', description: 'Delivered' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Zxq.']) expect(glsItalyScanStage(wording), wording).toBeNull();
  });

  it('shows the English locale sentence for an Italian one', () => {
    const italian = parseGLSItaly(shipment((row) => {
      row.history[0]!.evtDscr = 'Consegnata.';
      row.history[1]!.evtDscr = 'In transito.';
    }), NUMBER);
    expect(italian.events![0]).toMatchObject({ description: 'Delivered.', stage: 'delivered', stage_source: 'carrier_map' });
    expect(italian.events![1]).toMatchObject({ description: 'Shipment in transit.', stage: 'in_transit' });
    expect(italian.last_status_text).toBe('Delivered.');
    for (const entry of statuses.entries) {
      if (!('wording' in entry) || entry.language !== 'it') continue;
      expect(glsItalyEnglish(entry.wording), entry.wording).toBe(entry.english);
      const shown = parseGLSItaly(shipment((row) => { row.history[0]!.evtDscr = entry.wording; }), NUMBER).events![0]!;
      expect(shown.description, entry.wording).not.toBe(entry.wording);
      expect(glsItalyScanStage(shown.description!), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('binds the reply to the whole shipment number', () => {
    expect(() => parseGLSItaly(fixture(), 'ZZ900000002')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const other = shipment((row) => { row.tuNo = 'ZZ 9000000011'; });
    expect(() => parseGLSItaly(other, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = fixture();
    twice.tuStatus.push(structuredClone(twice.tuStatus[0]));
    delete twice.tuStatus[0].infos;
    expect(() => parseGLSItaly(twice, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema', message: expect.stringMatching(/ambiguous/) }));
    // A reply of several rows starts with the shipment, then its parcels.
    const parcels = fixture();
    parcels.tuStatus.push({ ...structuredClone(parcels.tuStatus[0]), tuNo: '123456', history: [] });
    expect(parseGLSItaly(parcels, NUMBER)).toMatchObject({ status: 'delivered' });
    const overviewOfAnother = fixture();
    overviewOfAnother.tuStatus.unshift({ ...structuredClone(overviewOfAnother.tuStatus[0]), tuNo: 'ZZ 900000002' });
    expect(parseGLSItaly(overviewOfAnother, NUMBER)).toMatchObject({ status: 'delivered' });
    for (const tuNo of [undefined, 900000001, ['ZZ 900000001']]) {
      expect(() => parseGLSItaly(shipment((row) => { row.tuNo = tuNo; }), NUMBER), String(tuNo)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('validates the reply and its scans', () => {
    expect(() => parseGLSItaly({ tuStatus: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGLSItaly(shipment((row) => { row.history = []; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const value of [null, [], {}, { tuStatus: {} }, { tuStatus: Array.from({ length: 51 }, () => ({})) }]) {
      expect(() => parseGLSItaly(value, NUMBER), JSON.stringify(value)?.slice(0, 40)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const broken: [string, (row: Row) => void][] = [
      ['no list', (row) => { row.history = 'x' as unknown as Row['history']; }],
      ['too many scans', (row) => { row.history = Array.from({ length: 501 }, () => row.history[0]!); }],
      ['a scan that is not an object', (row) => { row.history.unshift('Delivered.' as unknown as Record<string, unknown>); }],
      ['no wording', (row) => { row.history[0]!.evtDscr = ' '; }],
      ['an impossible day', (row) => { row.history[0]!.date = '2026-02-30'; }],
      ['another date format', (row) => { row.history[0]!.date = '05/03/2026'; }],
      ['an impossible clock', (row) => { row.history[0]!.time = '25:00:00'; }],
      ['a clock as a number', (row) => { row.history[0]!.time = 1142; }],
    ];
    for (const [name, change] of broken) {
      expect(() => parseGLSItaly(shipment(change), NUMBER), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('knows a missing shipment only from the 404 with the no-results notice', () => {
    expect(() => parseGLSItalyReply(404, fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const italian = { exceptionText: 'Non sono stati trovati risultati.<br>Per favore controllare i dati inseriti.' };
    expect(() => parseGLSItalyReply(404, italian, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [
      { lastError: 'E800', exceptionText: 'An error occurred while retrieving the shipment information.' },
      { exceptionText: 'Internal system error [00000000-0000-0000-0000-000000000000].<br>Please try again later.' },
      { ...fixture('not-found'), tuStatus: [] }, {}, null,
    ]) {
      expect(() => parseGLSItalyReply(404, payload, NUMBER), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The notice with a success status is not an answer either.
    expect(() => parseGLSItalyReply(200, fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseGLSItalyReply(200, fixture(), NUMBER)).toMatchObject({ status: 'delivered' });
  });

  it('accepts the national shipment numbers of the tracking form', () => {
    expect(normalizeGLSItalyNumber(' zz 900000001 ')).toBe(NUMBER);
    expect(normalizeGLSItalyNumber('Z9900000001')).toBe('Z9900000001');
    expect(normalizeGLSItalyNumber('ZZ1234')).toBe('ZZ1234');
    for (const number of ['ZZ9000000001', '9Z900000001', 'ZZ', '00000000000', '000000000000GLS', 'ZZ90000000A']) {
      expect(() => normalizeGLSItalyNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(glsItalyLookupUrl('zz 900000001'))
      .toBe('https://gls-group.com/app/service/open/rest/IT/en/rstt030?match=ZZ900000001&type=NAT&caller=witt002');
  });

  it('keeps detection as it was and reads GLS Italy links', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ confidence: 'low', candidates: ['gls-it'] });
    expect(parseTrackingInput(`https://gls-group.com/IT/it/servizi-online/ricerca-spedizioni/?match=${NUMBER}&type=NAT`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'gls-it', source: 'link' });
  });

  it('asks the national lookup once, with the host agent and no session', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(String(url)).toBe(glsItalyLookupUrl(NUMBER));
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBe('HostAgent/1.0');
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.has('cookie')).toBe(false);
      return reply();
    });
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: 'zz 900000001', postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(instance.track({ number: '00000000000' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure taxonomy, retries a failed connection once and bounds bodies', async () => {
    for (const [body, status, kind] of [
      [{ exceptionText: 'Internal system error [x].' }, 500, 'indeterminate'],
      ['', 403, 'challenge'], ['', 429, 'rate_limited'], ['', 503, 'maintenance'],
      ['<html><title>Just a moment...</title></html>', 200, 'challenge'],
      ['<!doctype html><html><body>Maintenance</body></html>', 200, 'indeterminate'],
      ['<html><head><title>GLS</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head></html>', 200, 'indeterminate'],
      ['<html><body><div class="cf-turnstile"></div></body></html>', 403, 'challenge'],
      ['{"tuStatus":', 200, 'schema'],
    ] as const) {
      const fetcher = vi.fn(async () => reply(body, status)) as unknown as typeof fetch;
      await expect(new GLSItalyTracker({ fetcher }).fetch(NUMBER), `${status} ${String(body).slice(0, 20)}`).rejects.toMatchObject({ kind });
    }
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    expect(await new GLSItalyTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(NUMBER)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const absentOnce = vi.fn(async () => reply(fixture('not-found'), 404));
    await expect(new GLSItalyTracker({ fetcher: absentOnce as unknown as typeof fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(absentOnce).toHaveBeenCalledTimes(1);
    const large = vi.fn(async () => new Response(new Uint8Array(600_000))) as unknown as typeof fetch;
    await expect(new GLSItalyTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a known shipment and treats only the no-results notice as unknown', async () => {
    const known = vi.fn<typeof fetch>(async () => reply());
    const instance = adapter(environment(known));
    expect(await instance.recognize!('00000000000')).toEqual({ known: false });
    expect(known).not.toHaveBeenCalled();
    // The newest scan's Italian time dates the shipment.
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: '2026-03-05T10:42:00.000Z' });
    const unknown = vi.fn(async () => reply(fixture('not-found'), 404));
    expect(await adapter(environment(unknown as unknown as typeof fetch)).recognize!(NUMBER)).toEqual({ known: false });
    const outage = vi.fn(async () => reply({ exceptionText: 'Internal system error [x].' }, 500));
    await expect(adapter(environment(outage as unknown as typeof fetch)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new GLSItalyTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new GLSItalyTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    // A request that hangs ends with the budget, retried at most once.
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new GLSItalyTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
