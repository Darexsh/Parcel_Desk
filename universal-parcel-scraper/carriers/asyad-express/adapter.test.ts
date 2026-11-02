import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ASYAD_EXPRESS_ENDPOINT, AsyadExpressTracker, OMAN_POST_ENDPOINT } from './adapter.js';
import { asyadNumber, parseAsyadExpress, parseOmanPost } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '824607391';
const POSTAL = 'ZZ000000014OM';
const express = () => ({ status: 200, success: true, data: [
  { status: 'Parcel is delivered', event_code_en: 'Parcel is delivered', statusCode: 'S400', statusTime: 'Mar-12-2026 09:05 PM', remarks: 'SYNTHETIC recipient and contact details' },
  { status: 'Arrived in Muscat (Oman) Hub', statusCode: 'S1001', statusTime: 'Mar-10-2026 04:30 PM' },
] });
const missing = (number = NUMBER) => ({ status: 404, success: false, data: [], message: `Not found tracking: ${number}` });
const postal = () => ({ OrderId: POSTAL, track: [
  { EventCode: '8   ', Eventdesc: 'Insert item into bag (Otb)', EventDate: '3/10/2026 2:55:00 AM', city: 'SGSINB' },
  { EventCode: '37', Eventdesc: 'Deliver item (Inb)', EventDate: '3/12/2026 9:40:21 AM', city: 'Sohar Post Office', recipient: 'SYNTHETIC recipient' },
] });
const postalMissing = { content: null, success: 'false', error: { errorCode: 'error 01', errorMsg: 'no data found' } };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0', env: {}, trawl: null, browserExecutablePath: null });

describe('Asyad Express mobile guest tracking', () => {
  it('uses the whole shipment path and supplied transport without a postal request on success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(express()));
    const result = await carrier(fetcher).track({ number: NUMBER }, { budgetMs: 2000.5 });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-03-12T21:05:00' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`${ASYAD_EXPRESS_ENDPOINT}${NUMBER}/ultimate-history`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', Authorization: expect.stringMatching(/^oauth /),
    } });
    expect(result.events![0]!.time).toBeUndefined();
    expect(result.events![1]).toMatchObject({ local_time: '2026-03-10T16:30:00', time: '2026-03-10T16:30:00+04:00', time_zone_basis: 'place' });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it('checks the postal system after an explicit express miss and binds its whole identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(missing(POSTAL), 404)).mockResolvedValueOnce(reply(postal()));
    const result = await carrier(fetcher).track({ number: POSTAL });
    expect(result).toMatchObject({ status: 'delivered', history_truncated: true, delivered_at: '2026-03-12T09:40:21+04:00' });
    expect(result.events!.map(event => event.provider_code)).toEqual(['37', '8']);
    expect(result.events![1]).toMatchObject({ location: 'SGSINB', time: '2026-03-10T02:55:00+08:00' });
    expect(fetcher.mock.calls[1]![0]).toBe(`${OMAN_POST_ENDPOINT}?TrackingID=${POSTAL}`);
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).has('Authorization')).toBe(false);
    expect(() => parseOmanPost({ ...postal(), OrderId: POSTAL + 'EXTRA' }, POSTAL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it('requires both explicit missing responses before declaring absence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => String(input).includes('ultimate-history') ? reply(missing(), 404) : reply(postalMissing, 404));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: false });
    expect(() => parseAsyadExpress(missing(NUMBER + '0'), NUMBER, 404)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseOmanPost({ ...postalMissing, error: { errorCode: 'error 01', errorMsg: 'service unavailable' } }, NUMBER, 404))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps empty and malformed histories inconclusive without a postal fallback', async () => {
    for (const body of [null, [], {}, { ...express(), success: 'true' }, { ...express(), data: Array(501).fill(express().data[0]) }]) {
      expect(() => parseAsyadExpress(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ ...express(), data: [] }));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const patch of [{ statusTime: 'Feb-30-2026 01:00 PM' }, { statusTime: {} }, { statusCode: {} }, { event_code_en: {}, status: 'Delivered' }]) {
      const body = express(); Object.assign(body.data[0]!, patch);
      expect(() => parseAsyadExpress(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [{ ...postal(), OrderId: {} }, { ...postal(), track: [] }, { ...postal(), track: [{ ...postal().track[0], EventDate: '2/30/2026 1:00:00 PM' }] }]) {
      expect(() => parseOmanPost(body, POSTAL)).toThrow(expect.objectContaining({ kind: expect.stringMatching(/schema|indeterminate/) }));
    }
  });

  it('retains the source sequence across foreign local clocks and deduplicates exact scans', () => {
    const body = express();
    body.data[0]!.statusTime = 'Mar-10-2026 03:00 PM';
    body.data.splice(1, 0, { ...body.data[0]! });
    const result = parseAsyadExpress(body, NUMBER)!;
    expect(result.events).toHaveLength(2);
    expect(result.events![0]!.provider_code).toBe('S400');
    expect(result.events![1]!.local_time).toBe('2026-03-10T16:30:00');
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
  });

  it('keeps a skipped foreign wall clock without shifting it to infer an instant', () => {
    const body = postal();
    body.track[0] = { ...body.track[0]!, EventDate: '3/29/2026 2:30:00 AM', city: 'DEFRAA' };
    const event = parseOmanPost(body, POSTAL).events![1]!;
    expect(event).toMatchObject({ local_time: '2026-03-29T02:30:00', location: 'DEFRAA' });
    expect(event.time).toBeUndefined();
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({}, status));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps HTML block pages and absent endpoints distinct from missing parcels', async () => {
    for (const [html, status, kind] of [['<title>Request Rejected</title>', 200, 'challenge'], ['<html>Missing page</html>', 404, 'transport']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('shares cancellation across both reads and rejects unsupported numbers before requesting', async () => {
    const control = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { control.abort(); return reply(missing(), 404); });
    await expect(new AsyadExpressTracker({ fetcher }).fetch(NUMBER, { signal: control.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const raw of ['abcd', '../12', '123', 'ZZ000000015OM', '1'.repeat(65)]) expect(() => asyadNumber(raw)).toThrow();
    expect(asyadNumber('zz000000014om')).toBe(POSTAL);
  });
});
