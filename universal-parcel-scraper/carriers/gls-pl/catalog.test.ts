import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierAdapter } from '../../core/catalog/index.js';
import { createTracker } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';

const DELIVERED = '10000000001';
const IN_TRANSIT = '10000000002';
const SERVICE = '/app/service/open/rest/GROUP/en';

const reply = (name: string) => new Response(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const replies = (...answers: Array<string | Response>) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const answer of answers) fetcher.mockResolvedValueOnce(typeof answer === 'string' ? reply(answer) : answer);
  return fetcher;
};
const track = (fetcher: typeof fetch, number: string, postcode?: string) =>
  createTracker({ providers: [], fetcher }).track({ number, carrier: 'gls-pl', ...(postcode ? { postcode } : {}) });
const requested = (fetcher: ReturnType<typeof replies>) => fetcher.mock.calls.map(([url]) => new URL(String(url)));

describe('GLS Poland', () => {
  it('tracks through the GLS Germany adapter', () => {
    expect(carrierAdapter('gls-pl')).toBe('gls-de');
    expect(REGISTRY.carriers['gls-pl']).toBe('gls-de');
  });

  it('reads a delivered history with the Polish postcode as typed', async () => {
    const fetcher = replies('overview-delivered.json', 'detail-delivered.json');
    const answer = await track(fetcher, DELIVERED, '00-001');
    expect(answer).toMatchObject({ carrier: 'gls-pl', source: 'gls-pl', result: {
      status: 'delivered', current_stage: 'delivered', canonical_tracking_number: DELIVERED,
      delivered_at: '2026-09-15T10:20:00+02:00', weight_kg: 1.4, expected_delivery: null,
    } });
    expect(answer.result.events.map((event) => [event.stage, event.location, event.provider_code])).toEqual([
      ['delivered', 'Poland Gniezno', '0.100'],
      ['out_for_delivery', 'Poland Gniezno', '0.0'],
      ['in_transit', 'Poland Gniezno', '2.0'],
      ['in_transit', 'Poland Strykow', '2.0'],
      ['registered', 'Poland Strykow', '3.0'],
    ]);
    expect(JSON.stringify(answer.result)).not.toMatch(/Private|private|\+48|00-000/);
    const [overview, detail] = requested(fetcher);
    expect(`${overview!.pathname}?${overview!.searchParams.get('match')}`).toBe(`${SERVICE}/rstt029?${DELIVERED}`);
    expect(overview!.searchParams.has('postalCode')).toBe(false);
    expect(detail!.pathname).toBe(`${SERVICE}/rstt028/${DELIVERED}`);
    expect(detail!.searchParams.get('postalCode')).toBe('00-001');
  });

  it('reads an in-transit history', async () => {
    const answer = await track(replies('overview-in-transit.json', 'detail-in-transit.json'), IN_TRANSIT, '00001');
    expect(answer.result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'The parcel has left the parcel center.' });
    expect(answer.result.events.map((event) => [event.stage, event.time])).toEqual([
      ['in_transit', '2026-09-21T22:15:00+02:00'],
      ['accepted', '2026-09-21T14:40:00+02:00'],
    ]);
  });

  it('asks GLS nothing without the postcode, leaving the parcel to other sources', async () => {
    const fetcher = replies();
    await expect(track(fetcher, DELIVERED)).rejects.toMatchObject({ attempts: [{ source: 'gls-pl', kind: 'input_required' }] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads GLS\'s answer for an unknown number as not found before the postcode is sent', async () => {
    const fetcher = replies(Response.json({ lastError: 'E000', exceptionText: 'Unfortunately there are no results.' }, { status: 404 }));
    await expect(track(fetcher, DELIVERED, '00-001')).rejects.toMatchObject({ attempts: [{ source: 'gls-pl', kind: 'not_found' }] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requested(fetcher)[0]!.searchParams.has('postalCode')).toBe(false);
  });

  it('asks for the postcode again when it does not match the parcel', async () => {
    const fetcher = replies('overview-delivered.json', Response.json({ lastError: 'E609' }, { status: 404 }));
    await expect(track(fetcher, DELIVERED, '00-001')).rejects.toMatchObject({ attempts: [{ source: 'gls-pl', kind: 'input_required' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects another parcel before the postcode is sent', async () => {
    const fetcher = replies('overview-in-transit.json');
    await expect(track(fetcher, DELIVERED, '00-001')).rejects.toMatchObject({ attempts: [{ source: 'gls-pl', kind: 'schema' }] });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects a number GLS does not issue without a request', async () => {
    const fetcher = replies();
    await expect(track(fetcher, '1000000001', '00-001')).rejects.toMatchObject({ attempts: [{ source: 'gls-pl', kind: 'invalid_input' }] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a challenge page', () => new Response('<html><title>Access denied</title></html>', { status: 403 }), 'challenge'],
    ['a rate limit', () => new Response('', { status: 429 }), 'rate_limited'],
  ])('keeps %s apart from a missing parcel', async (_case, answer, kind) => {
    await expect(track(replies(answer()), DELIVERED, '00-001')).rejects.toMatchObject({ attempts: [{ source: 'gls-pl', kind }] });
  });

  it.each([
    ['an HTML page with HTTP 200', '<html><body>Please enable JavaScript</body></html>'],
    ['a reply without a parcel', '{"tuStatus":[{"progressBar":{}}]}'],
  ])('never reads %s as not found', async (_case, body) => {
    const failure = await track(replies(new Response(body)), DELIVERED, '00-001').catch((error: unknown) => error);
    expect(failure).toMatchObject({ attempts: [{ source: 'gls-pl' }] });
    expect((failure as { attempts: Array<{ kind: string }> }).attempts[0]!.kind).not.toBe('not_found');
  });
});
