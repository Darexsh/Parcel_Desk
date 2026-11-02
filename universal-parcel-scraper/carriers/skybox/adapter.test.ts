import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, skyboxTrackingUrl } from './adapter.js';
import { normalizeSkyboxNumber, parseSkybox } from './parser.js';
import { skyboxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '009900000017';
const UNKNOWN = '009900000099';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const delivered = () => text('delivered.html');
const missing = () => text('not-found.html');
/** A tracking row as the fragment renders it. */
const row = (wording: string, place: string, clock: string) => `
                                    <tr>
                                        <td>${wording}</td>
                                        <td>${place}</td>
                                        <td>${clock} </td>
                                    </tr>`;
/** The fixture with its tracking table's rows replaced. */
const withRows = (...rows: string[]) => delivered().replace(/(<div class="card-body collapse" id="collapse-tracking">[\s\S]*?<tbody>)[\s\S]*?(<\/tbody>)/, `$1${rows.join('')}$2`);

describe('SkyBox numbers', () => {
  it('takes twelve digits, also as the tracker prints them', () => {
    expect(normalizeSkyboxNumber(` ${NUMBER} `)).toBe(NUMBER);
    expect(normalizeSkyboxNumber('0099-00000017')).toBe(NUMBER);
    for (const other of ['00990000001', '0099000000170', 'SBX000000017', '']) {
      expect(() => normalizeSkyboxNumber(other), other).toThrow('twelve digits');
    }
  });

  it('reads a link to the public tracking page', () => {
    for (const link of [`https://www.skybox.net/TrackingInformation/IndexPublic?tracking=${NUMBER}`, `https://skybox.net/TrackingInformation/IndexPublic/?tracking=${NUMBER}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'skybox' });
    }
  });

  it('refuses another shape before asking, with no reason', async () => {
    const fetcher = replying(() => html(delivered()));
    const refused = carrier(fetcher).track({ number: 'SBX000000017' }, { signal: AbortSignal.abort() });
    await expect(refused).rejects.toThrow(InvalidInputError);
    await expect(refused.catch((error: InvalidInputError) => error.reason)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('SkyBox tracking', () => {
  it('asks the public fragment for the one number', async () => {
    const fetcher = replying(() => html(delivered()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://www.skybox.net/TrackingInformation/GetContentPublic?tracking=${NUMBER}`);
    expect(skyboxTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the tracking table newest first, on wall clocks with no zone, without the card or the status bar', () => {
    const result = parseSkybox(delivered(), NUMBER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'PROOF OF DELIVERY',
      last_update: null, last_update_local: '2030-02-20T18:00:00', expected_delivery: null,
      events: [
        { local_time: '2030-02-20T18:00:00', location: 'SAMPLE TOWN', description: 'PROOF OF DELIVERY', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2030-02-19T17:17:00', location: 'SAMPLE TOWN', description: 'IN TRANSIT', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2030-02-18T18:00:00', location: 'SAMPLE TOWN', description: 'RELEASED FROM CUSTOMS', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2030-01-13T07:28:00', location: 'TEST GATEWAY', description: 'ARRIVED TO YOUR COUNTRY', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2030-01-11T12:03:00', location: 'TEST GATEWAY', description: 'TRANSFERRED TO AIRPORT', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2030-01-11T10:29:00', location: 'TEST GATEWAY', description: 'IN TRANSIT', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2030-01-10T18:00:00', location: 'TEST GATEWAY', description: 'SKYBILL CREATED', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The consignee, the suite, the origin and destination, the weight and the items stay out.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECIPIENT|SBX000017|Test Gateway|Sample Town|Lbs|SAMPLE ITEM/);
  });

  it('keeps scans of one minute in the table’s order, a row without a place without one, and stages another wording by the shared rules or not at all', () => {
    const result = parseSkybox(withRows(row('Synthetic note', 'SAMPLE TOWN', '02/21/2030 09:00'), row('Delivered', '', '02/21/2030 09:00')), NUMBER);
    expect(result.events).toEqual([
      { local_time: '2030-02-21T09:00:00', location: 'SAMPLE TOWN', description: 'Synthetic note' },
      { local_time: '2030-02-21T09:00:00', description: 'Delivered', stage: 'delivered', stage_source: 'wording:language' },
    ]);
    expect(result).toMatchObject({ status: 'delivered', current_stage_source: 'wording:language', last_status_text: 'Synthetic note' });
  });

  it('reads the message for the number asked as not found', async () => {
    const fetcher = replying(() => html(missing()));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a moved route, a firewall page, a rate limit and an outage apart from a missing parcel', async () => {
    const cases: [Response, string][] = [
      [html('', { status: 302, headers: { Location: 'https://www.skybox.net/Error' } }), 'transport'],
      [html('', { status: 404 }), 'transport'],
      [html('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [html('', { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [html('', { status: 500 }), 'indeterminate'],
      [html('', { status: 503 }), 'maintenance'],
      [html('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [html('<html><body><h2>Server Error</h2></body></html>'), 'schema'],
      [html(''), 'schema'],
      // The not-found fragment echoes another number than the one asked.
      [html(missing()), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('reads only the whole message, with no skybill and no card, as not found', () => {
    expect(() => parseSkybox(missing(), UNKNOWN)).toThrow('does not know');
    for (const page of [
      missing().replace('The tracking number does not exists', 'Please try again later'),
      missing().replace('<div id="Modal_Confirm"', '<div class="card trackinginfosearch-section"></div><div id="Modal_Confirm"'),
    ]) expect(() => parseSkybox(page, UNKNOWN)).toThrow('unexpected fragment');
    expect(() => parseSkybox(missing().replace(/id="hdn_trackinginfosearch_skybillid" value="0"/, 'id="hdn_trackinginfosearch_skybillid" value=""'), UNKNOWN))
      .toThrow('without its skybill');
    expect(() => parseSkybox(missing().replace(`value="${UNKNOWN}"`, 'value=""'), UNKNOWN)).toThrow('without the number asked');
  });

  it('leaves another parcel, an empty history and a changed fragment open or failed, never found', () => {
    // A parcel found by the number it arrived under has another SkyBox number.
    expect(() => parseSkybox(delivered().replace('value="0099-00000017"', 'value="0099-00000025"'), NUMBER)).toThrow('another parcel');
    expect(() => parseSkybox(delivered().replace('value="0099-00000017"', 'value=""'), NUMBER)).toThrow('without its number');
    expect(() => parseSkybox(delivered().replace(/class="card trackinginfosearch-section"/g, 'class="card"'), NUMBER)).toThrow('without its number');
    expect(() => parseSkybox(withRows(), NUMBER)).toThrow(NoHistoryError);
    expect(() => parseSkybox(delivered().replace('id="collapse-tracking"', 'id="collapse-other"'), NUMBER)).toThrow(NoHistoryError);
    expect(() => parseSkybox(delivered().replace('id="trackinginfo-search-content"', 'id="other-content"'), NUMBER)).toThrow('unexpected page');
    expect(() => parseSkybox(withRows('<tr><td>IN TRANSIT</td><td>02/21/2030 09:00</td></tr>'), NUMBER)).toThrow('invalid scan');
    expect(() => parseSkybox(withRows(row('', 'SAMPLE TOWN', '02/21/2030 09:00')), NUMBER)).toThrow('invalid scan');
    for (const clock of ['02/30/2030 09:00', '02/21/2030 24:00', '2030-02-21 09:00', '02/21/2030', '']) {
      expect(() => parseSkybox(withRows(row('IN TRANSIT', 'SAMPLE TOWN', clock)), NUMBER), clock).toThrow('invalid scan time');
    }
  });

  it('recognizes a number its tracker holds, and not one it does not know', async () => {
    await expect(carrier(replying(() => html(delivered()))).recognize!(NUMBER))
      .resolves.toMatchObject({ known: true, lastActivityLocal: '2030-02-20T18:00:00' });
    await expect(carrier(replying(() => html(missing()))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).recognize!('0099')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('SkyBox status map', () => {
  it('stages every wording it lists, and the app reads it', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
      expect(skyboxStage(wording), wording).toEqual({ stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'skybox', providerCode: null, description: 'PROOF OF DELIVERY' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'skybox', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
