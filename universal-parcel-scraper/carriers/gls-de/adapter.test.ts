import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import type { JsonObject } from '../../core/types.js';
import { GLSGermanyTracker } from './adapter.js';

const NUMBER = '12345678901';

const capabilities = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function parcel(tuNo = NUMBER): JsonObject {
  const base = JSON.parse(
    readFileSync(new URL('./fixtures/parcel-delivered.json', import.meta.url), 'utf8'),
  ) as JsonObject;
  return { ...base, tuNo };
}

afterEach(() => vi.restoreAllMocks());

describe('GLS Germany', () => {
  it('does not stringify a structured owner code into the detail request', async () => {
    const overview = { ...parcel(), owners: [{ type: 'REQUEST', code: ['DE01'] }] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tuStatus: [overview] }))
      .mockResolvedValueOnce(Response.json(parcel()));
    await new GLSGermanyTracker({ fetcher }).fetch(NUMBER, '00000');
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.has('tuOwnerCode')).toBe(false);
  });

  it('resolves the Track ID then uses the five-digit postcode and verifies the detail identity', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel()] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(parcel())));
    const result = await new GLSGermanyTracker().fetch('AB12CD34', '01067');
    expect(result).toMatchObject({ status: 'delivered', timezone: 'Europe/Berlin', expected_delivery: null, canonical_tracking_number: NUMBER });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'in_transit']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const detail = new URL(String(fetcher.mock.calls[1]![0]));
    expect(detail.pathname).toContain(`/rstt028/${NUMBER}`);
    expect(detail.searchParams.get('postalCode')).toBe('01067');
    expect(detail.searchParams.get('tuOwnerCode')).toBe('DE01');
  });

  it('covers every capability declared in carrier.json', async () => {
    expect(capabilities).toEqual([
      'history', 'location', 'eta', 'pickup_point', 'weight', 'delivered_at', 'provider_code',
    ]);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel()] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(parcel())));
    const result = await new GLSGermanyTracker().fetch(NUMBER, '10115');
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.delivered_at).toBe('2026-09-08T09:00:00+02:00');
    // The remaining declared capabilities (eta, pickup_point, weight,
    // provider_code) come from the shared parser and are covered by the
    // fixture-driven capability test in ../gls-ch/adapter.test.ts.
  });

  it('retains the Swiss delivery owner from the overview when detail omits it', async () => {
    const overview = parcel();
    (overview.owners as JsonObject[]).push({ type: 'DELIVERY', code: 'CH01' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [overview] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(parcel())));
    await expect(new GLSGermanyTracker().fetch(NUMBER, '8000')).resolves.toMatchObject({
      delivery_carrier: 'swiss-post', delivery_tracking_number: NUMBER,
    });
  });

  it('rejects a different detail shipment', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel()] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(parcel('99999999999'))));
    await expect(new GLSGermanyTracker().fetch(NUMBER, '10115')).rejects.toThrow('different shipment');
  });

  it('rejects a different overview before sending the postcode', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel('99999999999')] })));
    await expect(new GLSGermanyTracker().fetch(NUMBER, '10115')).rejects.toThrow('different shipment');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([['1012 ab', '1012 AB'], ['SW1A  1AA', 'SW1A 1AA'], ['00-001', '00-001'], [' 8000 ', '8000'],
    ['CH-8000', '8000'], ['fl-9490', '9490'], ['LI 9490', '9490'], ['CH8000', '8000']])(
    'sends the postcode of another country GLS delivers in: %s',
    async (typed, sent) => {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ tuStatus: [parcel()] }))
        .mockResolvedValueOnce(Response.json(parcel()));
      await new GLSGermanyTracker({ fetcher }).fetch(NUMBER, typed);
      expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('postalCode')).toBe(sent);
    },
  );

  it.each(['', '12', 'ABCDE', '1'.repeat(13), '75001/2'])('rejects invalid postcode %s before the network request', async (postcode) => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(new GLSGermanyTracker().fetch(NUMBER, postcode)).rejects.toThrow('requires the recipient postcode');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('resolves a printed 12-digit number to its matching 11-digit parcel and preserves the Swiss postcode', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel('99999999999'), parcel()] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(parcel())));
    const result = await new GLSGermanyTracker().fetch(`${NUMBER}8`, ' 8000 ');
    expect(result.events).toHaveLength(2);
    const detail = new URL(String(fetcher.mock.calls[1]![0]));
    expect(detail.pathname).toContain(`/rstt028/${NUMBER}`);
    expect(detail.searchParams.get('postalCode')).toBe('8000');
  });

  it('does not accept a different 11-digit parcel for a printed number', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel('99999999999')] })));
    await expect(new GLSGermanyTracker().fetch(`${NUMBER}8`, '8000')).rejects.toThrow('different shipment');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('verifies numeric GLS recognition against the official overview', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel()] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel('99999999999')] })));
    const tracker = new GLSGermanyTracker();
    await expect(tracker.recognizes(`${NUMBER}8`)).resolves.toBe(true);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/DE/en/rstt029');
    await expect(tracker.recognizes(NUMBER)).resolves.toBe(false);
    await expect(tracker.recognizes(NUMBER)).rejects.toThrow('different shipment');
  });

  it('keeps the positional timeout the carrier-detection route passes', async () => {
    const tracker = new GLSGermanyTracker(5_000);
    expect(tracker.timeoutMs).toBe(5_000);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ tuStatus: [parcel()] })));
    await expect(tracker.recognizes(NUMBER)).resolves.toBe(true);
  });

  it('recognizes the official expired-number response', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ lastError: 'E000' }), { status: 404 }));
    await expect(new GLSGermanyTracker().fetch(NUMBER, '10115')).rejects.toMatchObject({ name: 'GLSGermanyTrackingError', status: 404 });
    // An answer is never sent again.
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['E609', 'E800'])('asks for the postcode again when GLS does not match it (%s), as GLS Switzerland does', async (lastError) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tuStatus: [parcel()] }))
      .mockResolvedValueOnce(Response.json({ lastError }, { status: 404 }));
    await expect(new GLSGermanyTracker({ fetcher }).fetch(NUMBER, '8001'))
      .rejects.toMatchObject({ kind: 'input_required', field: 'postcode', reason: 'postcode_mismatch', provider: 'GLS Germany' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another GLS code', JSON.stringify({ lastError: 'E206' })],
    ['no GLS code', JSON.stringify({ message: 'Not Found' })],
    ['a page instead of GLS\'s reply', '<html><body>Not Found</body></html>'],
  ])('keeps a detail 404 with %s inconclusive', async (_case, body) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tuStatus: [parcel()] }))
      .mockResolvedValueOnce(new Response(body, { status: 404 }));
    await expect(new GLSGermanyTracker({ fetcher }).fetch(NUMBER, '8001')).rejects.toMatchObject({ kind: 'indeterminate', status: 404 });
  });

  it('reads the overview\'s 404 for a number GLS does not know as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ lastError: 'E206' }, { status: 404 }));
    const tracker = new GLSGermanyTracker({ fetcher });
    await expect(tracker.fetch(NUMBER, '8001')).rejects.toMatchObject({ name: 'GLSGermanyTrackingError', status: 404 });
    await expect(tracker.recognizes(NUMBER)).resolves.toBe(false);
  });

  it('keeps an overview 404 other than an expired or unknown parcel inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ lastError: 'E609' }, { status: 404 }));
    await expect(new GLSGermanyTracker({ fetcher }).fetch(NUMBER, '8001')).rejects.toMatchObject({ kind: 'indeterminate', status: 404 });
  });

  it('sends a request that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([
      { afterMs: Infinity },
      { afterMs: 300, reply: () => Response.json({ tuStatus: [parcel()] }) },
      { afterMs: 200, reply: () => Response.json(parcel()) },
    ]);
    const lookup = new GLSGermanyTracker({ fetcher }).fetch(NUMBER, '10115');
    await vi.advanceTimersByTimeAsync(15_500);
    await expect(lookup).resolves.toMatchObject({ status: 'delivered' });
    // Half of the 30-second default budget, then the retry and the detail request within the rest.
    expect(ended).toEqual([15_000, 15_300, 15_500]);
  });

  it.each([403, 429, 503])('keeps HTTP %i visible as an upstream error', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
    await expect(new GLSGermanyTracker().fetch(NUMBER, '10115')).rejects.toMatchObject({ name: 'UpstreamHttpError', status });
  });
});
