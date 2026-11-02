import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, safewayTrackingUrl } from './adapter.js';
import { normalizeSafewayNumber, parseSafeway } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'BH99000017';
const UNKNOWN = 'BH99000025';
const PARTNER_NUMBER = '39900000011';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const handOff = () => text('handoff.html');
const notFound = () => text('not-found.html');
/** The hand-off page with one shipment detail's value replaced. */
const withDetail = (label: string, value: string) => handOff().replace(
  new RegExp(`(${label}:</span>\\s*<strong[^>]*>)[^<]*(</strong>)`), `$1${value}$2`);
/** The hand-off page with the status the page prints over the details. */
const withStatus = (status: string) => handOff().replace(/(<span>Status:<\/span>\s*<strong>)(<\/strong>)/, `$1${status}$2`);

describe('Safe Way Express Cargo numbers', () => {
  it('asks the tracker about letters and digits, and is offered for BH and eight digits beside TNT Italy', () => {
    expect(normalizeSafewayNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['BH', 'ABCDEFGHIJ', 'BH9900/0017', '12345', `${NUMBER}${'0'.repeat(30)}`]) {
      expect(() => normalizeSafewayNumber(other), other).toThrow('letters and digits');
    }
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['safeway-express-cargo', 'tnt-it'] });
    expect(recognitionCandidates(NUMBER, {}).map(({ carrier: id }) => id)).toContain('safeway-express-cargo');
  });

  it('reads a link to the tracking page', () => {
    expect(parseTrackingInput(safewayTrackingUrl(NUMBER))).toMatchObject({ trackingNumber: NUMBER, carrier: 'safeway-express-cargo' });
  });
});

describe('Safe Way Express Cargo tracking adapter', () => {
  it('asks the tracking page for the whole number', async () => {
    const fetcher = replying(() => html(handOff()));
    await expect(carrier(fetcher).track({ number: NUMBER.toLowerCase() })).resolves.toMatchObject({ current_stage: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.safewayxp.com/track.php?awb=${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(carrier(fetcher)).toMatchObject({ id: 'safeway-express-cargo', recordsSteps: true, steps: ['direct', 'retry'], recognize: expect.any(Function) });
  });

  it('reads a hand-off to Aramex as shipped on its day, with Aramex\'s number', () => {
    expect(parseSafeway(handOff(), NUMBER)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Shipped', last_update: null, last_update_local: '2026-09-14', expected_delivery: null,
      delivery_carrier: 'aramex', delivery_tracking_number: PARTNER_NUMBER, summary_only: true,
      events: [{ local_time: '2026-09-14', description: 'Shipped', stage: 'in_transit', stage_source: 'carrier_map' }],
    });
  });

  it('stages the status the page prints, and names no partner it does not know', () => {
    expect(parseSafeway(withStatus('Delivered'), NUMBER)).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', delivery_carrier: 'aramex',
      events: [{ description: 'Shipped', stage: 'in_transit' }],
    });
    const other = parseSafeway(withDetail('Carrier', 'Example Couriers'), NUMBER);
    expect(other).toMatchObject({ current_stage: 'in_transit', events: [{ local_time: '2026-09-14' }] });
    expect(other).not.toHaveProperty('delivery_carrier');
    expect(other).not.toHaveProperty('delivery_tracking_number');
    // A partner without a number of its own is no hand-off.
    expect(parseSafeway(withDetail('Carrier Tracking Number', ''), NUMBER)).not.toHaveProperty('delivery_carrier');
  });

  it('reads a shipped value that is not a day as no scan, and a page with nothing as no history', () => {
    const undated = parseSafeway(withDetail('Shipped Date', '0000-00-00'), NUMBER);
    expect(undated).toMatchObject({ status: 'unknown', last_status_text: null, delivery_carrier: 'aramex', events: [] });
    expect(undated).not.toHaveProperty('current_stage');
    const empty = withDetail('Carrier', '').replace(/(Shipped Date:<\/span>\s*<strong[^>]*>)[^<]*/, '$1');
    expect(() => parseSafeway(empty, NUMBER)).toThrow('no history');
  });

  it('reads the not-found answer for the number in the search field as not found, and anything else as no answer', async () => {
    await expect(carrier(replying(() => html(notFound()))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseSafeway(notFound(), 'BH99000033')).toThrow('another number');
    expect(() => parseSafeway(notFound().replace('Tracking Information Not Found', 'Service Unavailable'), UNKNOWN)).toThrow('unexpected page');
  });

  it('refuses another shipment, a page without results, a timeline it does not know and a browser check', async () => {
    expect(() => parseSafeway(handOff(), 'BH99000033')).toThrow('another number');
    expect(() => parseSafeway(handOff().replace('id="trackingResults"', 'id="results"'), NUMBER)).toThrow('without results');
    const info = /<div class="tracking-info">[\s\S]*?<!-- Timeline section -->/.exec(handOff())![0];
    expect(() => parseSafeway(handOff().replace(info, `${info}${info}`), NUMBER)).toThrow('several shipments');
    const scans = handOff().replace(/<p class="text-muted">No tracking events available yet\.<\/p>/,
      '<ul class="timeline"><li class="complete"><div class="timeline-content"><h5>Delivered</h5></div></li></ul>');
    expect(() => parseSafeway(scans, NUMBER)).toThrow('timeline the adapter does not read');
    expect(() => parseSafeway('<html><title>Just a moment...</title></html>', NUMBER)).toThrow('browser check');
    await expect(carrier(replying(() => html('<html><body>Oops</body></html>'))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps a rate limit, a moved page and a number it does not take as their own failures', async () => {
    await expect(carrier(replying(() => html('', { status: 429 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(replying(() => html('', { status: 301, headers: { Location: '/' } }))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'transport' });
    const fetcher = replying(() => html(handOff()));
    await expect(carrier(fetcher).track({ number: 'BH 9900,0017' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a shipment the tracker holds, by its shipped day, and not an unknown number', async () => {
    await expect(carrier(replying(() => html(handOff()))).recognize!(NUMBER))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-14T00:00:00' });
    await expect(carrier(replying(() => html(notFound()))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('maps its wordings, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'safeway-express-cargo', description: 'Shipped' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
