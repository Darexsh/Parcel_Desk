import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer, STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { NZ_COURIERS_API } from '../nz-couriers/adapter.js';
import { parseFreightways } from '../nz-couriers/freightways.js';
import { statusMap as nzCouriersMap } from '../nz-couriers/status.js';
import { adapter, CASTLE_PARCELS_API } from './adapter.js';
import { CASTLE_PARCELS } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = 'ZZZ047193';
const UNKNOWN = '00000000000000000000';

type Row = Record<string, unknown>;
type Item = Row & { trackingEvents: Row[] };
type Reply = Row & { consignmentItems: Item[] };

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as Reply;
const changed = (change: (reply: Reply, scans: Row[]) => void) => {
  const reply = fixture();
  change(reply, reply.consignmentItems[0]!.trackingEvents);
  return reply;
};
const parse = (payload: unknown, number: string) => parseFreightways(CASTLE_PARCELS, payload, number);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const empty = () => new Response(null, { status: 204 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const asked = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.map(([url]) => String(url).slice(CASTLE_PARCELS_API.length));
const VALIDATION = { errors: { query: ['The field query must be a string or array type with a minimum length of \'6\'.'] },
  type: 'https://httpstatuses.com/400', title: 'REQUEST_VALIDATION_ERROR', status: 400 };

describe('Castle Parcels HTTP adapter', () => {
  it('asks the Freightways lookup under Castle Parcels’ name, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).includes('searchType=TK') ? empty() : reply(fixture())));
    await expect(carrier(fetcher).track({ number: 'zzz 047193' }, { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(CASTLE_PARCELS_API).toBe(NZ_COURIERS_API.replace('/NZCouriers/', '/CastleParcels/'));
    // A ticket too short once its zeros go is asked whole alone.
    expect(asked(fetcher)).toEqual(['?query=ZZZ047193']);
    const [, init] = fetcher.mock.calls[0]!;
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json' } });
  });

  it('asks for a ticket by its product code, and for a charge label or SSCC alone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    // The older area guides' codes carry digits, before all eight of the ticket's.
    for (const number of ['ZZ 04719352', 'Z10Z 04719352', 'ZZ25 04719352', 'Z3 04719352', '04719352', UNKNOWN]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'not_found', provider: 'Castle Parcels' });
    }
    expect(asked(fetcher)).toEqual([
      '?searchType=TK&ticketProductCode=ZZ&query=4719352',
      '?query=ZZ04719352',
      '?searchType=TK&ticketProductCode=Z10Z&query=4719352',
      '?searchType=TK&ticketProductCode=ZZ25&query=4719352',
      '?searchType=TK&ticketProductCode=Z3&query=4719352',
      '?query=4719352',
      `?query=${UNKNOWN}`,
    ]);
  });

  it('keeps a delivered customer printed label without the signatory, the photo, the tag or the postcode', () => {
    const result = parse(fixture(), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-04-15T23:12:48Z', delivered_at: '2026-04-15T23:12:48Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['D', 'delivered', 'Sample Hills, Sample District'],
      ['ONBD', 'out_for_delivery', null],
      ['P', 'accepted', 'Sample Park, Sample City'],
      ['LC', 'registered', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Signer|example\.invalid|A0000000000|0000"|SAMPLETON|SMH|00-000|barcode|New Zealand"/);
  });

  it('names Post Haste as the delivery carrier when it made the newest scan', () => {
    expect(parse(fixture(), DELIVERED)).toMatchObject({ delivery_carrier: 'post-haste' });
    expect(parse(changed((_body, scans) => { scans.at(-1)!.carrierName = 'CastleParcels'; }), DELIVERED)).not.toHaveProperty('delivery_carrier');
  });

  it('counts a customer printed label only when its consignment number is the whole number asked', () => {
    for (const shortId of ['0000000 ZZZ047193', 'ZZZ047193', 'ZZZZZZ0 ZZZ047193', '0000000 ZZZ047193']) {
      expect(parse(changed((body) => { body.shortConsignmentId = shortId; }), DELIVERED).events, shortId).toHaveLength(4);
    }
    for (const shortId of ['0000000 ZZZ047194', '0000000-0 ZZZ047193', '0000000 0000000 ZZZ047193']) {
      expect(() => parse(changed((body) => { body.shortConsignmentId = shortId; }), DELIVERED), shortId)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', provider: 'Castle Parcels', message: 'Castle Parcels answered for another consignment' }));
    }
  });

  it('keeps an unknown number, a refusal and a browser check apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(empty())).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(VALIDATION, { status: 400 })).rejects.toMatchObject({ kind: 'invalid_input', message: 'Castle Parcels refused the number' });
    await expect(lookup({ message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge', message: 'Castle Parcels answered with a browser check' });
  });

  it('declares no recognition and rejects numbers Castle Parcels does not print without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(carrier(fetcher).recognize).toBeUndefined();
    for (const number of ['00000000', 'ZZ 00000000', 'Z 04719352', 'Z10Z 4719352', '047193526', 'ZZZ047193526', '00000000000000000011',
      'SAMPLETRACKING']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input', provider: 'Castle Parcels' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under Castle Parcels to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).includes('searchType=TK') ? empty() : reply(fixture())));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'castle-parcels' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'castle-parcels', source: 'castle-parcels', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(CASTLE_PARCELS_API))).toBe(true);
  });
});

describe('Castle Parcels status vocabulary', () => {
  it('uses New Zealand Couriers’ map of the group’s scan types', () => {
    expect(statusMap).toBe(nzCouriersMap);
    expect(STATUS_MAPS['castle-parcels']).toBe(nzCouriersMap);
    expect(statusMapAnswer({ carrier: 'castle-parcels', providerCode: 'D', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
