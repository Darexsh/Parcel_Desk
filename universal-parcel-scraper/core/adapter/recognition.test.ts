import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InputRequiredError, InvalidInputError, NotFoundError, UpstreamHttpError } from '../errors/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { NOOP_RECORDER } from '../telemetry/index.js';
import { AdapterRegistry, accepted, recognizeFromBrowserLookup, recognizeFromLookup } from './index.js';

const carriersDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'carriers');

describe('recognition from a plain lookup', () => {
  it.each([['2026-09-09T08:00:00', '2026-09-09T08:00:00'], ['2026-09-09', '2026-09-09T00:00:00'], ['2026-02-30T08:00:00Z'], ['broken'],
    ['2026-09-09T08:00:00+99:00'], ['2026-09-09T08:00:00+02:99'], ['2026-09-09T08:00:00+24:00'],
    ['2026-09-09T08:00:00-24:00'], ['2026-09-09T08:00:00+0299']])(
    'does not infer an instant from %s', async (time, local?: string) => {
      await expect(recognizeFromLookup(async () => ({ status: 'in_transit', last_update: time,
        events: [{ time, description: 'Sorted' }] })))
        .resolves.toEqual({ known: true, lastActivityAt: null, ...(local ? { lastActivityLocal: local } : {}) });
    },
  );

  it.each([
    ['2026-09-09T08:00:00+02:30', '2026-09-09T05:30:00.000Z'],
    ['2026-09-09T08:00:00+0230', '2026-09-09T05:30:00.000Z'],
    ['2026-09-09T08:00:00-04:00', '2026-09-09T12:00:00.000Z'],
  ])('retains activity from a valid explicit offset: %s', async (time, expected) => {
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit', last_update: time,
      events: [{ time, description: 'Sorted' }] }))).resolves.toEqual({ known: true, lastActivityAt: expected });
  });

  it('cannot promote a malformed newer clock over genuine activity', async () => {
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit', last_update: '2026-09-30T08:00:00+99:00',
      events: [{ time: '2026-09-30T08:00:00+02:99', description: 'Malformed scan' },
        { time: '2026-09-09T08:00:00+02:00', description: 'Dated scan' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T06:00:00.000Z' });
  });

  it('ignores a newer unresolved clock when a genuine activity instant is available', async () => {
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit',
      events: [{ time: '2026-09-10T12:00:00', description: 'Local scan' },
        { time: '2026-09-09T08:00:00+02:00', description: 'Dated scan' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T06:00:00.000Z' });
  });

  it('keeps the newest local clock when no scan states an instant', async () => {
    await expect(recognizeFromLookup(async () => ({ status: 'delivered', last_update_local: '2026-03-02T09:00:00',
      events: [{ local_time: '2026-03-02T09:00:00', description: 'Delivered' }, { local_time: '2026-02-27T18:30:00', description: 'Collected' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-02T09:00:00' });
    // An instant comes first, and an impossible wall time or an offset is no local clock.
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit',
      events: [{ local_time: '2026-09-10T12:00:00', description: 'Local scan' }, { time: '2026-09-09T08:00:00+02:00', description: 'Dated scan' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T06:00:00.000Z' });
    for (const local_time of ['2026-02-30T08:00:00', '2026-09-09T08:00:00+02:00', 'broken']) {
      await expect(recognizeFromLookup(async () => ({ status: 'in_transit', events: [{ local_time, description: 'Sorted' }] })), local_time)
        .resolves.toEqual({ known: true, lastActivityAt: null });
    }
    await expect(recognizeFromLookup(async () => ({ status: 'unknown', events: [], last_update_local: '2026-03-02T09:00:00' })))
      .resolves.toEqual({ known: false, lastActivityAt: null });
  });

  it('reads a result as known, a positive not-found as unknown, and rethrows the rest', async () => {
    await expect(recognizeFromLookup(async () => ({
      status: 'in_transit', events: [
        { time: '2026-09-08T10:00:00Z', description: 'Sorted' }, { time: '2026-09-09T08:00:00+02:00', description: 'Out' },
      ],
    }))).resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T06:00:00.000Z' });
    await expect(recognizeFromLookup(async () => ({ status: 'unknown', events: [] }))).resolves.toEqual({ known: false, lastActivityAt: null });
    // "Tracking information received" for any number is no evidence.
    await expect(recognizeFromLookup(async () => ({ status: 'pending', events: [] }))).resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(recognizeFromLookup(async () => ({ status: 'delivered', events: [], last_update: '2026-09-09T08:00:00Z' })))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T08:00:00.000Z' });
    await expect(recognizeFromLookup(async () => { throw new NotFoundError('Carrier'); })).resolves.toEqual({ known: false });
    // A lookup that rejects the number's format knows it no better than one that cannot find it.
    await expect(recognizeFromLookup(async () => { throw new InvalidInputError('Carrier'); })).resolves.toEqual({ known: false });
    expect(accepted(() => { throw new InvalidInputError('Carrier'); })).toBe(false);
    // A form of number the adapter does not accept is unknown without a request.
    let asked = false;
    const reject = () => accepted(() => { throw new TypeError('Unsupported number'); });
    await expect(recognizeFromLookup(async () => { asked = true; return { status: 'delivered' }; }, reject)).resolves.toEqual({ known: false });
    expect(asked).toBe(false);
    // Any other TypeError is a failure, not an answer.
    await expect(recognizeFromLookup(async () => { throw new TypeError('Cannot read properties of null'); })).rejects.toThrow(TypeError);
    // Day-first carrier dates are no instant: the parcel is known, its activity dated on the local clock.
    await expect(recognizeFromLookup(async () => ({ status: 'in_transit', events: [{ time: '27/09/2026 08:15', description: 'Sorted' }] })))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-27T08:15:00' });
    await expect(recognizeFromLookup(async () => { throw new UpstreamHttpError('Carrier', 503); })).rejects.toThrow();
  });

  it('knows a parcel the carrier holds behind the recipient\'s postcode, and no number a form asks a postcode for', async () => {
    const held = new InputRequiredError('Carrier', 'a postcode', undefined, { reason: 'parcel_found' });
    await expect(recognizeFromLookup(async () => { throw held; })).resolves.toEqual({ known: true, lastActivityAt: null });
    // A step runner's wrapper keeps the answer.
    await expect(recognizeFromLookup(async () => { throw new Error('direct failed', { cause: held }); }))
      .resolves.toEqual({ known: true, lastActivityAt: null });
    // A carrier that asks every number for a postcode says nothing about this one.
    await expect(recognizeFromLookup(async () => { throw new InputRequiredError('Carrier', 'a postcode'); }))
      .rejects.toMatchObject({ kind: 'input_required' });
    await expect(recognizeFromLookup(async () => { throw new InputRequiredError('Carrier', 'a postcode', undefined, { reason: 'postcode_mismatch' }); }))
      .rejects.toMatchObject({ kind: 'input_required' });
  });
});

describe('catalog recognition', () => {
  it('is declared only by carriers whose adapter can recognize a number', () => {
    const registry = new AdapterRegistry(REGISTRY, { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const declared = readdirSync(carriersDirectory).filter((id) => {
      try {
        return Boolean(JSON.parse(readFileSync(path.join(carriersDirectory, id, 'carrier.json'), 'utf8')).tracking?.recognition);
      } catch { return false; }
    });
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((id) => typeof registry.for(id)?.recognize !== 'function')).toEqual([]);
  });
  it('declares browser recognition only where the adapter supplies it', () => {
    const registry = new AdapterRegistry(REGISTRY, { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const declared = readdirSync(carriersDirectory).filter((id) => {
      try { return Boolean(JSON.parse(readFileSync(path.join(carriersDirectory, id, 'carrier.json'), 'utf8')).tracking?.browserRecognition); }
      catch { return false; }
    });
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((id) => typeof registry.for(id)?.recognizeWithBrowser !== 'function')).toEqual([]);
  });
});

describe('browser confirmation', () => {
  it('rejects shells and undated default statuses, and retains dated history', async () => {
    await expect(recognizeFromBrowserLookup(async () => ({ status: 'in_transit', events: [] })))
      .resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(recognizeFromBrowserLookup(async () => ({ status: 'unknown', events: [] })))
      .resolves.toEqual({ known: false, lastActivityAt: null });
    const result = { status: 'in_transit' as const, events: [{ time: '2026-09-09T08:00:00Z', description: 'Sorted' }] };
    await expect(recognizeFromBrowserLookup(async () => result)).resolves.toEqual({
      known: true, lastActivityAt: '2026-09-09T08:00:00.000Z', result,
    });
    await expect(recognizeFromBrowserLookup(async () => { throw new NotFoundError('Carrier'); })).resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(recognizeFromBrowserLookup(async () => { throw new UpstreamHttpError('Carrier', 503); })).rejects.toThrow();
  });

  it('normalizes the retained result like every tracking result', async () => {
    // An invented USPS package identifier behind a routing prefix with a made-up ZIP code.
    const pic = '9210090000000012345679';
    const answer = await recognizeFromBrowserLookup(async () => ({ status: 'in_transit', delivery_carrier: 'usps',
      delivery_tracking_number: `42000000${pic}`, events: [{ time: '2026-09-09T08:00:00Z', description: 'Sorted' }] }));
    expect(answer).toMatchObject({ known: true, result: { delivery_carrier: 'usps', delivery_tracking_number: pic } });
    // A result no tracking lookup would accept is a failure, not an answer.
    await expect(recognizeFromBrowserLookup(async () => ({ status: 'in_transit', events: [{ time: '2026-09-09T08:00:00Z', description: 7 }] } as never)))
      .rejects.toThrow(TypeError);
  });
});
