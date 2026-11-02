import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { GZYL_ORIGIN } from '../gzyl/parser.js';
import { adapter, XingheFreightTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'GZXH0000000017YQ';
const UNKNOWN = 'GZXH0000000099YQ';
// GZYL's synthetic replies, with the number in GZYL's place: the tenant is GZYL's.
const GZYL_NUMBER = 'GZTEST00000001';
const READ_AT = Date.parse('2026-03-06T00:00:00Z');
const fixture = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8').replaceAll(GZYL_NUMBER, NUMBER);
const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Xinghe Freight numbers', () => {
  it('takes the universal providers’ name for the forwarder, and its Chinese one', () => {
    for (const name of ['GZXH', 'Xinghe Freight', '星和货运']) expect(carrierIdFromName(name), name).toBe('xinghe-freight');
  });
});

describe('Xinghe Freight tracking adapter', () => {
  it('asks GZYL’s Hualei tracker, which the site’s tracking form opens, for the whole number', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track.json')));
      const result = await new XingheFreightTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      expect(String(fetcher.mock.calls[0]![0])).toBe(`${GZYL_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(result).toMatchObject({ current_stage: 'customs', current_stage_source: 'carrier_map', destination_country: 'CH' });
      expect(result.events?.at(-1)).toMatchObject({ description: 'Order information received', stage: 'registered' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track.json')))
      .mockResolvedValueOnce(json(fixture('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${GZYL_ORIGIN}/trackIndex.htm`);
  });

  it('maps the rows universal providers relay as GZYL’s map does, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'xinghe-freight', providerCode: null, description: 'Arrive at the cross border receiving point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'xinghe-freight', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
