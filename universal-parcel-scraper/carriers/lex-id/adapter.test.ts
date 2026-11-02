import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { lexSearchUrl } from './lex.js';
import { LEX_ID, normalizeLexIdNumber, parseLexIdSearch } from './parser.js';
import { lexStatus, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'LXAD0000000001';
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const withStatus = (packageStatus: string) => {
  const body = fixture('found') as { data: Record<string, unknown>[] };
  body.data[0]!.packageStatus = packageStatus;
  return body;
};

describe('LEX Indonesia numbers', () => {
  it('takes LXAD and ten digits, with or without the hyphen, and asks with it', () => {
    for (const raw of [NUMBER, 'LXAD-0000000001', 'lxad 0000000001']) expect(normalizeLexIdNumber(raw), raw).toBe('LXAD-0000000001');
    for (const raw of ['LXAD000000001', 'LXST0000000001', 'TMYLE000000001', '']) expect(() => normalizeLexIdNumber(raw), raw).toThrow('LXAD and ten digits');
  });

  it('refuses another shape before asking', async () => {
    const fetcher = replying(() => json(fixture('found')));
    await expect(carrier(fetcher).track({ number: 'LXAD1' })).rejects.toThrow(InvalidInputError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('LEX Indonesia tracking', () => {
  it('posts the hyphenated number to the open search once', async () => {
    const fetcher = replying(() => json(fixture('found')));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://lex.co.id/api/search_packages');
    expect(lexSearchUrl(LEX_ID)).toBe(url);
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init!.body))).toEqual({ trackingNumbers: ['LXAD-0000000001'] });
  });

  it('reads the current status alone, so that providers are still asked for the history', () => {
    expect(parseLexIdSearch(fixture('found'), NUMBER)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'domestic_delivered',
      last_status_text: 'Delivered', last_update: null, expected_delivery: null, timezone: 'Asia/Jakarta', summary_only: true, events: [],
    });
    expect(JSON.stringify(parseLexIdSearch(fixture('found'), NUMBER))).not.toContain('FU0000');
  });

  it('stages a lost or returned package, names a status without a stage and keeps an unknown key', () => {
    expect(parseLexIdSearch(withStatus('package_lost'), NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Lost by delivery partner' });
    expect(parseLexIdSearch(withStatus('domestic_package_returned'), NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned' });
    const assigned = parseLexIdSearch(withStatus('driver_assigned'), NUMBER);
    expect(assigned).toMatchObject({ status: 'unknown', last_status_text: 'Driver assigned', provider_code: 'driver_assigned' });
    expect(assigned.current_stage).toBeUndefined();
    expect(parseLexIdSearch(withStatus('domestic_synthetic_status'), NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'domestic_synthetic_status' });
  });

  it('reads an empty list as not found', async () => {
    await expect(carrier(replying(() => json(fixture('empty')))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps another number, a changed reply, a bot check, a moved route, a rate limit and an outage apart from a missing parcel', async () => {
    const other = fixture('found') as { data: Record<string, unknown>[] };
    other.data[0]!.trackingNumber = 'LXAD-0000000002';
    other.data[0]!.originalTrackingNumber = 'LXAD-0000000002';
    const cases: [Response, string][] = [
      [json(other), 'indeterminate'],
      [json({ success: false, data: [] }), 'schema'],
      [json(withStatus('Delivered!')), 'schema'],
      [json('<html><body>not json</body></html>'), 'schema'],
      [json({ ret: ['FAIL_SYS_USER_VALIDATE'], data: { url: 'https://lex.co.id/_____tmd_____/punish?x5secdata=synthetic' } }), 'challenge'],
      [json('', { status: 302, headers: { Location: 'https://lex.co.id/' } }), 'transport'],
      [json('', { status: 404 }), 'transport'],
      [json('', { status: 429 }), 'rate_limited'],
      [json('{"status":500,"error":"Internal Server Error"}', { status: 500 }), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('recognizes a number the search holds, and not one it does not', async () => {
    await expect(carrier(replying(() => json(fixture('found')))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => json(fixture('empty')))).recognize!(NUMBER)).resolves.toEqual({ known: false });
  });
});

describe('LEX status map', () => {
  it('stages every key it lists by the key, and the app reads it', () => {
    for (const { code, stage, wording } of statuses.entries) {
      expect(statusMap.stage(code, wording), code).toBe(stage);
      expect(lexStatus(code), code).toEqual({ stage, title: wording });
    }
    expect(statusMapAnswer({ carrier: 'lex-id', providerCode: 'domestic_out_for_delivery', description: 'Out for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    // A title shared by keys of different stages stages nothing alone.
    expect(statusMap.stage(null, 'out for delivery')).toBeUndefined();
  });
});
