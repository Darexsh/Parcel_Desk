import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JntCargoTracker } from './adapter.js';
import { JNT_CARGO_ENDPOINT, JNT_CARGO_MAX_BYTES } from './parser.js';

const MASTER = '200000000001';
const PIECE = '200000000001002';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('J&T Cargo anonymous transport', () => {
  it('uses one guest history request with the host transport and agent and records its direct step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('master.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JntCargoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(MASTER, { budgetMs: 3000 }))
      .resolves.toMatchObject({ status: 'in_transit', service_name: 'MassTrack' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe(JNT_CARGO_ENDPOINT);
    const init = fetcher.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init.body))).toEqual({ waybillNo: MASTER, langType: 'EN', searchWaybillOrCustomerOrderId: '1' });
    expect(Object.keys(init.headers!)).toHaveLength(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'j-and-t-cargo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledOnce();
  });

  it('submits a whole piece without querying or substituting its master', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('piece.json')));
    await expect(carrier(fetcher).track({ number: PIECE })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).waybillNo).toBe(PIECE);
  });

  it('confirms matching histories with local clocks and leaves generic unknown replies inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('master.json')))
      .mockResolvedValueOnce(new Response(fixture('piece.json'))).mockResolvedValueOnce(new Response(fixture('unknown.json')));
    const direct = carrier(fetcher);
    await expect(direct.recognize!(MASTER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-02T12:30:00' });
    await expect(direct.recognize!(PIECE)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-03T15:45:00' });
    await expect(direct.recognize!(MASTER)).rejects.toMatchObject({ kind: 'indeterminate' });
    for (const number of ['20000000001', '570000000001', PIECE + '0']) await expect(direct.recognize!(number)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [503, 'maintenance'], [500, 'indeterminate']] as const)(
    'preserves HTTP %s as %s without raw response/request diagnostics', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`Example Recipient private ${MASTER}`, {
        status, headers: { 'Content-Type': 'text/plain', 'Retry-After': '7' },
      }));
      let error: unknown;
      try { await carrier(fetcher).track({ number: MASTER }); } catch (value) { error = value; }
      expect(error).toMatchObject({ kind, status, retryAfterMs: 7000 });
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(MASTER);
      expect(serialized).not.toContain('Example Recipient');
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('request');
      expect(error).not.toHaveProperty('diagnostics');
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('keeps network failures redacted and does not replay schema or blocked HTML responses', async () => {
    const broken = vi.fn<typeof fetch>().mockRejectedValue(new Error('private recipient or request data'));
    await expect(carrier(broken).track({ number: MASTER })).rejects.toMatchObject({ kind: 'transport' });
    for (const [body, kind] of [['<html><title>Just a moment...</title></html>', 'challenge'], ['{', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).track({ number: MASTER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('rejects invalid inputs, pre-aborted calls and spent budgets without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '20000000001' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).track({ number: MASTER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: MASTER }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(carrier(fetcher).track({ number: MASTER }, { budgetMs: NaN })).rejects.toThrow('budget must be finite');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops a pending request within the caller budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: MASTER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('cancels an in-progress body read with the caller reason', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(stream) { init?.signal?.addEventListener('abort', () => stream.error(init.signal!.reason), { once: true }); },
    })));
    const pending = carrier(fetcher).track({ number: MASTER }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort(new Error('cancelled during body'));
    await expect(pending).rejects.toThrow('cancelled during body');
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('bounds successful response bytes and cancels the oversized body', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new Uint8Array(JNT_CARGO_MAX_BYTES + 1)); }, cancel,
    })));
    await expect(carrier(fetcher).track({ number: MASTER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
