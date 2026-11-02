import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, xgsTrackingUrl } from './adapter.js';
import { normalizeXgsNumber, parseXgs } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '00000017';
const UNKNOWN = '00000099';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

type Entry = Record<string, unknown>;
const edited = (change: (entry: Entry) => void) => {
  const reply = JSON.parse(text('delivered.json')) as { data: Entry[] };
  change(reply.data[0]!);
  return reply;
};

describe('XGS numbers', () => {
  it('takes a probill of seven or eight digits', () => {
    expect(normalizeXgsNumber(` ${NUMBER} `)).toBe(NUMBER);
    for (const other of ['000017', '000000017', 'A0000017']) expect(() => normalizeXgsNumber(other), other).toThrow('seven or eight digits');
  });

  it('reads a link to the tracking widget', () => {
    expect(parseTrackingInput(`https://www.xgsi.com/#track-shipment=${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'xgs' });
  });
});

describe('XGS tracking', () => {
  it('asks the tracking API for the probill', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://api.xgsi.com/shipments/track?trackNumber=${NUMBER}&type=probill`);
    expect(xgsTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the status, dated by the delivery, without the signatory, the ZIP code or the towns', () => {
    const result = parseXgs(JSON.parse(text('delivered.json')), NUMBER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      provider_code: 'DELIVERED', last_update: null, last_update_local: '2026-03-05T09:30:00', expected_delivery: null,
      summary_only: true, events: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|00000"|ZZ/);
  });

  it('dates a probill on its way by its newest milestone, and keeps the planned day', () => {
    const warehoused = parseXgs(edited((entry) => {
      Object.assign(entry, { STATUS: 'WAREHOUSED AT DEST. SRV CNTR', humanReadableStatus: '', PODDATE: null, PODTIME: null, DELIVERBYDATE: '20260306' });
    }), NUMBER);
    expect(warehoused).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'WAREHOUSED AT DEST. SRV CNTR',
      last_update_local: '2026-03-04T07:01:00', expected_delivery: '2026-03-06' });
    const billed = parseXgs(edited((entry) => {
      Object.assign(entry, { STATUS: 'SYNTHETIC', humanReadableStatus: 'Synthetic', PODDATE: '', PODTIME: '', SERVICECENTER_ARRIVAL_DATE: '', SERVICECENTER_ARRIVAL_TIME: '' });
    }), NUMBER);
    expect(billed).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic', provider_code: 'SYNTHETIC', last_update_local: '2026-03-02',
      expected_delivery: '2026-03-05' });
    expect(billed).not.toHaveProperty('current_stage');
  });

  it('reads the API’s 404 for a probill it does not hold as not found', async () => {
    const fetcher = replying(() => json(text('not-found.json'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing route, a refusal, a firewall page, a rate limit and an outage apart from a missing shipment', async () => {
    const cases: [Response, string][] = [
      [json({ code: 404, error: 'Cannot GET /shipments/track' }, { status: 404 }), 'transport'],
      [new Response('', { status: 404 }), 'transport'],
      [new Response('', { status: 301, headers: { Location: 'https://www.xgsi.com/' } }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>', { status: 403 }), 'challenge'],
      [json({ code: 429 }, { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [new Response('', { status: 500 }), 'indeterminate'],
      [new Response('', { status: 503 }), 'maintenance'],
      [new Response('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [new Response('<html><body>maintenance</body></html>', { headers: { 'Content-Type': 'text/html' } }), 'schema'],
      [json({ result: false }), 'schema'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves another probill and a changed reply open or failed, never found', () => {
    expect(() => parseXgs(edited((entry) => { entry.PROBILL = UNKNOWN; }), NUMBER)).toThrow('another shipment');
    expect(() => parseXgs({ data: [] }, NUMBER)).toThrow('another shipment');
    expect(() => parseXgs(edited((entry) => { entry.STATUS = ''; }), NUMBER)).toThrow('without its status');
    expect(() => parseXgs(edited((entry) => { entry.PODDATE = '20260230'; }), NUMBER)).toThrow('invalid day');
    expect(() => parseXgs(edited((entry) => { entry.PODTIME = '256000'; }), NUMBER)).toThrow('invalid time');
  });

  it('recognizes a probill its tracker holds, and not one it does not', async () => {
    await expect(carrier(replying(() => json(text('delivered.json')))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => json(text('not-found.json'), { status: 404 }))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => json(text('delivered.json')));
    await expect(carrier(fetcher).recognize!('0017')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('XGS status map', () => {
  it('stages every status code it lists, and the app reads it', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'xgs', providerCode: 'DELIVERED', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'xgs', providerCode: 'SYNTHETIC', description: 'Synthetic' })).toEqual({ kind: 'unknown' });
  });
});
