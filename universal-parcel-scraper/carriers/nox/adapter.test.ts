import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NoxTracker } from './adapter.js';
import { normalizeNoxNumber, NOX_API, parseNox } from './parser.js';
import { noxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '220000000001260210000001';
const IN_TRANSIT = '220000000001261024000002';
const UNKNOWN = '220000000001260101999999';
const OLDER = 'SWR000000002610230000001';
const RETURN = 'RA1ZZ9900000001000000001';

type Row = Record<string, unknown>;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Row[];
const edited = (name: string, change: (rows: Row[]) => void) => {
  const rows = fixture(name);
  change(rows);
  return rows;
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

/** nox's lookup, answering each barcode from its fixture. */
function site() {
  return vi.fn<typeof fetch>(async (input) => {
    const barcode = String(input).slice(NOX_API.length);
    return reply(barcode === DELIVERED ? text('delivered') : barcode === IN_TRANSIT ? text('in-transit') : text('not-found'));
  });
}

describe('nox tracking adapter', () => {
  it('asks the tracker’s lookup for the barcode through the supplied transport', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NoxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 22000 0000001 261024 000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(`https://trackandtrace.app.nox.express/api/scannungen/${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'nox', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, dating every scan in Germany and dropping the repeated arrival scan', () => {
    const result = parseNox(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Collo von nox zugestellt', last_update: '2026-02-12T07:14:09+01:00', expected_delivery: null,
      delivered_at: '2026-02-12T07:14:09+01:00' });
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-02-12T07:14:09+01:00', 'Collo von nox zugestellt', 'delivered'],
      ['2026-02-12T01:02:44+01:00', 'Collo in nox Zustellfahrzeug geladen', 'out_for_delivery'],
      // A night at the branch, not a delivery round.
      ['2026-02-11T04:20:31+01:00', 'Collo steht am Lager in nox Niederlassung, Zustellung nicht im geplanten Zeitfenster', 'in_transit'],
      ['2026-02-11T00:41:18+01:00', 'Collo in der nox Niederlassung eingetroffen', 'in_transit'],
      ['2026-02-10T18:05:52+01:00', 'Collo von der nox Niederlassung weiterverladen', 'in_transit'],
      ['2026-02-10T16:22:07+01:00', 'Collo in der nox Niederlassung eingetroffen', 'in_transit'],
      ['2026-02-10T11:30:00+01:00', 'Collo durch Versender bereitgestellt zur Abholung', 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2026-02-12T07:14:09+01:00', description: 'Collo von nox zugestellt',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
  });

  it('reads a parcel in transit, dating a repeated hour as its first occurrence', async () => {
    const result = await carrier(site()).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Collo in der nox Niederlassung eingetroffen',
      last_update: '2026-10-25T02:30:15+02:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-10-25T02:30:15+02:00', 'in_transit'],
      ['2026-10-24T20:11:40+02:00', 'in_transit'],
      ['2026-10-24T13:00:00+02:00', 'registered'],
    ]);
  });

  it('leaves out the place, remark and postcode the page shows after the recipient’s postcode, and orders an oldest-first reply', () => {
    const result = parseNox(edited('in-transit', (rows) => {
      rows[0]!.scanort = 'Musterstadt';
      rows[0]!.bemerkung = 'Abgestellt bei Erika Musterfrau';
      rows[0]!.plz = '99999';
      rows.reverse();
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.time)).toEqual(['2026-10-25T02:30:15+02:00', '2026-10-24T20:11:40+02:00', '2026-10-24T13:00:00+02:00']);
    expect(JSON.stringify(result)).not.toMatch(/Musterstadt|Musterfrau|99999|GKS_90|4711/);
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const result = parseNox(edited('in-transit', (rows) => {
      rows.reverse();
      rows[1]!.scanZeit = rows[0]!.scanZeit;
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.description)).toEqual(['Collo in der nox Niederlassung eingetroffen',
      'Collo von der nox Niederlassung weiterverladen', 'Collo durch Versender bereitgestellt zur Abholung']);
  });

  it('leaves a scan whose wording it does not know without a stage', () => {
    const result = parseNox(edited('in-transit', (rows) => { rows[0]!.status = 'Synthetischer Scan'; }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ time: '2026-10-25T02:30:15+02:00', description: 'Synthetischer Scan' });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetischer Scan' });
  });

  it('reads the tracker’s empty answer as not found', async () => {
    await expect(carrier(site()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'indeterminate'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const body = status === 404 ? { timestamp: '2026-01-01T00:00:00.000+00:00', status: 404, error: 'Not Found', path: '/scannungen/' } : [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('reads a bot check in place of the reply as a challenge', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK, 200, { 'Content-Type': 'text/html' }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('<html><body>Request blocked.</body></html>', 403))).recognize!(DELIVERED))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reports a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('', 429, { 'Retry-After': '120' }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
  });

  it('rejects malformed replies', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('<!doctype html><app-root></app-root>', 200, { 'Content-Type': 'text/html' })))
      .track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    for (const payload of [
      null,
      {},
      { scans: [] },
      ['Collo von nox zugestellt'],
      edited('delivered', (rows) => { delete rows[0]!.barcode; }),
      edited('delivered', (rows) => { rows[0]!.barcode = 22000; }),
      edited('delivered', (rows) => { rows[0]!.scanZeit = '12.02.2026 07:14'; }),
      edited('delivered', (rows) => { rows[0]!.scanZeit = '2026-02-30T07:14:09'; }),
      edited('delivered', (rows) => { rows[0]!.scanZeit = '2026-02-12T07:14:09+01:00'; }),
      edited('delivered', (rows) => { delete rows[0]!.scanZeit; }),
      edited('delivered', (rows) => { rows[0]!.status = 42; }),
      edited('delivered', (rows) => { rows[0]!.status = ' '; }),
      Array.from({ length: 301 }, () => fixture('delivered')[0]),
    ]) expect(() => parseNox(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds every scan to the whole barcode asked', () => {
    expect(() => parseNox(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A reply that mixes another barcode's scans is inconclusive too.
    expect(() => parseNox([...fixture('delivered'), ...fixture('in-transit')], DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseNox(edited('delivered', (rows) => { rows[3]!.barcode = `${DELIVERED}1`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseNox(edited('delivered', (rows) => { rows[0]!.barcode = ` ${DELIVERED} `; }), DELIVERED).current_stage).toBe('delivered');
  });

  it('takes the shipping, older SWR and return barcodes, in capitals, and refuses anything else before any request', async () => {
    const fetcher = site();
    for (const number of ['22000000000126021000000', '2200000000012602100000011', '221230000001260210000001', 'SWR00000000261023000000',
      'SWX000000002610230000001', 'RA3ZZ9900000001000000001', 'RA1ZZ990000000100000000A', 'ABC', `22000${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => normalizeNoxNumber('ABC')).toThrow('24 digits, SWR and 21 digits, RA and 22 characters, or C and 29 digits');
    expect(normalizeNoxNumber(' swr-0000 0000 2610 2300 0000 1 ')).toBe(OLDER);
    expect(normalizeNoxNumber('ra1zz9900000001000000001')).toBe(RETURN);
    await expect(carrier(fetcher).track({ number: RETURN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${NOX_API}${RETURN}`);
  });

  it('takes a sender barcode of C and 29 digits, which the tracker also answers, and leaves its detection unclaimed', async () => {
    const fetcher = site();
    const sender = `C${'0'.repeat(20)}123456789`;
    expect(normalizeNoxNumber(` ${sender.toLowerCase()} `)).toBe(sender);
    await expect(carrier(fetcher).track({ number: sender })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${NOX_API}${sender}`);
    for (const number of [`C${'0'.repeat(28)}`, `C${'0'.repeat(30)}`, `D${'0'.repeat(29)}`]) {
      expect(() => normalizeNoxNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(detectCarrierMatch(sender).candidates).not.toContain('nox');
  });

  it('recognizes a known barcode with its last activity and an unknown one from plain HTTP', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-02-12T06:14:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is asked about the shipping barcodes it shares with other carriers, and reads the tracker’s address', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['nox', 'inpost', 'bpost']) });
    expect(recognitionAskedCarriers(DELIVERED)).toContain('nox');
    expect(detectCarrierMatch(OLDER)).not.toMatchObject({ carrier: 'nox' });
    expect(parseTrackingInput(`https://trackandtrace.app.nox.express/scannungen/${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'nox', source: 'link' });
    await expect(createTracker({ fetcher: site(), providers: [], env: {} }).track({ number: DELIVERED, carrier: 'nox' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'nox', source: 'nox', result: { current_stage: 'delivered' } });
  });
});

describe('nox status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(noxStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'nox', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'nox', description: 'Synthetischer Scan' })).toEqual({ kind: 'unknown' });
  });
});
