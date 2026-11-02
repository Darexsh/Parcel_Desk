import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { LBC_MOBILE_API, parseLbcMobile } from './mobile.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '100000000001';
const xml = () => readFileSync(new URL('./fixtures/mobile.xml', import.meta.url), 'utf8');
const instance = (fetcher: typeof fetch) => adapter({
  fetcher, env: {}, browserExecutablePath: null, trawl: null, recorder: NOOP_RECORDER, userAgent: 'Host/1.0',
});

describe('LBC mobile history', () => {
  it('binds identity, keeps newest-first local clocks and discards recipient and internal data', () => {
    const result = parseLbcMobile(xml(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-10-02T15:40:01' });
    expect(result.events).toHaveLength(3);
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'accepted']);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-10-02T15:40:01', provider_code: '1' });
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SYNTHETIC RECIPIENT/);
  });
  it.each(['wrong identity', 'duplicate identity', 'missing identity', 'wrong namespace', 'malformed XML', 'DTD', 'nested text', 'bad clock'])('rejects %s without exposing raw XML', mode => {
    let body = xml();
    if (mode === 'wrong identity') body = body.replace(NUMBER, '100000000002');
    if (mode === 'duplicate identity') body = body.replace('</TrackingNo>', '</TrackingNo><TrackingNo>100000000001</TrackingNo>');
    if (mode === 'missing identity') body = body.replace(/<TrackingNo>.*?<\/TrackingNo>/, '');
    if (mode === 'wrong namespace') body = body.replace('http://tempuri.org/', 'https://other.example/');
    if (mode === 'malformed XML') body = body.replace('</TrackingStatus>', '</Other>');
    if (mode === 'DTD') body = body.replace('<soap:Envelope', '<!DOCTYPE soap:Envelope [<!ENTITY private "PRIVATE">]><soap:Envelope');
    if (mode === 'nested text') body = body.replace(NUMBER, `<Other>${NUMBER}</Other>`);
    if (mode === 'bad clock') body = body.replace('9:15:20 AM', '29:15:20 AM');
    let error: unknown;
    try { parseLbcMobile(body, NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'schema' });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain('PRIVATE');
  });
  it('deduplicates scans and keeps absent times date-only', () => {
    const body = xml().replace(/<DatePostedTime>.*?<\/DatePostedTime>/g, '');
    const result = parseLbcMobile(body, NUMBER);
    expect(result.events?.every(event => !event.local_time && !event.time)).toBe(true);
    expect(result.last_update_local).toBeUndefined();
    const row = /<TrackingHistory>\s*<StatusId>1<\/StatusId>[\s\S]*?<\/TrackingHistory>/.exec(xml())![0];
    expect(parseLbcMobile(xml().replace(row, row + row), NUMBER).events).toHaveLength(3);
  });
  it('leaves unknown codes unresolved and redacts delivery names', () => {
    const result = parseLbcMobile(xml().replace('<StatusId>1</StatusId>', '<StatusId>99999</StatusId>'), NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Delivery update' });
    expect(result.current_stage).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('reads code 0 by its wording, places branch scans and keeps names out of releases', () => {
    const scan = (code: string, day: string, time: string, wording: string, town = '', province = '') =>
      `<TrackingHistory><StatusId>${code}</StatusId><DatePosted>${day}</DatePosted><DatePostedTime>${time}</DatePostedTime>`
      + `<StatusandLocation>${wording}</StatusandLocation><CityName>${town}</CityName><ProvinceName>${province}</ProvinceName>`
      + '<Lat>0</Lat><Long>0</Long><Branch><BranchDescr>PRIVATE SYNTHETIC BRANCH</BranchDescr></Branch></TrackingHistory>';
    const history = [
      scan('0', '10/1/2026', '7:00:00 AM', 'PICKED UP BY LBC'),
      scan('0', '10/1/2026', '8:00:00 AM', 'Shipment has been received at  SYNTHETIC BRANCH.', 'EXAMPLE TOWN', 'EXAMPLE PROVINCE'),
      scan('8000', '10/1/2026', '9:15:20 AM', 'Shipment has been accepted at SYNTHETIC BRANCH.', 'EXAMPLE TOWN', 'EXAMPLE PROVINCE'),
      scan('0', '10/1/2026', '11:00:00 PM', 'Shipment is en route to SYNTHETIC TEAM. Next update for this shipment will come within 1 day/s.', 'OTHER TOWN', 'OTHER PROVINCE'),
      scan('8820', '10/1/2026', '11:30:00 PM', 'Shipment is en route to SYNTHETIC TEAM. Next update for this shipment will come within 1 day/s.', 'OTHER TOWN', 'OTHER PROVINCE'),
      scan('0', '10/2/2026', '5:00:00 AM', 'Shipment has been received at SYNTHETIC TEAM.', 'OTHER TOWN', 'OTHER PROVINCE'),
      scan('0', '10/2/2026', '6:00:00 AM', 'Shipment has been received at COURIER EXCHANGE.', '', 'OTHER PROVINCE'),
      scan('5', '10/2/2026', '3:40:01 PM', 'Released to authorized representative PRIVATE SYNTHETIC PERSON 10/02/2026.', 'OTHER TOWN', 'OTHER PROVINCE'),
    ].join('');
    const body = xml().replace(/<TrackingHistory>\s*<TrackingHistory>[\s\S]*<\/TrackingHistory>\s*<\/TrackingHistory>/, `<TrackingHistory>${history}</TrackingHistory>`);
    const result = parseLbcMobile(body, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Released to authorized representative' });
    expect(result.events?.map(event => [event.provider_code, event.stage, event.location])).toEqual([
      ['5', 'delivered', 'OTHER TOWN, OTHER PROVINCE'],
      ['0', 'in_transit', 'OTHER PROVINCE'],
      ['0', 'in_transit', 'OTHER TOWN, OTHER PROVINCE'],
      ['8820', 'in_transit', undefined],
      ['0', 'in_transit', undefined],
      ['8000', 'accepted', 'EXAMPLE TOWN, EXAMPLE PROVINCE'],
      ['0', 'in_transit', 'EXAMPLE TOWN, EXAMPLE PROVINCE'],
      ['0', 'accepted', undefined],
    ]);
    expect(parseLbcMobile(body.replace('<StatusId>5</StatusId>', '<StatusId>0</StatusId>'), NUMBER))
      .toMatchObject({ status: 'delivered', last_status_text: 'Released to authorized representative' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Lat|Long/);
    for (const entry of statuses.entries.filter(entry => 'code' in entry)) {
      const row = `<TrackingHistory><StatusId>${entry.code}</StatusId><DatePosted>10/1/2026</DatePosted><StatusandLocation>${entry.wording}</StatusandLocation></TrackingHistory>`;
      const single = xml().replace(/<TrackingHistory>\s*<TrackingHistory>[\s\S]*<\/TrackingHistory>\s*<\/TrackingHistory>/, `<TrackingHistory>${row}</TrackingHistory>`);
      expect(parseLbcMobile(single, NUMBER).events?.[0]?.stage, entry.wording).toBe(entry.stage);
    }
  });
  it.each(['remittance', 'empty history', 'SOAP fault'])('keeps %s inconclusive', mode => {
    let body = xml();
    if (mode === 'remittance') body = body.replace('<StatusCode>0001</StatusCode>', '<StatusCode>103</StatusCode>');
    if (mode === 'empty history') body = body.replace(/<TrackingHistory>[\s\S]*<\/TrackingHistory>/, '<TrackingHistory/>');
    if (mode === 'SOAP fault') body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>PRIVATE</faultstring></s:Fault></s:Body></s:Envelope>';
    expect(() => parseLbcMobile(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});

describe('LBC direct transport', () => {
  it('uses the built-in key without a browser and honors the supplied fetch, signal, budget and user agent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(xml()));
    const launch = vi.spyOn(chromium, 'launch');
    try {
      const result = await instance(fetcher).track({ number: NUMBER }, { budgetMs: 5000 });
      expect(result.current_stage).toBe('delivered');
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe(LBC_MOBILE_API);
      expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), cache: 'no-store', redirect: 'error' });
      expect(new Headers(init?.headers).get('lbcOAKey')).toMatch(/^[a-f\d]{32}$/i);
      expect(new Headers(init?.headers).get('user-agent')).toBe('Host/1.0');
      expect(new Headers(init?.headers).get('soapaction')).toBe('http://tempuri.org/LBCTrackAndTrace');
      expect(init?.body).toContain(`<TrackingNo>${NUMBER}</TrackingNo>`);
      expect(launch).not.toHaveBeenCalled();
    } finally { launch.mockRestore(); }
  });
  it.each([401, 403, 404, 410, 429, 503])('keeps HTTP %s distinct from shipment absence', async status => {
    const fetcher: typeof fetch = async () => new Response('', { status });
    await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind:
      [401, 403].includes(status) ? 'challenge' : [404, 410].includes(status) ? 'transport' : status === 429 ? 'rate_limited' : 'maintenance',
    });
  });
  it('recognizes blocked HTML 200 and bounds excessive replies', async () => {
    await expect(instance(async () => new Response('<html>Cloudflare challenge</html>')).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(instance(async () => new Response('x'.repeat(1_000_001))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
  it.each([200, 403])('classifies an explicit Cloudflare origin error under HTTP %s without blaming the key', async status => {
    const html = '<html><title>DNS points to prohibited IP | tracking.example | Cloudflare</title>'
      + '<h1>Error 1000</h1><p>PRIVATE SYNTHETIC DIAGNOSTICS</p></html>';
    const error: unknown = await instance(async () => new Response(html, { status })).track({ number: NUMBER }).catch(caught => caught);
    expect(error).toMatchObject({ kind: 'transport' });
    expect((error as { status?: number }).status).toBe(status >= 400 ? status : undefined);
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|tracking\.example/);
  });
  it.each(['network', 'rate limit', 'body read'])('sanitizes %s failure data while retaining its classification', async mode => {
    let key = '';
    const fetcher: typeof fetch = async (_url, init) => {
      key = new Headers(init?.headers).get('lbcOAKey') ?? '';
      const privateData = `PRIVATE RECIPIENT ${NUMBER} ${key}`;
      if (mode === 'network') throw new Error(privateData);
      if (mode === 'rate limit') return new Response(privateData, { status: 429, headers: { 'Retry-After': '60' } });
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateData)); } }));
    };
    const error: unknown = await instance(fetcher).track({ number: NUMBER }).catch(caught => caught);
    expect(error).toMatchObject({ kind: mode === 'rate limit' ? 'rate_limited' : 'transport',
      ...(mode === 'rate limit' ? { status: 429, retryAfterMs: 60_000 } : {}),
    });
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('diagnostics');
    expect((error as Error).cause).toBeUndefined();
    expect(key).not.toBe('');
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|100000000001/);
    expect(JSON.stringify(error)).not.toContain(key);
  });
  it('starts no request for invalid or pre-aborted input', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => instance(fetcher).track({ number: 'bad' })).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    await expect(instance(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
