import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierAdapter, carrierDefinition } from '../../core/catalog/index.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { recognitionCandidates } from '../../core/recognition/index.js';
import { createTracker } from '../../facade/index.js';

const MASTER = '200000000001';
const PIECE = '200000000001002';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('J&T Cargo catalog and routing', () => {
  it('offers both shared number shapes for HTTP confirmation without selecting them offline', () => {
    for (const number of [MASTER, PIECE]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['j-and-t-cargo']) });
      expect(recognitionCandidates(number)).toContainEqual({ carrier: 'j-and-t-cargo', needsInput: null, preferred: false });
    }
    expect(carrierAdapter('j-and-t-cargo')).toBe('j-and-t-cargo');
    expect(carrierDefinition('j-and-t-cargo').tracking.localClocks).toBe(true);
    expect(parseTrackingInput(`https://www.jtcargo.id/networkQuery?waybillNo=${PIECE}&type=0`)).toMatchObject({
      carrier: 'j-and-t-cargo', trackingNumber: PIECE, confidence: 'high', source: 'link',
    });
  });

  it.each([[MASTER, 'master.json', 'in_transit'], [PIECE, 'piece.json', 'delivered']])(
    'routes explicit whole identifier %s to its own direct adapter with providers disabled', async (number, file, stage) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture(file)));
      const answer = await createTracker({ fetcher, providers: [] }).track({ number, carrier: 'j-and-t-cargo' });
      expect(answer).toMatchObject({ carrier: 'j-and-t-cargo', source: 'j-and-t-cargo', result: { current_stage: stage },
        attempts: [{ source: 'j-and-t-cargo', kind: 'ok' }] });
      // The scans keep their wall clocks and gain an instant on a deduced zone.
      expect(answer.result.events.every(event => event.local_time && event.instant && event.time_zone_basis)).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).waybillNo).toBe(number);
    });

  it('keeps an inconclusive direct unknown and commercial providers opt-in', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('unknown.json')));
    await expect(createTracker({ fetcher, providers: [] }).track({ number: MASTER, carrier: 'j-and-t-cargo' })).rejects.toMatchObject({
      attempts: [{ source: 'j-and-t-cargo', kind: 'indeterminate' }],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('can recover through an enabled provider while preserving the inconclusive direct attempt', async () => {
    const provider = { carriers: ['J&T Cargo'], services: [{ name: 'J&T Cargo', slug: 'j-t-cargo' }], status: 'transit', states: [
      { date: '2026-01-04T12:00:00Z', status: 'In transit', carrier: 0 },
      { date: '2026-01-03T09:00:00Z', status: 'Accepted by carrier', carrier: 0 },
    ] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('unknown.json')))
      .mockResolvedValueOnce(new Response(JSON.stringify(provider), { headers: { 'Content-Type': 'application/json' } }));
    const answer = await createTracker({ fetcher, providers: ['ParcelsApp'] }).track({ number: MASTER, carrier: 'j-and-t-cargo' });
    expect(answer).toMatchObject({ carrier: 'j-and-t-cargo', source: 'ParcelsApp', result: { current_stage: 'in_transit' },
      attempts: [{ source: 'j-and-t-cargo', kind: 'indeterminate' }, { source: 'ParcelsApp', kind: 'ok' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
