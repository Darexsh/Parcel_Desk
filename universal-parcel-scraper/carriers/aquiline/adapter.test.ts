import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AQUILINE_FUNCTION } from './adapter.js';
import { normalizeAquilineNumber, parseAquiline } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'AQUAA9900000001YQ';
const UNKNOWN = 'AQUAA9900000009YQ';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as {
  result: { success: boolean; data: Record<string, unknown> & { events: Record<string, unknown>[] } };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

describe('Aquiline numbers', () => {
  it('takes AQUAA, ten digits and YQ, suggests them and asks the tracker about them', () => {
    expect(normalizeAquilineNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['AQUAA990000001YQ', 'AQUAA99000000001YQ', 'AQUAB9900000001YQ', 'AQUAA9900000001YX']) {
      expect(() => normalizeAquilineNumber(other), other).toThrow('AQUAA, ten digits and YQ');
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('aquiline');
    }
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['aquiline'] });
    expect(recognitionCandidates(NUMBER, {}).map(({ carrier: id }) => id)).toEqual(['aquiline']);
  });

  it('reads a link to the tracker, on its current and former domain', () => {
    for (const link of [`https://aq-track.com/app/track/${NUMBER}`, `https://aquiline-tracking.com/app/?track=${NUMBER}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'aquiline' });
    }
  });
});

describe('Aquiline tracking adapter', () => {
  it('asks the tracker’s function for the whole number, as the tracker does', async () => {
    const fetcher = replying(() => json(fixture('shipment')));
    await expect(carrier(fetcher).track({ number: NUMBER.toLowerCase() })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(AQUILINE_FUNCTION);
    expect(AQUILINE_FUNCTION).toBe('https://europe-west1-aquiline-e398d.cloudfunctions.net/getTrackingStatus');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(JSON.parse(String(init!.body))).toEqual({ data: { input: NUMBER } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(carrier(fetcher)).toMatchObject({ id: 'aquiline', recordsSteps: true, steps: ['direct', 'retry'], recognize: expect.any(Function) });
  });

  it('reads Amazon’s scans in UTC, the shipper’s handover by its day, and places without a street or postcode', () => {
    const result = parseAquiline(fixture('shipment'), NUMBER);
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Package is out for delivery.',
      last_update: '2026-03-09T15:43:00Z', destination_country: 'US',
    });
    expect(result.events!.map(({ time, local_time, description, location, stage }) => [time ?? local_time, description, location, stage])).toEqual([
      ['2026-03-09T15:43:00Z', 'Package is out for delivery.', 'Example Town, US', 'out_for_delivery'],
      ['2026-03-09T06:38:00Z', 'Package arrived at a carrier facility.', 'Example Town, US', 'in_transit'],
      ['2026-03-08T20:12:00Z', 'A carrier delay has occurred.', 'Example Town, US', undefined],
      ['2026-03-08T03:51:00Z', 'Package being processed at carrier facility.', undefined, 'in_transit'],
      ['2026-03-07T00:26:00Z', 'Package left at a carrier facility.', 'Example City, ST US', 'in_transit'],
      ['2026-03-06T21:00:00Z', 'Package arrived at a carrier facility.', 'Example City, ST US', 'in_transit'],
      ['2026-03-06', 'Package left the shipper facility', 'US', 'accepted'],
      ['2026-03-05T22:49:45Z', 'Shipping label created. Carrier awaiting item', undefined, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Way|00000|Error/);
  });

  it('reads the tracker’s Unknown answer as not found, and other answers without scans as no answer', async () => {
    await expect(carrier(replying(() => json(fixture('unknown')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const errored = fixture('unknown');
    errored.result.data.currentStatus = 'Error';
    expect(() => parseAquiline(errored, UNKNOWN)).toThrow('without scans');
    expect(() => parseAquiline(fixture('shipment'), UNKNOWN)).toThrow('another number');
    expect(() => parseAquiline({ result: { success: false } }, NUMBER)).toThrow('did not complete');
    expect(() => parseAquiline({ error: { message: 'INTERNAL', status: 'INTERNAL' } }, NUMBER)).toThrow('invalid reply');
    const misdated = fixture('shipment');
    misdated.result.data.events[0]!.date = '09/03/2026 15:43';
    expect(() => parseAquiline(misdated, NUMBER)).toThrow('invalid scan time');
    await expect(carrier(replying(() => json({}, { status: 404 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('maps the handover, leaves a carrier delay unstaged on purpose, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'aquiline', providerCode: null, description: 'Package left the shipper facility' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'aquiline', providerCode: null, description: 'A carrier delay has occurred.' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
