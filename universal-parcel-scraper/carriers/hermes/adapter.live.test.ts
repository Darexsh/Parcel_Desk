import { describe, expect, it } from 'vitest';
import { HermesTracker } from './adapter.js';

describe('Hermes live anonymous tracking', () => {
  it('still returns the corpus\'s delivered order', async () => {
    await expect(new HermesTracker().fetch('62162057330000611')).resolves.toMatchObject({
      status: 'delivered',
      last_status_text: expect.stringMatching(/zugestellt|geliefert/i),
    });
  });

  it('maps the official empty-order response for a wrong number to a clean 404', async () => {
    await expect(new HermesTracker().fetch('12345678')).rejects.toMatchObject({
      name: 'NotFoundError',
      status: 404,
      message: 'Hermes could not locate the shipment',
    });
  });
});
