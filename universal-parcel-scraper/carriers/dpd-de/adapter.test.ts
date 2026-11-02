import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TrackingContext } from '../../core/adapter/index.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { IndeterminateError, NotFoundError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { DPDTracker } from '../dpd/adapter.js';
import type { DpdGroupLookup } from '../dpd-ie/adapter.js';
import { adapter, trackAbroad } from './adapter.js';
import { DPD_DE_APP_API } from './service.js';

const NUMBER = '01000000000001';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as Record<string, unknown>;
/** The guest tier alone; the app tier and their order are covered in app.test.ts. */
function tracking(fetcher: typeof fetch) {
  const tracker = new DPDTracker({ country: 'DE', fetcher });
  return { track: (input: { number: string; postcode?: string }, context?: TrackingContext) => tracker.fetch(input.number, input.postcode ?? '', context) };
}
function guest(reply: Response) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ fid: 'synthetic-fid', authToken: { token: 'synthetic-installation', expiresIn: '604800s' } }))
    .mockResolvedValueOnce(Response.json({ entries: { basic_dpd_token: 'c3ludGhldGljOnRva2Vu' } }))
    .mockResolvedValueOnce(Response.json({ access_token: 'synthetic-access', expires_in: 3600 }))
    .mockResolvedValueOnce(reply);
}

describe('DPD Germany guest tracking', () => {
  it('selects Germany without changing parcel identity and omits recipient data', async () => {
    const fetcher = guest(Response.json(fixture));
    const result = await tracking(fetcher).track({ number: NUMBER });
    expect(result).toMatchObject({ status: 'delivered', tracking_url: `https://tracking.dpd.de/status/en_US/parcel/${NUMBER}` });
    expect(result.events).toHaveLength(4);
    const url = new URL(String(fetcher.mock.calls[3]![0]));
    expect(url.searchParams.get('businessUnit')).toBe('DPD-DE');
    expect(url.searchParams.get('continueWithoutVerification')).toBe('true');
    expect(result).not.toHaveProperty('receiver');
    expect(result.events?.[0]?.time).toBe('2026-07-16T10:12:00+02:00');
  });

  it('names another country rather than letting a group-wide match establish Germany', async () => {
    const payload = structuredClone(fixture);
    (payload.status as Record<string, unknown>).countryCode = 'CH';
    const fetcher = guest(Response.json(payload));
    await expect(tracking(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'other_country', country: 'CH' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects a mismatched parcel identity', async () => {
    const fetcher = guest(Response.json({ ...fixture, parcelNumber: '01000000000002' }));
    await expect(tracking(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: 'identity alone', payload: { parcelNumber: NUMBER }, kind: 'schema' },
    { name: 'empty history', payload: { ...fixture, parcelHistory: [] }, kind: 'indeterminate' },
    { name: 'missing history', payload: { ...fixture, parcelHistory: undefined }, kind: 'indeterminate' },
    { name: 'history object', payload: { ...fixture, parcelHistory: {} }, kind: 'schema' },
    { name: 'invalid history row', payload: { ...fixture, parcelHistory: [null] }, kind: 'schema' },
    { name: 'undated history row', payload: { ...fixture, parcelHistory: [{ description: 'PARCEL_HANDED' }] }, kind: 'schema' },
    { name: 'unworded history row', payload: { ...fixture, parcelHistory: [{ eventDateAndTime: '2026-07-15T10:00:00' }] }, kind: 'schema' },
    { name: 'invalid event date', payload: { ...fixture, parcelHistory: [{ description: 'PARCEL_HANDED', eventDateAndTime: '2026-02-30T10:00:00' }] }, kind: 'schema' },
  ])('rejects $name rather than manufacturing tracking success', async ({ payload, kind }) => {
    const fetcher = guest(Response.json(payload));
    await expect(tracking(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('accepts five-digit postcodes and rejects Swiss-sized inputs before requesting', async () => {
    const fetcher = guest(Response.json(fixture));
    await tracking(fetcher).track({ number: NUMBER, postcode: '00000' });
    expect(new URL(String(fetcher.mock.calls[3]![0])).searchParams.get('dataForVerification')).toBe('00000');
    const unused = vi.fn<typeof fetch>();
    await expect(tracking(unused).track({ number: NUMBER, postcode: '0000' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('never enters the Swiss page when guest authentication fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 }));
    await expect(tracking(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation to the guest protocol', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      requestSignal = signal;
      signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
    const result = tracking(fetcher).track({ number: NUMBER }, { signal: controller.signal, budgetMs: 1000 });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort(new Error('Cancelled'));
    await expect(result).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('ends the guest request inside the caller budget', async () => {
    const fetcher: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), { once: true });
    });
    await expect(tracking(fetcher).track({ number: NUMBER }, { budgetMs: 15 }))
      .rejects.toMatchObject({ kind: 'budget' });
  });
});

describe('DPD Germany recognition', () => {
  const recognize = (fetcher: typeof fetch) => adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER })
    .recognize!(NUMBER);
  const placed = (countryCode?: string) => {
    const payload = structuredClone(fixture);
    (payload.status as Record<string, unknown>).countryCode = countryCode;
    return Response.json(payload);
  };

  it('knows a parcel the guest API places in Germany, without the app service', async () => {
    const fetcher = guest(placed('DE'));
    await expect(recognize(fetcher)).resolves.toEqual({ known: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.some(([url]) => String(url) === DPD_DE_APP_API)).toBe(false);
    const url = new URL(String(fetcher.mock.calls[3]![0]));
    expect(url.searchParams.get('businessUnit')).toBe('DPD-DE');
    expect(url.searchParams.get('continueWithoutVerification')).toBe('true');
  });

  it.each(['CH', 'FR'])('does not take %s activity for DPD Germany', async (countryCode) => {
    await expect(recognize(guest(placed(countryCode)))).resolves.toEqual({ known: false });
  });

  it('leaves a reply without a country inconclusive and does not know a missing parcel', async () => {
    await expect(recognize(guest(placed(undefined)))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(recognize(guest(new Response('', { status: 404 })))).resolves.toEqual({ known: false });
  });
});

describe('DPD Germany tracking links', () => {
  it('reads a parcel link with or without the label\'s check character', () => {
    const check = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(character => dpdParcelNumber(`${NUMBER}${character}`))!;
    for (const number of [NUMBER, `${NUMBER}${check}`]) {
      expect(parseTrackingInput(`https://tracking.dpd.de/status/de_DE/parcel/${number}`))
        .toMatchObject({ trackingNumber: number, carrier: 'dpd-de', confidence: 'high', source: 'link' });
    }
    expect(parseTrackingInput(`https://tracking.dpd.de/status/en_US/parcel/${NUMBER}${check}/`))
      .toMatchObject({ trackingNumber: `${NUMBER}${check}`, carrier: 'dpd-de', source: 'link' });
    expect(parseTrackingInput(`https://tracking.dpd.de/status/de_DE/parcel/${NUMBER}${check}${check}`).source).not.toBe('link');
  });
});

describe('DPD Germany abroad', () => {
  const milestones = (stage: string, ...events: [string, string][]): CarrierResult => ({ status: stage === 'delivered' ? 'delivered' : 'in_transit',
    current_stage: stage, last_status_text: events[0]![0], last_update: events[0]![1], history_truncated: true,
    events: events.map(([description, time]) => ({ description, time, location: '' })) });
  // The group service's milestones, and a unit's scans of the same parcel.
  const group = milestones('delivered', ['Delivered', '2026-03-06T11:00:00+01:00'], ['Parcel handed to DPD', '2026-03-04T11:59:00+01:00']);
  const scans = milestones('delivered', ['Delivered', '2026-03-06T11:00:00+01:00'], ['Out for delivery', '2026-03-06T07:40:00+01:00'],
    ['At the delivery depot', '2026-03-06T05:10:00+01:00'], ['Parcel handed to DPD', '2026-03-04T11:59:00+01:00']);
  const outage = async (): Promise<never> => { throw new IndeterminateError('DPD', 'Sample outage'); };
  const missing = async (): Promise<never> => { throw new NotFoundError('DPD'); };

  it('asks the country\'s unit and the group service together, and keeps the unit\'s fuller history', async () => {
    const unit = vi.fn<DpdGroupLookup>(async () => scans);
    const other = vi.fn<DpdGroupLookup>(async () => scans);
    const shared = vi.fn<DpdGroupLookup>(async () => group);
    expect((await trackAbroad(shared, { AT: unit, PL: other })(NUMBER, 'AT', { budgetMs: 10_000 })).events).toEqual(scans.events);
    expect(unit).toHaveBeenCalledWith(NUMBER, { budgetMs: 10_000 });
    expect(shared).toHaveBeenCalledWith(NUMBER, { budgetMs: 10_000 });
    expect(other).not.toHaveBeenCalled();
  });

  it('keeps the group service\'s milestones when the unit has fewer, is behind, fails or there is none', async () => {
    const behind = milestones('in_transit', ['At the hub', '2026-03-05T20:00:00+01:00'], ['In transit', '2026-03-05T08:00:00+01:00'],
      ['Parcel handed to DPD', '2026-03-04T11:59:00+01:00']);
    const shared = async () => group;
    expect(await trackAbroad(shared, { AT: async () => group })(NUMBER, 'AT', {})).toBe(group);
    expect(await trackAbroad(shared, { AT: async () => behind })(NUMBER, 'AT', {})).toBe(group);
    expect(await trackAbroad(shared, { AT: outage })(NUMBER, 'AT', {})).toBe(group);
    expect(await trackAbroad(shared, { AT: async () => scans })(NUMBER, 'CZ', {})).toBe(group);
    expect(await trackAbroad(outage, { AT: async () => scans })(NUMBER, 'AT', {})).toBe(scans);
  });

  it('stays inconclusive when neither finds the parcel the German tiers place abroad', async () => {
    await expect(trackAbroad(missing, { AT: missing })(NUMBER, 'AT', {})).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(trackAbroad(missing, {})(NUMBER, 'CZ', {})).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(trackAbroad(missing, { AT: outage })(NUMBER, 'AT', {})).rejects.toMatchObject({ message: 'Sample outage' });
  });
});

describe('DPD Germany scan identity', () => {
  const policy = sameInstantIdentityPolicy('dpd-de', { supportsScanMatching: true })!;
  const matches = policy.matches!;
  const app = { stage: 'in_transit', description: 'At parcel delivery centre.', location: 'Musterstadt, DE', providerCode: '' };
  const guest = { stage: 'in_transit', description: 'At delivery center', location: '', providerCode: 'AT_DELIVERY_CENTER' };

  it('lets a scan from one service take over the other service\'s row for it, less than a minute away', () => {
    expect(policy).toMatchObject({ storedSources: ['dpd-de'], requireProviderCode: false, matchEachScan: true, matchWithinMinute: true,
      matchWallClock: true });
    expect(matches(guest, app)).toBe(true);
    expect(matches(app, guest)).toBe(true);
    expect(matches({ ...guest, location: 'MUSTERSTADT, DE' }, app)).toBe(true);
    expect(matches(
      { stage: 'ready_for_pickup', description: 'Ready for collection', location: '', providerCode: 'AVAILABLE_FOR_COLLECTION' },
      { stage: 'ready_for_pickup', description: 'Delivered by driver to DPD Pickup parcelshop/ station.', location: 'Musterstadt, DE', providerCode: '' },
    )).toBe(true);
  });

  it("matches the guest API's hand-over with the app's first depot scan, which it stages apart", () => {
    const depot = { ...app, description: 'In transit.' };
    const handed = { stage: 'accepted', description: 'Parcel handed to DPD', location: '', providerCode: 'PARCEL_HANDED' };
    expect(matches(handed, depot)).toBe(true);
    expect(matches(depot, handed)).toBe(true);
    expect(matches({ ...handed, stage: 'in_transit' }, depot)).toBe(true);
    // Other scans keep their stage, and the hand-over its place.
    expect(matches({ ...guest, stage: 'accepted' }, depot)).toBe(false);
    expect(matches(handed, app)).toBe(false);
    expect(matches({ ...handed, location: 'Andere Stadt, DE' }, depot)).toBe(false);
  });

  it('keeps scans of one service, of other stages or of other places apart', () => {
    expect(matches(guest, { ...guest, description: 'Your parcel arrived at our depot', providerCode: 'ORI' })).toBe(false);
    expect(matches(app, { ...app, description: 'In transit.' })).toBe(false);
    expect(matches({ ...guest, stage: 'out_for_delivery' }, app)).toBe(false);
    expect(matches({ ...guest, stage: '' }, { ...app, stage: '' })).toBe(false);
    expect(matches({ ...guest, location: 'Andere Stadt, DE' }, app)).toBe(false);
  });
});
