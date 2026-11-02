import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ukpTrackingUrl } from './adapter.js';
import { normalizeUkpNumber, parseUkp } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'WHISU990000001';
const UNKNOWN = 'WHISU990000009';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const delivered = () => text('delivered.html');
/** The fixture with its table's rows replaced. */
const withRows = (...rows: [string, string, string, string][]) => delivered().replace(/<tbody>[\s\S]*<\/tbody>/,
  `<tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>`);

describe('UKP Worldwide numbers', () => {
  it('asks the tracker about letters and digits, and is offered for WHISU and nine digits', () => {
    expect(normalizeUkpNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['WHISU', 'ABCDEFGHIJ', 'WHISU/0000', '12345', `${NUMBER}${'0'.repeat(20)}`]) {
      expect(() => normalizeUkpNumber(other), other).toThrow('letters and digits');
    }
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ukp-worldwide'] });
    expect(recognitionCandidates(NUMBER, {}).map(({ carrier: id }) => id)).toEqual(['ukp-worldwide']);
    for (const other of ['WHISU99000001', 'WHISU9900000011', 'WHISV990000001']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('ukp-worldwide');
    }
  });

  it('reads a link to the tracking page', () => {
    expect(parseTrackingInput(ukpTrackingUrl(NUMBER))).toMatchObject({ trackingNumber: NUMBER, carrier: 'ukp-worldwide' });
  });
});

describe('UKP Worldwide tracking adapter', () => {
  it('asks the tracking page for the whole number', async () => {
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).track({ number: NUMBER.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.ukpworldwide.com/tracking/?x=${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(carrier(fetcher)).toMatchObject({ id: 'ukp-worldwide', recordsSteps: true, steps: ['direct', 'retry'], recognize: expect.any(Function) });
  });

  it('reads the table newest first on wall clocks, each place once and without its postcode', () => {
    const result = parseUkp(delivered(), NUMBER);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'delivered, in/at mailbox', last_update: null, last_update_local: '2026-03-16T12:14:00',
    });
    expect(result.events!.map(({ local_time, description, location, provider_code, stage }) => [local_time, description, location, provider_code, stage])).toEqual([
      ['2026-03-16T12:14:00', 'delivered, in/at mailbox', 'EXAMPLE TOWN, ST', '50', 'delivered'],
      ['2026-03-16T07:43:00', 'out for delivery', 'EXAMPLE TOWN, ST', '30', 'out_for_delivery'],
      // USPS's row without a clock keeps its day alone.
      ['2026-03-14', 'in transit to next facility', undefined, '26', 'in_transit'],
      ['2026-03-12T10:36:00', 'arrived usps regional facility', 'EXAMPLE NETWORK DISTRIBUTION CENTER', '26', 'in_transit'],
      ['2026-03-12T05:51:00', 'arrived shipping partner facility, usps awaiting item', 'EXAMPLE CITY, ST', '23', 'in_transit'],
      ['2026-03-11T19:03:00', 'Transferred to Final Mile Carrier', 'US', '21', 'in_transit'],
      ['2026-03-06T20:03:00', 'US Customs Release', 'Jamaica, NY, US', '48', 'customs'],
      ['2026-03-06T14:15:00', 'Departed UK', 'Aylesbury, GB', 'X3', 'in_transit'],
      ['2026-03-03T19:27:00', 'ACAS: assessment complete', 'Jamaica, NY, US', 'SF', undefined],
      ['2026-03-03T19:22:00', 'Pending US Customs disposition code', undefined, '48', 'customs'],
      ['2026-03-03T13:12:00', 'Processed at UKP', 'Aylesbury, GB', 'X1', 'accepted'],
      ['2026-03-03T13:12:00', 'Labelled', 'Aylesbury, GB', 'X0', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/0000[01]|Synthetic Footer/);
  });

  it('reads the unrecognised-number answer as not found, and anything else as no answer', async () => {
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseUkp(text('not-found.html').replace('is not recognised', 'could not be read'), UNKNOWN)).toThrow('unexpected page');
    expect(() => parseUkp(delivered().replace('<h2>Tracking results</h2>', '<h2>Tracking</h2>'), NUMBER)).toThrow('without results');
    expect(() => parseUkp(delivered().replace('<td>Code</td>', '<td>Status</td>'), NUMBER)).toThrow('unexpected table');
    expect(() => parseUkp(withRows(['25th Mar 2026', 'Labelled', 'X0', '']), NUMBER)).toThrow('invalid scan time');
    expect(() => parseUkp(withRows(), NUMBER)).toThrow('no history');
    expect(() => parseUkp('<html><title>Just a moment...</title></html>', NUMBER)).toThrow('browser check');
    await expect(carrier(replying(() => html('', { status: 301, headers: { Location: '/' } }))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('maps its own rows by wording, leaves the air cargo screening unstaged on purpose, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'ukp-worldwide', providerCode: 'X1', description: 'Processed at UKP' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'ukp-worldwide', providerCode: 'SF', description: 'ACAS: assessment complete' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
