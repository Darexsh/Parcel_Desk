import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierAdapter, carrierDefinition } from '../../core/catalog/index.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { createTracker, TrackingError } from '../../facade/index.js';

const number = 'OMGO0000000000001';
const history: unknown = JSON.parse(readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8'));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('OMGO catalog and tracking', () => {
  it('recognizes the shipment without probing Colis Privé or selecting a delivery partner', () => {
    expect(detectCarrierMatch('omgo 0000000050001')).toMatchObject({
      carrier: 'omgo', confidence: 'high', candidates: ['omgo'],
    });
    expect(parseTrackingInput(`Tracking number: ${number}`)).toMatchObject({
      carrier: 'omgo', trackingNumber: number, confidence: 'high', source: 'text',
    });
    expect(parseTrackingInput(`https://example.com/parcel/${number}`)).toMatchObject({
      carrier: 'omgo', trackingNumber: number, confidence: 'high', source: 'link',
    });
    expect(carrierIdFromName('Omgo')).toBe('omgo');
  });

  it.each(['OMGO000000000001', 'OMGO00000000000001', 'OMGA0000000000001'])(
    'does not claim unsupported number %s', (value) => {
      expect(detectCarrierMatch(value).candidates).not.toContain('omgo');
    },
  );

  it('does not extract a supported substring from a longer identifier', () => {
    expect(parseTrackingInput(`Parcel reference: X${number}`).carrier).not.toBe('omgo');
  });

  it('tracks through an enabled provider after an inconclusive direct answer, preserving provenance and clocks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('tracking-page.html')))
      .mockResolvedValueOnce(new Response(fixture('unknown.json'))).mockResolvedValueOnce(new Response(JSON.stringify(history), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const answer = await createTracker({ providers: ['ParcelsApp'], fetcher }).track({ number });
    expect(answer).toMatchObject({
      carrier: 'omgo', source: 'ParcelsApp', attempts: [{ source: 'omgo', kind: 'indeterminate' }, { source: 'ParcelsApp', kind: 'ok' }],
      result: { status: 'in_transit', current_stage: 'in_transit', discovered_carrier: 'omgo' },
    });
    expect(answer.result.events.map(event => event.time)).toEqual([
      '2026-01-04T12:00:00.000Z', '2026-01-03T09:00:00.000Z', '2026-01-02T08:00:00.000Z',
    ]);
    expect(JSON.stringify(answer)).not.toContain('Example Sender');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2]![0])).toBe('https://parcelsapp.com/api/v2/parcels');
  });

  it('retrieves the dedicated history with providers disabled and dates its local clocks on a deduced zone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('tracking-page.html')))
      .mockResolvedValueOnce(new Response(fixture('tracking.json')));
    expect(carrierAdapter('omgo')).toBe('omgo');
    expect(carrierDefinition('omgo').timezone).toBe('UTC');
    const answer = await createTracker({ fetcher, providers: [] }).track({ number });
    expect(answer).toMatchObject({ carrier: 'omgo', source: 'omgo', attempts: [{ source: 'omgo', kind: 'ok' }],
      result: { current_stage: 'in_transit', destination_country: 'CA', events: expect.any(Array) } });
    expect(answer.result.events.every(event => event.local_time && event.instant && event.time_zone_basis)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps universal providers opt-in when its own reply proves nothing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('tracking-page.html')))
      .mockResolvedValueOnce(new Response(fixture('unknown.json')));
    await expect(createTracker({ fetcher, providers: [] }).track({ number })).rejects.toBeInstanceOf(TrackingError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
