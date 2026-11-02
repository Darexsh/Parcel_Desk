import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Correo Argentino live retrieval', () => {
  // An item numbered in Argentina goes to the national form, one from abroad to the international form.
  for (const name of ['CORREO_ARGENTINO_TRACKING_NUMBER', 'CORREO_ARGENTINO_INBOUND_NUMBER']) {
    it.skipIf(!process.env[name])(`retrieves the history of ${name} with providers disabled`, async () => {
      const number = process.env[name]!;
      const answer = await createTracker({ providers: [] }).track({ number, carrier: 'correo-argentino' });
      expect(answer).toMatchObject({ carrier: 'correo-argentino', source: 'correo-argentino',
        attempts: [{ source: 'correo-argentino', kind: 'ok' }] });
      expect(answer.result.events.length).toBeGreaterThan(0);
      expect(answer.result.events.every(event => (event.time ?? event.local_time) && event.description)).toBe(true);
      await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
    });
  }

  it.skipIf(!process.env.CORREO_ARGENTINO_UNKNOWN_NUMBER)('reads a number the tracker has no history for as not found', async () => {
    await expect(direct().track({ number: process.env.CORREO_ARGENTINO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CORREO_ARGENTINO_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
