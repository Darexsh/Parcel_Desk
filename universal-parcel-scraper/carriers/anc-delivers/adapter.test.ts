import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ANC_API } from './adapter.js';
import { normalizeAncNumber, parseAnc } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'A00000001AA';
type Reply = { jobStatus: string; statuses: Record<string, string>[] } & Record<string, unknown>;
const fixture = (): Reply => JSON.parse(readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8')) as Reply;
// The service labels its JSON as HTML.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const upTo = (count: number) => {
  const body = fixture();
  body.statuses = body.statuses.map((step, index) => (index < count ? step : { ...step, timeDateStamp: '' }));
  return body;
};

describe('ANC numbers', () => {
  it('takes A, eight digits and two letters', () => {
    for (const raw of [NUMBER, 'a00000001aa', 'A 0000 0001 AA']) expect(normalizeAncNumber(raw), raw).toBe(NUMBER);
    for (const raw of ['A0000001AA', 'A000000001AA', 'B00000001AA', 'A00000001A1', '']) {
      expect(() => normalizeAncNumber(raw), raw).toThrow('A, eight digits and two letters');
    }
  });

  it('refuses another shape before asking', async () => {
    const fetcher = replying(() => reply(fixture()));
    await expect(carrier(fetcher).track({ number: 'A1' })).rejects.toThrow(InvalidInputError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('ANC tracking', () => {
  it('asks the open service for the number once', async () => {
    const fetcher = replying(() => reply(fixture()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`${ANC_API}${NUMBER}`);
  });

  it('reads the reached steps newest first, on their wall clocks, without the driver or the recipient', async () => {
    const result = await carrier(replying(() => reply(fixture()))).track({ number: NUMBER });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'delivered',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-01-06T12:33:00', expected_delivery: null,
      events: [
        { local_time: '2026-01-06T12:33:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-01-06T07:25:59', description: 'Onboard for delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-01-05T06:58:00', description: 'Scheduled', stage: 'registered', stage_source: 'carrier_map' },
        { local_time: '2026-01-05T06:58:48', description: 'Booked', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE DRIVER|Sample Street|example\.com|0400|SYNTHETIC-REF|Sample Retailer|base64/);
  });

  it('reads only the steps the delivery has reached', () => {
    expect(parseAnc(upTo(2), NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Scheduled' });
    const body = upTo(3);
    body.statuses.push({ title: 'Delivery attempted', timeDateStamp: '2026-01-06 15:00' });
    expect(parseAnc(body, NUMBER)).toMatchObject({ current_stage: 'failed_attempt', last_update_local: '2026-01-06T15:00:00' });
    const delayed = upTo(2);
    delayed.statuses.push({ title: 'Delayed', timeDateStamp: '2026-01-06 09:00:00' });
    expect(parseAnc(delayed, NUMBER).events?.[0]).toMatchObject({ description: 'Delayed', stage: 'in_transit', stage_source: 'wording:language' });
    expect(() => parseAnc(upTo(0), NUMBER)).toThrow(NoHistoryError);
  });

  it('reads the service\'s own 404s as not found, the booking it no longer keeps included', async () => {
    const cases = [{ message: `Delivery not found - ${NUMBER}` }, { message: 'CRITICAL: HUB job cannot be found 404, Unable to find requested booking/docket' }];
    for (const body of cases) {
      await expect(carrier(replying(() => reply(body, { status: 404 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('keeps another number\'s 404, a changed reply, a bot check, a moved service, a rate limit and an outage apart from a missing parcel', async () => {
    const stamped = fixture();
    stamped.statuses[0]!.timeDateStamp = '05/01/2026 06:58';
    const cases: [Response, string][] = [
      [reply({ message: 'Delivery not found - A00000002AA' }, { status: 404 }), 'transport'],
      [reply('<!DOCTYPE html><html><head><title>Error</title></head><body><pre>Cannot GET /deliveries/</pre></body></html>', { status: 404 }), 'transport'],
      [reply({ ...fixture(), statuses: null }), 'schema'],
      [reply(stamped), 'schema'],
      [reply('<html><body>not json</body></html>'), 'schema'],
      [reply('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [reply('', { status: 302, headers: { Location: 'https://ancdelivers.com.au/' } }), 'transport'],
      [reply('', { status: 429 }), 'rate_limited'],
      [reply('{"message":"Internal Server Error"}', { status: 500 }), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('recognizes a number the service holds, and not one it does not', async () => {
    await expect(carrier(replying(() => reply(fixture()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => reply({ message: `Delivery not found - ${NUMBER}` }, { status: 404 }))).recognize!(NUMBER))
      .resolves.toEqual({ known: false });
  });
});

describe('ANC status map', () => {
  it('stages every step title it lists, and the app reads it', () => {
    for (const { wording, stage } of statuses.entries) expect(statusMap.stage(null, wording.toLowerCase()), wording).toBe(stage);
    expect(statusMapAnswer({ carrier: 'anc-delivers', providerCode: null, description: 'Onboard for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
