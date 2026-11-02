import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, optimaTrackingUrl } from './adapter.js';
import { normalizeOptimaNumber, parseOptima } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'P00000000000017';
const UNKNOWN = 'P00000000000099';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

type Data = Record<string, unknown> & { packages: Record<string, unknown>[]; trackingHistory: Record<string, unknown>[] };
const delivered = () => JSON.parse(text('delivered.json')) as { success: boolean; data: Data };
const edited = (change: (data: Data) => void) => {
  const reply = delivered();
  change(reply.data);
  return reply;
};

describe('Optima Overnight numbers', () => {
  it('offers Optima for P and fourteen digits, and asks its tracker', () => {
    expect(detectCarrierMatch(NUMBER).candidates).toContain('optima-overnight');
    expect(recognitionCandidates(NUMBER).map(({ carrier: id }) => id)).toContain('optima-overnight');
    expect(normalizeOptimaNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['P0000000000001', 'P000000000000170', '000000000000017', 'PX0000000000017']) {
      expect(() => normalizeOptimaNumber(other), other).toThrow('P and fourteen digits');
    }
  });

  it('reads a link to the tracking page, in its current and older form', () => {
    for (const link of [`https://www.shipoptima.com/pages/tracking?tracking=${NUMBER}`, `https://shipoptima.com/tracking/?trackingNumber=${NUMBER}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'optima-overnight' });
    }
  });
});

describe('Optima Overnight tracking', () => {
  it('asks the tracking page’s lookup for the number', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://distribution.shipoptima.com/api/shipment/tracking?trackingNumber=${NUMBER}`);
    expect(optimaTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the history newest first, on wall clocks with no zone', () => {
    const result = parseOptima(delivered(), NUMBER);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-05T14:12:40',
    });
    expect(result.events).toEqual([
      { local_time: '2026-03-05T14:12:40', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-03-05T07:15:30', description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-03-04T22:41:05', description: 'Received at Optima Warehouse', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    // The address, the signatory and the photos stay out.
    expect(JSON.stringify(result)).not.toMatch(/Synthetic (?:Town|Signer)|example\.invalid|00000"/);
  });

  it('keeps scans of one second in the order Optima listed them, and an unlisted status without a stage', () => {
    const result = parseOptima(edited((data) => {
      data.trackingHistory.push({ status: 'No Attempt', info: null, time: '2026-03-05 14:12:40' },
        { status: 'Synthetic note', info: null, time: '2026-03-05 14:12:40' });
    }), NUMBER);
    expect(result.events!.slice(0, 3).map((event) => [event.description, event.stage])).toEqual([
      ['Synthetic note', undefined], ['No Attempt', 'failed_attempt'], ['Delivered', 'delivered']]);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', status: 'exception', last_status_text: 'Synthetic note' });
  });

  it('reads a shipment Optima has not received yet from its status alone', () => {
    const result = parseOptima(edited((data) => {
      data.trackingHistory = [];
      data.status = 'Created';
      data.packages[0]!.status = 'Created';
      data.statusTime = '2026-03-04 16:02:11';
    }), NUMBER);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Created',
      last_update_local: '2026-03-04T16:02:11', summary_only: true, events: [] });
  });

  it('reads the lookup’s 404 for the number asked as not found', async () => {
    const fetcher = replying(() => json(text('not-found.json'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing route, a refusal, a firewall page, a rate limit and an outage apart from a missing shipment', async () => {
    const cases: [Response, string][] = [
      [json(text('not-found.json'), { status: 404 }), 'transport'],
      [json({ success: false, status: 'NOT_FOUND', message: 'No static resource' }, { status: 404 }), 'transport'],
      [new Response('', { status: 404 }), 'transport'],
      [new Response('', { status: 301, headers: { Location: 'https://www.shipoptima.com/' } }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>', { status: 403 }), 'challenge'],
      [json({ success: false, status: 'TOO_MANY_REQUESTS' }, { status: 429, headers: { 'Retry-After': '42' } }), 'rate_limited'],
      [new Response('', { status: 500 }), 'indeterminate'],
      [new Response('', { status: 503 }), 'maintenance'],
      [new Response('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [new Response('<html><body>maintenance</body></html>', { headers: { 'Content-Type': 'text/html' } }), 'schema'],
      [json({ success: false, message: 'Synthetic' }), 'schema'],
    ];
    // The not-found fixture names another number than the one asked.
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves an answer for another shipment, an empty history and a changed reply open or failed, never found', () => {
    expect(() => parseOptima(edited((data) => { data.packages[0]!.barcode = UNKNOWN; }), NUMBER)).toThrow('another shipment');
    expect(() => parseOptima(edited((data) => { data.packages = []; }), NUMBER)).toThrow('another shipment');
    expect(() => parseOptima(edited((data) => {
      data.trackingHistory = [];
      data.packages[0]!.status = 'Synthetic';
      data.status = 'Synthetic';
    }), NUMBER)).toThrow(NoHistoryError);
    for (const time of ['2026-03-05', '03/05/2026 14:12', '2026-02-30 10:00:00', '2026-03-05 24:00:00', null]) {
      expect(() => parseOptima(edited((data) => { data.trackingHistory[0]!.time = time; }), NUMBER), String(time)).toThrow('invalid status time');
    }
    expect(() => parseOptima(edited((data) => { data.trackingHistory[0]!.status = ''; }), NUMBER)).toThrow('without wording');
    expect(() => parseOptima(edited((data) => { delete (data as Record<string, unknown>).trackingHistory; }), NUMBER)).toThrow('invalid history');
    expect(() => parseOptima({ success: false }, NUMBER)).toThrow('unexpected reply');
  });

  it('recognizes a number its tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => json(text('delivered.json')))).recognize!(NUMBER))
      .resolves.toMatchObject({ known: true, lastActivityLocal: '2026-03-05T14:12:40' });
    await expect(carrier(replying(() => json(text('not-found.json'), { status: 404 }))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => json(text('delivered.json')));
    await expect(carrier(fetcher).recognize!('P123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Optima Overnight status map', () => {
  it('stages every status its tracking page lists, and the app reads it', () => {
    const wordings = statuses.entries.map((entry) => normalizeStatusWording(entry.wording));
    expect(new Set(wordings).size).toBe(wordings.length);
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'optima-overnight', providerCode: null, description: 'Received at Optima Warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'optima-overnight', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
