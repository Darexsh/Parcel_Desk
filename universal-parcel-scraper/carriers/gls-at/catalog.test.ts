import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierAdapter } from '../../core/catalog/index.js';
import { createTracker } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';

// A parcel number with its printed check digit, its eleven digits, and a Track ID.
const PRINTED = '100000000037';
const DELIVERED = '10000000003';
const TRACK_ID = 'Z0SYNTH1';
const IN_TRANSIT = '10000000004';
const SERVICE = '/app/service/open/rest/GROUP/en';

const reply = (name: string) => new Response(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const replies = (...answers: Array<string | Response>) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const answer of answers) fetcher.mockResolvedValueOnce(typeof answer === 'string' ? reply(answer) : answer);
  return fetcher;
};
const track = (fetcher: typeof fetch, number: string, postcode?: string) =>
  createTracker({ providers: [], fetcher }).track({ number, carrier: 'gls-at', ...(postcode ? { postcode } : {}) });
const requested = (fetcher: ReturnType<typeof replies>) => fetcher.mock.calls.map(([url]) => new URL(String(url)));

describe('GLS Austria', () => {
  it('tracks through the GLS Germany adapter', () => {
    expect(carrierAdapter('gls-at')).toBe('gls-de');
    expect(REGISTRY.carriers['gls-at']).toBe('gls-de');
  });

  it('reads a parcel from another GLS network delivered in Austria, asked with its check digit', async () => {
    const fetcher = replies('overview-delivered.json', 'detail-delivered.json');
    const answer = await track(fetcher, PRINTED, '9999');
    expect(answer).toMatchObject({ carrier: 'gls-at', source: 'gls-at', result: {
      status: 'delivered', current_stage: 'delivered', canonical_tracking_number: DELIVERED,
      delivered_at: '2026-09-16T11:05:12+02:00', weight_kg: 1.2, expected_delivery: null,
    } });
    expect(answer.result.events.map((event) => [event.stage, event.location, event.time])).toEqual([
      ['delivered', 'Austria Hagenbrunn', '2026-09-16T11:05:12+02:00'],
      ['out_for_delivery', 'Austria Hagenbrunn', '2026-09-16T06:48:30+02:00'],
      ['in_transit', 'Austria Hagenbrunn', '2026-09-16T04:12:09+02:00'],
      ['in_transit', 'Germany Neuenstein', '2026-09-15T19:40:55+02:00'],
      ['accepted', 'Germany Neuenstein', '2026-09-15T15:22:01+02:00'],
      ['registered', 'Germany Neuenstein', '2026-09-14T18:03:47+02:00'],
    ]);
    expect(JSON.stringify(answer.result)).not.toMatch(/Private|private|9999|EuroBusinessParcel/);
    const [overview, detail] = requested(fetcher);
    expect(`${overview!.pathname}?${overview!.searchParams.get('match')}`).toBe(`${SERVICE}/rstt029?${PRINTED}`);
    expect(overview!.searchParams.has('postalCode')).toBe(false);
    expect(detail!.pathname).toBe(`${SERVICE}/rstt028/${DELIVERED}`);
    expect(detail!.searchParams.get('postalCode')).toBe('9999');
    expect(detail!.searchParams.has('tuOwnerCode')).toBe(false);
  });

  it('reads an in-transit history found by its Track ID, on winter clocks', async () => {
    const fetcher = replies('overview-in-transit.json', 'detail-in-transit.json');
    const answer = await track(fetcher, TRACK_ID, '9999');
    expect(answer.result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', canonical_tracking_number: IN_TRANSIT,
      last_status_text: 'The parcel has left the parcel center.', weight_kg: 0.8,
    });
    expect(answer.result.events.map((event) => [event.stage, event.time])).toEqual([
      ['in_transit', '2026-11-03T21:14:38+01:00'],
      ['accepted', '2026-11-03T16:02:11+01:00'],
      ['registered', '2026-11-02T20:30:00+01:00'],
    ]);
    expect(requested(fetcher)[1]!.pathname).toBe(`${SERVICE}/rstt028/${IN_TRANSIT}`);
  });

  it('asks GLS nothing without the postcode, leaving the parcel to other sources', async () => {
    const fetcher = replies();
    await expect(track(fetcher, DELIVERED)).rejects.toMatchObject({ attempts: [{ source: 'gls-at', kind: 'input_required' }] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['E000', 'E206'])('reads GLS\'s %s for the number as not found before the postcode is sent', async (code) => {
    const fetcher = replies(Response.json({ lastError: code, exceptionText: 'Unfortunately there are no results.' }, { status: 404 }));
    await expect(track(fetcher, DELIVERED, '9999')).rejects.toMatchObject({ attempts: [{ source: 'gls-at', kind: 'not_found' }] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requested(fetcher)[0]!.searchParams.has('postalCode')).toBe(false);
  });

  it('asks for the postcode again when it does not match the parcel', async () => {
    const fetcher = replies('overview-delivered.json', Response.json({ lastError: 'E800' }, { status: 404 }));
    await expect(track(fetcher, DELIVERED, '9999')).rejects.toMatchObject({ attempts: [{ source: 'gls-at', kind: 'input_required' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects another parcel before the postcode is sent', async () => {
    const fetcher = replies('overview-in-transit.json');
    await expect(track(fetcher, DELIVERED, '9999')).rejects.toMatchObject({ attempts: [{ source: 'gls-at', kind: 'schema' }] });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects a number GLS does not issue without a request', async () => {
    const fetcher = replies();
    await expect(track(fetcher, '1000000001', '9999')).rejects.toMatchObject({ attempts: [{ source: 'gls-at', kind: 'invalid_input' }] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a challenge page', () => new Response('<html><title>Access denied</title></html>', { status: 403 }), 'challenge'],
    ['a rate limit', () => new Response('', { status: 429 }), 'rate_limited'],
  ])('keeps %s apart from a missing parcel', async (_case, answer, kind) => {
    await expect(track(replies(answer()), DELIVERED, '9999')).rejects.toMatchObject({ attempts: [{ source: 'gls-at', kind }] });
  });

  it.each([
    ['an HTML page with HTTP 200', '<html><body>Please enable JavaScript</body></html>'],
    ['a reply without a parcel', '{"tuStatus":[{"progressBar":{}}]}'],
  ])('never reads %s as not found', async (_case, body) => {
    const failure = await track(replies(new Response(body)), DELIVERED, '9999').catch((error: unknown) => error);
    expect(failure).toMatchObject({ attempts: [{ source: 'gls-at' }] });
    expect((failure as { attempts: Array<{ kind: string }> }).attempts[0]!.kind).not.toBe('not_found');
  });
});
