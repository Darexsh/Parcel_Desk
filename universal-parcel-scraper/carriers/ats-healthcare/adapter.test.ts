import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, atsTrackingUrl } from './adapter.js';
import { normalizeAtsNumber, parseAts } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '00000017';
const UNKNOWN = '000000099';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const delivered = () => text('delivered.html');
/** The delivered page moved back to another progress step, with another status. */
const atStep = (step: number, status: string) => delivered()
  .replace("<li class='active liBar2'>6</li>", "<li class='liBar2'>6</li>")
  .replace(`<li class='liBar2'>${step}</li>`, `<li class='active liBar2'>${step}</li>`)
  .replace('Delivered, 2026/03/05 14:10:56', status);

describe('ATS Healthcare numbers', () => {
  it('takes eight or nine digits', () => {
    expect(normalizeAtsNumber(` ${NUMBER} `)).toBe(NUMBER);
    for (const other of ['0000017', '0000000017', 'A0000017']) expect(() => normalizeAtsNumber(other), other).toThrow('eight or nine digits');
  });

  it('reads a link to the result page', () => {
    expect(parseTrackingInput(`https://www.atshealthcare.ca/quickTrackResult?ship=${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'ats-healthcare' });
  });
});

describe('ATS Healthcare tracking', () => {
  it('asks the result page for the number', async () => {
    const fetcher = replying(() => html(delivered()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://www.atshealthcare.ca/quickTrackResult?ship=${NUMBER}`);
    expect(atsTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the status and its wall clock, staged by the progress bar, without the signatory', () => {
    const result = parseAts(delivered(), NUMBER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      provider_code: '6', last_update: null, last_update_local: '2026-03-05T14:10:56', expected_delivery: null,
      summary_only: true, events: [],
    });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC SIGNER');
  });

  it('stages a shipment on its way by its progress step, whatever the status words', () => {
    expect(parseAts(atStep(5, 'Synthetic wording, 2026/03/05 07:15:30'), NUMBER)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Synthetic wording', provider_code: '5',
      last_update_local: '2026-03-05T07:15:30',
    });
    expect(parseAts(atStep(0, 'Synthetic wording'), NUMBER)).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: 'Synthetic wording', provider_code: '0', last_update_local: null,
    });
  });

  it('reads the placeholder row for a number it does not hold as not found', async () => {
    const fetcher = replying(() => html(text('not-found.html')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a moved route, a refusal, a firewall page, a rate limit and an outage apart from a missing shipment', async () => {
    const cases: [Response, string][] = [
      [html('', { status: 302, headers: { Location: 'https://www.atshealthcare.ca/ShipTracking-en' } }), 'transport'],
      [html('', { status: 404 }), 'transport'],
      [html('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [html('', { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [html('', { status: 500 }), 'indeterminate'],
      [html('', { status: 503 }), 'maintenance'],
      [html('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [html('<html><body>Server Error in Application</body></html>'), 'schema'],
      // The not-found page names another number than the one asked.
      [html(text('not-found.html')), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves another shipment, a missing detail and a changed page open or failed, never found', () => {
    expect(() => parseAts(delivered().replace('<span id="lblShip">00000017', '<span id="lblShip">00000018'), NUMBER)).toThrow('another shipment');
    expect(() => parseAts(text('not-found.html').replace('Shipping label created for ATS Healthcare', 'Delivered, 2026/03/05 14:10:56'), UNKNOWN))
      .toThrow('no detail');
    expect(() => parseAts(delivered().replace('<th scope="col">Status</th>', '<th scope="col">State</th>'), NUMBER)).toThrow('changed its result table');
    expect(() => parseAts(delivered().replace("<li class='active liBar2'>6</li>", "<li class='liBar2'>6</li>"), NUMBER)).toThrow('without its progress');
    expect(() => parseAts(delivered().replace('2026/03/05 14:10:56', '2026/02/30 14:10:56'), NUMBER)).toThrow('invalid status time');
  });

  it('recognizes a number its tracker holds, and not one it does not', async () => {
    await expect(carrier(replying(() => html(delivered()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(text('not-found.html')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).recognize!('0017')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('ATS Healthcare status map', () => {
  it('stages every progress step, and the app reads it', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'ats-healthcare', providerCode: '6', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'ats-healthcare', providerCode: '7', description: 'Synthetic' })).toEqual({ kind: 'unknown' });
  });
});
