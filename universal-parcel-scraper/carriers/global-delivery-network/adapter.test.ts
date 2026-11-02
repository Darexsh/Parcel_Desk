import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { adapter, GdnTracker } from './adapter.js';
import { gdnUrl, normalizeGdnNumber, parseGdn } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic: a twelve-digit parcel number and a made-up recipient, as the tracker lays them out.
const NUMBER = '100000000001';
const input = (label: string, value: string) => `<label>${label}</label><input type="text" readonly="readonly" value="${value}" /><br />`;
const row = (clock: string, wording: string, place = ' - ') =>
  `<tr><td class="table_row_nowrap">${clock}</td><td class="table_row">${wording}</td><td class="table_row">${place}</td></tr>`;
const page = (rows = [
  row('2/15/2026 11:21:00 AM', 'Delivered'),
  row('2/15/2026 9:13:00 AM', 'With courier for delivery'),
  row('2/8/2026 12:01:00 PM', 'Handed over to NZ Post', 'AUCKLAND - NZ'),
  row('1/26/2026 12:52:00 PM', 'Parcel received in outbound hub for processing', 'Newark - US'),
  row('1/25/2026 12:11:31 PM', 'Package Prepared for Departure', 'SAMPLETOWN, NJ - US'),
  row('1/20/2026 8:19:41 PM', 'Electronic Information Submitted by Shipper', ''),
], number = NUMBER) => `<html><body><h1 id="banner_icon_text">Tracking</h1>
  <div>${input('Recipient:', 'PRIVATE RECIPIENT')}${input('Address Line 1:', 'PRIVATE STREET')}${input('City:', 'PRIVATE CITY')}
  ${input('Postal Code:', 'PRIVATE POSTCODE')}${input('Country:', 'NZ')}${input('Weight:', '8.5')}</div>
  <div>${input('Parcel Number:', number)}${input('Tracking Number:', 'PRIVATEREF001')}</div>
  <div id="logistics_article"><table><tr><th>Date/Time</th><th>Activity Description</th><th>Location</th></tr>${rows.join('')}</table></div>
  </body></html>`;
// The tracker's page for a number it does not know ends after its heading.
const MISSING = '<html><body><h1 id="banner_icon_text">Tracking</h1>\n<h1 style="margin-left:35%;">Unable to locate the selected Package.</h1>';

describe('Global Delivery Network tracker page', () => {
  it('takes twelve-digit parcel numbers only', () => {
    expect(normalizeGdnNumber('1000 0000 0001')).toBe(NUMBER);
    expect(gdnUrl(NUMBER)).toBe(`https://pds.gdnparcel.com/pds_tracking.asp?track=${NUMBER}`);
    for (const raw of ['10000000001', '1000000000011', 'ZZ0000000001']) {
      expect(() => normalizeGdnNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    // Twelve digits are many carriers' numbers: no rule claims them.
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('global-delivery-network');
  });

  it('reads the scans newest first on their wall clocks and keeps no recipient or reference', () => {
    const result = parseGdn(page(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-02-15T11:21:00', destination_country: 'NZ' });
    expect(result.events).toEqual([
      { local_time: '2026-02-15T11:21:00', description: 'Delivered', stage: 'delivered', stage_source: 'wording:language' },
      { local_time: '2026-02-15T09:13:00', description: 'With courier for delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-02-08T12:01:00', description: 'Handed over to NZ Post', location: 'AUCKLAND, NZ', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-26T12:52:00', description: 'Parcel received in outbound hub for processing', location: 'Newark, US',
        stage: 'accepted', stage_source: 'carrier_map' },
      { local_time: '2026-01-25T12:11:31', description: 'Package Prepared for Departure', location: 'SAMPLETOWN, NJ, US',
        stage: 'in_transit', stage_source: 'wording:language' },
      { local_time: '2026-01-20T20:19:41', description: 'Electronic Information Submitted by Shipper', stage: 'registered', stage_source: 'wording:language' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|8\.5/);
  });

  it('dates each scan in the zone of its place or its neighbours', () => {
    const events = dateLocalClocks('global-delivery-network', parseGdn(page(), NUMBER)).events!;
    expect(events[0]).toMatchObject({ time: '2026-02-15T11:21:00+13:00', time_zone: 'Pacific/Auckland', time_zone_basis: 'neighbour' });
    expect(events[3]).toMatchObject({ time: '2026-01-26T12:52:00-05:00', time_zone: 'America/New_York', time_zone_basis: 'place' });
  });

  it('tells a number it does not know from another parcel or a changed page', () => {
    expect(() => parseGdn(MISSING, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGdn(page(undefined, '100000000002'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGdn('<html><body>Service unavailable</body></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGdn(page([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGdn(page([row('15/02/2026 11:21', 'Delivered')]), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('asks the page once for the whole number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(page(), { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(new GdnTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(gdnUrl(NUMBER));
    const unit = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    expect(unit).toMatchObject({ id: 'global-delivery-network', steps: ['direct'] });
  });

  it('keeps its status catalog in step with the parser', () => {
    for (const entry of statuses.entries) {
      const stage = parseGdn(page([row('1/20/2026 8:19:41 PM', entry.wording)]), NUMBER).events![0]!.stage;
      expect(stage, entry.wording).toBe(entry.stage);
      // The map answers for GDN's own wording; the shared rules read the rest.
      const answer = statusMapAnswer({ carrier: 'global-delivery-network', description: entry.wording });
      if (answer.kind === 'mapped') expect(answer.stage, entry.wording).toBe(entry.stage);
    }
  });
});
