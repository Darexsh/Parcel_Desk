import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, REX_PAGE, RexIndonesiaTracker } from './adapter.js';
import { parseRex, REX_MAX_BYTES, rexNumber } from './parser.js';
import { rexStage, statusMap } from './status.js';

const NUMBER = '22201740319586', UNKNOWN = '22201850672491';
const row = (wording: string, day = '', time = '') => `<tr><td class="fortd">${wording}</td><td>${day}</td><td>${time}</td></tr>`;
const rows = row('Asal Synthetic depot', '01-06-2026', '10:15') + row('Tujuan Synthetic destination')
  + row('Dikirim ke Pelanggan') + row('Diterima Oleh : Synthetic Signatory', '03-06-2026', '15:42');
const history = (scans = rows, number = NUMBER) => `<div class="nextPage"><table class="table table-hover table-bordered"><thead><tr><td colspan="3">No Konosemen : ${number}</td></tr><tr><td>Status</td><td>Date</td><td>Time</td></tr></thead><tbody>${scans}</tbody></table><table class="table table-hover table-bordered"><tr><td>Synthetic Recipient Address</td></tr></table></div>`;
const absent = (number = UNKNOWN) => `<div class="nextPage"><div class="alert alert-danger">Data Not Found for Konosemen Number ${number}.</div></div>`;
const reply = (html: string, status = 200, headers: HeadersInit = {}) => new Response(html, { status, headers });
const direct = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('REX Indonesia milestones', () => {
  it('binds the whole consignment heading and keeps only dated, projected milestones', () => {
    const result = parseRex(history(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Diterima', last_update: null, last_update_local: '2026-06-03T15:42', history_truncated: true, expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2026-06-03T15:42', description: 'Diterima', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-06-01T10:15', description: 'Asal', location: 'Synthetic depot' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Signatory|Recipient|Address|destination|Oleh/);
    expect(rexStage('Asal')).toBeNull();
    expect(statusMap.stage(null, 'Diterima')).toBe('delivered');
    expect(statusMap.gaps).toHaveLength(3);
  });

  it('keeps day precision and does not infer movement from origin or destination labels', () => {
    const result = parseRex(history(row('Asal Synthetic depot', '01-06-2026') + row('Tujuan Synthetic depot', '02-06-2026')), NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.last_update_local).toBe('2026-06-02');
    expect(result.events!.every(event => !event.time && !event.stage)).toBe(true);
  });

  it('removes identical rows while preserving distinct milestones at a tied clock', () => {
    const one = row('Asal Synthetic depot', '01-06-2026', '10:15');
    const result = parseRex(history(one + one + row('Tujuan Synthetic hub', '01-06-2026', '10:15')), NUMBER);
    expect(result.events!.map(event => event.description)).toEqual(['Tujuan', 'Asal']);
  });

  it('requires a unique whole identity before any display caps or recipient projection', () => {
    for (const number of [NUMBER + '7', NUMBER + ' '.repeat(500) + '7', UNKNOWN]) {
      expect(() => parseRex(history(rows, number), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const duplicate = history().replace('</div>', history().replace('<div class="nextPage">', '').replace('</div>', '') + '</div>');
    expect(() => parseRex(duplicate, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRex('<input value="' + NUMBER + '">', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts only the carrier-specific whole-number missing notice', () => {
    expect(() => parseRex(absent(), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const html of [absent(NUMBER), absent(UNKNOWN + '7'), absent(UNKNOWN + '.'.repeat(600) + '7'), absent().replace('Data Not Found', 'Service unavailable')]) {
      expect(() => parseRex(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseRex(history().replace('</div>', absent().replace('<div class="nextPage">', '').replace('</div>', '') + '</div>'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('leaves blank template milestones inconclusive and rejects changed clocks or columns', () => {
    expect(() => parseRex(history(row('Diterima Oleh : Synthetic Signatory')), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const [day, time] of [['31-02-2026', '10:00'], ['01-06-2026', '24:00'], ['', '10:00'], ['01-06-2026', '9:00'], ['0000-00-00', '00:00']]) {
      expect(() => parseRex(history(row('Diterima Oleh : Synthetic Signatory', day, time)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseRex(history().replace('<td>Date</td>', '<td>Changed</td>'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRex(history(row('Unknown personal label', '01-06-2026')), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRex('x'.repeat(REX_MAX_BYTES + 1), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRex(history(row('Asal Synthetic depot', '01-06-2026').repeat(101)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('orders a reached day-only delivery after earlier same-day milestones without inventing its hour', () => {
    const result = parseRex(history(row('Asal Synthetic depot', '03-06-2026', '10:15') + row('Diterima Oleh : Synthetic Signatory', '03-06-2026')), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-06-03' });
    expect(result.events![0]).toMatchObject({ local_time: '2026-06-03', description: 'Diterima' });
    expect(result.events![0]!.time).toBeUndefined();
    for (const description of ['Asal', 'Tujuan', 'Dikirim ke Pelanggan']) expect(statusMapAnswer({ carrier: 'rex-indonesia', description }).kind).toBe('intentional_gap');
  });

  it('keeps HTTP 200 browser verification separate from absent parcels', () => {
    expect(() => parseRex('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('sends one complete waybill with the supplied UA, signal and fractional budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(history()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RexIndonesiaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER, { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(REX_PAGE + '?airwaybill=' + NUMBER);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'rex-indonesia', step: 'direct', outcome: 'ok' }));
  });

  it('retries network failures once with recorded recovery provenance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Synthetic network refusal')).mockResolvedValueOnce(reply(history()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RexIndonesiaTracker({ fetcher, recorder }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step.mock.calls.map(([entry]) => [entry.step, entry.outcome, entry.fallbackFrom])).toEqual([['direct', 'transport', null], ['retry', 'ok', 'direct']]);
  });

  it('preserves HTTP kinds and retry-after while omitting unprojected personal response bodies', async () => {
    for (const [status, kind] of [[429, 'rate_limited'], [500, 'indeterminate'], [403, 'challenge'], [404, 'transport'], [302, 'transport']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('<p>Synthetic Recipient Address and Signatory</p>', status, { 'Retry-After': '7' }));
      const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
      const error = await new RexIndonesiaTracker({ fetcher, recorder }).fetch(NUMBER).catch((error: unknown) => error);
      expect(carrierErrorKind(error)).toBe(kind);
      if (status === 429) expect(error).toMatchObject({ retryAfterMs: 7000 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([error, recorder.step.mock.calls, recorder.lookup.mock.calls])).not.toMatch(/Recipient|Address|Signatory/);
    }
  });

  it('removes private headers, response URLs and raw network causes from failures and telemetry', async () => {
    const privateValue = 'synthetic-private-session', capability = 'https://example.invalid/?token=synthetic-capability';
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const response = Object.defineProperty(reply('Synthetic body', 500, { 'Set-Cookie': 'session=' + privateValue, Location: capability }), 'url', { value: capability });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    const httpError = await new RexIndonesiaTracker({ fetcher, recorder }).fetch(NUMBER).catch((error: unknown) => error);
    const networkFetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateValue + ' ' + capability));
    const networkError = await new RexIndonesiaTracker({ fetcher: networkFetcher, recorder }).fetch(NUMBER).catch((error: unknown) => error);
    const serialized = JSON.stringify([httpError, networkError, recorder.step.mock.calls, recorder.lookup.mock.calls]);
    expect(serialized).not.toMatch(/synthetic-private-session|synthetic-capability|example\.invalid/);
    expect(networkFetcher).toHaveBeenCalledTimes(2);
    expect(carrierErrorKind(networkError)).toBe('transport');
  });

  it('keeps invalid input, cancellation and budget failures from starting a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345', NUMBER + '7', 'x'.repeat(70)]) await expect(direct(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(rexNumber('1234 5678 9012')).toBe('123456789012');
    await expect(direct(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('Synthetic stop')) })).rejects.toThrow('Synthetic stop');
    await expect(direct(fetcher).track({ number: NUMBER }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes actual dated history and the carrier absence signature through HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(history())).mockResolvedValueOnce(reply(absent()));
    await expect(direct(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-03T15:42:00' });
    await expect(direct(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('routes a recent own-format waybill automatically with universal providers disabled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-06-04T12:00:00Z'));
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
        if (new URL(String(input)).hostname !== 'www.rex.co.id') throw new Error('Synthetic transport refuses other hosts');
        return reply(history());
      });
      const answer = await createTracker({ fetcher, providers: [], env: {}, trawlUrl: '', chromiumPath: '' }).track({ number: NUMBER });
      expect(answer).toMatchObject({ carrier: 'rex-indonesia', source: 'rex-indonesia', result: { current_stage: 'delivered', history_truncated: true } });
      expect(fetcher.mock.calls.filter(([input]) => new URL(String(input)).hostname === 'www.rex.co.id')).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});
