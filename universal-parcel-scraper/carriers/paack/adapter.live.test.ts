import { describe, expect, it } from 'vitest';
import { PaackTracker } from './adapter.js';
import { trackPaackThroughEvri } from './evri.js';

const number = (process.env.PAACK_TRACKING_NUMBER ?? '').trim();
const postcode = (process.env.PAACK_POSTCODE ?? '').trim();
const evriNumber = (process.env.PAACK_EVRI_TRACKING_NUMBER ?? '').trim();

describe('Paack live anonymous tracking', () => {
  it.each([
    ['EXCHANGE000001D', '08006'],
    ['EXCHANGE000001R', '08021'],
  ])('maps the retired official example %s to the clean redirect result', async (number, postcode) => {
    // Published in Paack's official API examples:
    // https://www.postman.com/paacklogistics/paack-apis/folder/1uuw6iw/orders-api
    await expect(new PaackTracker().fetch(number, postcode)).rejects.toMatchObject({
      name: 'NotFoundError',
      kind: 'not_found',
      provider: 'Paack',
      message: 'Paack could not locate the shipment',
      status: 404,
    });
  });

  it.runIf(Boolean(number && postcode))('tracks a caller-supplied parcel with every step mapped', async () => {
    const result = await new PaackTracker().fetch(number, postcode);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.status).not.toBe('unknown');
    expect(result.events?.map((event) => event.description)).not.toContain('Shipment update');
    expect(JSON.stringify(result)).not.toContain(postcode);
  });

  it.runIf(Boolean(number && postcode))('answers the same number with another postcode as not found', async () => {
    const other = postcode === '75001' ? '75002' : '75001';
    await expect(new PaackTracker().fetch(number, other)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('answers an unissued number on parcels from Evri International as not found', async () => {
    await expect(trackPaackThroughEvri('PK415000000000000000', { budgetMs: 15_000 }))
      .rejects.toMatchObject({ kind: 'not_found', provider: 'Evri International' });
  });

  it.runIf(Boolean(evriNumber))('tracks a caller-supplied number through Evri International without a postcode', async () => {
    const result = await trackPaackThroughEvri(evriNumber, { budgetMs: 15_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => event.local_time && event.description && !event.time)).toBe(true);
    expect(result.status).not.toBe('unknown');
  });
});
