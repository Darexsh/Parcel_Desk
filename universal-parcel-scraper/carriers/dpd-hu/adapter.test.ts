import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter as dpdBe } from '../dpd-be/adapter.js';
import { adapter as dpdNl } from '../dpd-nl/adapter.js';
import { adapter } from './adapter.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic: a 14-digit number of DPD's shape that was never issued.
const NUMBER = '16400000000001';
type Reply = Record<string, unknown> & { status: Record<string, unknown>; parcelHistory: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Reply;
const CAPABILITIES = (JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { capabilities: string[] }).capabilities;

/** The guest login a cold tracker goes through, then DPD's replies. */
function guest(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ fid: 'synthetic-fid', authToken: { token: 'synthetic-installation', expiresIn: '604800s' } }))
    .mockResolvedValueOnce(Response.json({ entries: { basic_dpd_token: 'c3ludGhldGljOnRva2Vu' } })) // gitleaks:allow
    .mockResolvedValueOnce(Response.json({ access_token: 'synthetic-access', expires_in: 3600 }));
  for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
  return fetcher;
}
const dpdHu = (fetcher: typeof fetch) => adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
const placed = (countryCode: string | undefined, reply = fixture('delivered.json')) => Response.json({ ...reply, status: { ...reply.status, countryCode } });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';

describe('DPD Hungary guest tracking', () => {
  it('reads a delivered parcel from the Hungarian unit, without a postcode, and omits recipient data', async () => {
    const reply = fixture('delivered.json');
    reply.receiver = { name: 'Private Recipient', address: { streetName: 'Private Street', zipCode: '0000' } };
    const fetcher = guest(Response.json(reply));
    const result = await dpdHu(fetcher).track({ number: NUMBER, postcode: '0000' });

    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', expected_delivery: null,
      delivered_at: '2026-01-07T10:47:12+01:00', source: 'mydpd_guest_api', history_truncated: true,
      tracking_url: `https://www.dpdgroup.com/hu/mydpd/my-parcels/search?parcelNumber=${NUMBER}`,
    });
    expect(result.events?.map(event => event.provider_code)).toEqual([
      'DELIVERED', 'AVAILABLE_FOR_COLLECTION', 'AT_DELIVERY_CENTER', 'IN_TRANSIT', 'PARCEL_HANDED',
    ]);
    expect(result.events?.at(-1)).toMatchObject({ time: '2026-01-05T16:02:11+01:00', description: 'Parcel handed to DPD', location: '' });
    // A collected parcel names no point to collect it from.
    expect(result.pickup_point).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Private|B2C1640/);

    const remoteConfig = JSON.parse(String(fetcher.mock.calls[1]![1]!.body)) as Record<string, unknown>;
    expect(remoteConfig.countryCode).toBe('HU');
    const url = new URL(String(fetcher.mock.calls[3]![0]));
    expect(url.pathname).toBe(`/concept/webservice/v10/parcels/details/${NUMBER}`);
    expect(url.searchParams.get('businessUnit')).toBe('DPD-HU');
    expect(url.searchParams.get('continueWithoutVerification')).toBe('true');
    expect(url.searchParams.has('dataForVerification')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('reads a parcel out for delivery with its delivery day', async () => {
    const result = await dpdHu(guest(Response.json(fixture('out-for-delivery.json')))).track({ number: NUMBER });
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Parcel out for delivery',
      last_update: '2026-07-16T09:12:51+02:00', expected_delivery: '2026-07-16',
    });
    expect(result.events).toHaveLength(3);
  });

  it('lists the milestones newest first whatever order DPD gives them in', async () => {
    const result = await dpdHu(guest(Response.json(fixture('rerouted.json')))).track({ number: NUMBER });
    expect(result.events?.map(event => event.provider_code)).toEqual([
      'PARCEL_HANDED', 'AVAILABLE_FOR_COLLECTION', 'AT_DELIVERY_CENTER', 'IN_TRANSIT',
    ]);
    // Handed over again after it reached the pickup point, the parcel is moving, not newly accepted.
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-07-24T14:09:37+02:00' });
  });

  it('returns every declared capability across the fixtures', async () => {
    const produced = new Set<string>();
    const replies = ['delivered.json', 'out-for-delivery.json', 'rerouted.json'].map(name => Response.json(fixture(name)));
    for (const reply of [...replies, placed('CH')]) {
      const result = await dpdHu(guest(reply)).track({ number: NUMBER });
      if (result.events?.length) produced.add('history');
      if (result.expected_delivery) produced.add('eta');
      if (result.delivered_at) produced.add('delivered_at');
      if (result.events?.some(event => event.provider_code)) produced.add('provider_code');
      if (result.delivery_carrier) produced.add('delivery_partner');
    }
    expect([...produced].sort()).toEqual([...CAPABILITIES].sort());
  });

  it('reads a clock DPD names no zone for in Hungarian time', async () => {
    // Hungary kept summer time in 1957 and Switzerland, Belgium and the Netherlands did not:
    // only Hungarian time reads this clock at +02:00.
    const reply = fixture('out-for-delivery.json');
    reply.parcelHistory = [{ ...reply.parcelHistory[0], eventDateAndTime: '1957-07-02T12:00:00', eventDateAndTimeZoneId: null }];
    const result = await dpdHu(guest(Response.json(reply))).track({ number: NUMBER });
    expect(result.events?.[0]?.time).toBe('1957-07-02T12:00:00+02:00');
  });

  it.each(['BE', 'NL'])("tracks a parcel DPD places in %s, which only recognition holds against it", async (countryCode) => {
    const result = await dpdHu(guest(placed(countryCode))).track({ number: NUMBER });
    expect(result).toMatchObject({ status: 'delivered' });
    expect(result.delivery_carrier).toBeUndefined();
  });

  it.each([['DPD Belgium', dpdBe], ['DPD Netherlands', dpdNl]])(
    '%s names no delivery carrier for a parcel DPD places in Hungary: DPD Hungary reads the same guest reply',
    async (_unit, unit) => {
      const result = await unit({ fetcher: guest(placed('HU')), trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER })
        .track({ number: NUMBER });
      expect(result).toMatchObject({ status: 'delivered' });
      expect(result.delivery_carrier).toBeUndefined();
    },
  );

  it.each([
    ['Switzerland', 'CH', 'dpd'], ['Germany', 'DE', 'dpd-de'], ['Austria', 'AT', 'dpd-at'], ['Great Britain', 'GB', 'dpd-uk'],
    ['Ireland', 'IE', 'dpd-ie'], ['Poland', 'PL', 'dpd-pl'], ['Portugal', 'PT', 'dpd-pt'], ['France', 'FR', 'dpd-fr'],
  ])('hands a parcel DPD places in %s at its delivery depot or later to that unit under the same number', async (_country, countryCode, carrier) => {
    const result = await dpdHu(guest(placed(countryCode))).track({ number: NUMBER });
    expect(result).toMatchObject({ status: 'delivered', delivery_carrier: carrier });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(deliveryHandoff('dpd-hu', NUMBER, result)).toEqual({ carrier, number: NUMBER, basis: 'partner' });
    // A label's check character stays on the number the parcel is filed under.
    expect(deliveryHandoff('dpd-hu', `${NUMBER}X`, result)).toEqual({ carrier, number: `${NUMBER}X`, basis: 'partner' });
    const reply = fixture('out-for-delivery.json');
    reply.status = { ...reply.status, description: 'AT_DELIVERY_CENTER', countryCode };
    await expect(dpdHu(guest(Response.json(reply))).track({ number: NUMBER })).resolves.toMatchObject({ delivery_carrier: carrier });
  });

  it.each(['ORDER_CREATED', 'PARCEL_HANDED', 'IN_TRANSIT', 'RETURN_TO_SENDER'])(
    "names no delivery carrier for a parcel DPD places in Switzerland or Germany at %s, which can be its sender's country",
    async (description) => {
      for (const countryCode of ['CH', 'DE']) {
        const reply = fixture('out-for-delivery.json');
        reply.status = { ...reply.status, description, countryCode };
        const result = await dpdHu(guest(Response.json(reply))).track({ number: NUMBER });
        expect(result.delivery_carrier).toBeUndefined();
      }
    },
  );

  it.each([
    { name: 'a 400 typed PARCEL_NOT_FOUND', reply: () => Response.json({ error: 'ParcelException', exceptionType: 'PARCEL_NOT_FOUND' }, { status: 400 }) },
    { name: 'a details 404', reply: () => new Response('', { status: 404 }) },
  ])('reads $name as not found', async ({ reply }) => {
    await expect(dpdHu(guest(reply())).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('leaves another refusal inconclusive', async () => {
    const reply = Response.json({ error: 'ParcelContextualCheckException', exceptionType: 'NO_PARCEL_FOUD' }, { status: 400 });
    await expect(dpdHu(guest(reply)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([
    { name: 'with HTTP 403', reply: () => new Response(CHALLENGE, { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }) },
    { name: 'with HTTP 200', reply: () => new Response(CHALLENGE, { status: 200, headers: { 'content-type': 'text/html' } }) },
  ])("reports Cloudflare's challenge page $name as a challenge", async ({ reply }) => {
    const fetcher = guest(reply());
    await expect(dpdHu(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    // No page tier follows the guest API.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('reports a rate limit with the wait DPD asks for', async () => {
    const reply = new Response('', { status: 429, headers: { 'retry-after': '30' } });
    await expect(dpdHu(guest(reply)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it.each([
    { name: 'another parcel', payload: { ...fixture('delivered.json'), parcelNumber: '16400000000002', shipmentId: '16400000000002' }, kind: 'schema' },
    { name: 'identity alone', payload: { parcelNumber: NUMBER }, kind: 'schema' },
    { name: 'empty history', payload: { ...fixture('delivered.json'), parcelHistory: [] }, kind: 'indeterminate' },
    { name: 'history object', payload: { ...fixture('delivered.json'), parcelHistory: {} }, kind: 'schema' },
    { name: 'undated history row', payload: { ...fixture('delivered.json'), parcelHistory: [{ description: 'PARCEL_HANDED' }] }, kind: 'schema' },
  ])('rejects $name rather than manufacturing tracking success', async ({ payload, kind }) => {
    await expect(dpdHu(guest(Response.json(payload))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });

  it('leaves a reply that is not JSON inconclusive', async () => {
    await expect(dpdHu(guest(new Response('{"parcelNumber":', { status: 200 }))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('refuses a number DPD does not issue before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1640000000000', '16400000000001Z']) {
      await expect(dpdHu(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never enters the Swiss page when the guest login fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 }));
    await expect(dpdHu(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('DPD Hungary recognition', () => {
  const recognize = (fetcher: typeof fetch) => dpdHu(fetcher).recognize!(NUMBER);

  it('knows a parcel the guest API places in Hungary', async () => {
    const fetcher = guest(placed('HU'));
    await expect(recognize(fetcher)).resolves.toEqual({ known: true });
    expect(new URL(String(fetcher.mock.calls[3]![0])).searchParams.get('businessUnit')).toBe('DPD-HU');
  });

  it.each(['CH', 'DE', 'BE', 'NL', 'AT'])('does not take %s activity for DPD Hungary', async (countryCode) => {
    await expect(recognize(guest(placed(countryCode)))).resolves.toEqual({ known: false });
  });

  it('leaves a reply without a country inconclusive and does not know a missing parcel', async () => {
    await expect(recognize(guest(placed(undefined)))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(recognize(guest(new Response('', { status: 404 })))).resolves.toEqual({ known: false });
  });

  it('fails on a rate limit rather than answering unknown', async () => {
    await expect(recognize(guest(new Response('', { status: 429 })))).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});

describe('DPD Hungary status map', () => {
  it("answers DPD's guest codes and leaves the Swiss page's labels out", () => {
    const answer = (providerCode: string | null, description: string) => statusMapAnswer({ carrier: 'dpd-hu', providerCode, description });
    expect(answer('AVAILABLE_FOR_COLLECTION', 'Ready for collection')).toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(answer('DELIVERED', 'Delivered')).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(answer('PARCEL_HANDED', 'Parcel handed to DPD')).toMatchObject({ kind: 'intentional_gap' });
    expect(answer(null, 'Your parcel is on its way')).toEqual({ kind: 'unknown' });
  });

  it('stages every recorded status as statuses.json says', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
    }
  });
});
