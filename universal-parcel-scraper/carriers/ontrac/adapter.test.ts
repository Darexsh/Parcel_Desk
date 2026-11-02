import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adapter, OntracTracker } from './adapter.js';
import { normalizeOntracNumber, normalizeOntracRequest, parseOntrac } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import { classifyOntracStatus } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const NUMBER = '1LS0000000000001';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const payload = () => structuredClone(fixture);

describe('OnTrac direct tracking', () => {
  it('confirms the whole C-family number only from matching HTTP scans', async () => {
    const number = 'C00000000000001';
    const value = payload(); value.Packages[0].Tracking = number;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(number, { budgetMs: 1000 })).resolves.toEqual({ known: true, lastActivityAt: '2026-01-03T22:00:00.000Z' });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://webtrack.ontrac.com/PackageServices/tracking/${number}`);
    await expect(instance.recognize!('OTHER000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps missing resources and wrong identities as failed recognition probes', async () => {
    for (const response of [new Response('{}', { status: 404 }), new Response(JSON.stringify({ Packages: [] }))]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
      await expect(instance.recognize!('C00000000000001', { budgetMs: 1000 })).rejects.toMatchObject({
        kind: response.status === 404 ? 'indeterminate' : 'schema',
      });
    }
  });
  it('preserves offset scans and maps each code independently', () => {
    const result = parseOntrac(payload(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-03T14:00:00-08:00', expected_delivery: null });
    expect(result.events?.map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'registered']);
    expect(result.weight_kg).toBeCloseTo(0.90718474);
    expect(result.dimensions_text).toBe('12 × 8 × 5 in');
    for (const change of [{ Height: 0 }, { Width: null }, { Length: '12' }, { DimensionUnits: 'ft' }]) {
      const value = payload(); Object.assign(value.Packages[0], change);
      expect(parseOntrac(value, NUMBER)).not.toHaveProperty('dimensions_text');
    }
    const declared = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(declared.capabilities).toEqual(['history', 'estimated_delivery', 'weight', 'dimensions', 'canonical_tracking_number']);
    const inTransit = payload(); inTransit.Packages[0].Events.shift();
    expect(parseOntrac(inTransit, NUMBER).expected_delivery).toBe('2026-01-03T20:00:00-08:00');
  });
  it('resolves a shipper\'s AD reference to the one parcel OnTrac names by its own number', async () => {
    const result = parseOntrac(payload(), 'ad 000000001');
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: NUMBER, weight_kg: expect.any(Number) });
    expect(result.events).toHaveLength(3);
    expect(parseOntrac(payload(), NUMBER)).not.toHaveProperty('canonical_tracking_number');
    expect(() => parseOntrac({ Packages: [payload().Packages[0], { ...payload().Packages[0], Tracking: '1LS0000000000002' }] }, 'AD000000001'))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const value of [{ Packages: [] }, { Packages: [{ ...payload().Packages[0], Tracking: 'AD000000001' }] }, { Packages: [{ ...payload().Packages[0], Tracking: '' }] }]) {
      expect(() => parseOntrac(value, 'AD000000001')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(normalizeOntracRequest('ad-000000001')).toBe('AD000000001');
    for (const number of ['AD00000001', 'AD0000000001', 'AE000000001']) expect(() => normalizeOntracRequest(number)).toThrow(InvalidInputError);
    expect(() => normalizeOntracNumber('AD000000001')).toThrow(InvalidInputError);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(payload())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.track({ number: 'AD000000001' })).resolves.toMatchObject({ canonical_tracking_number: NUMBER });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://webtrack.ontrac.com/PackageServices/tracking/AD000000001');
  });
  it('rejects missing, wrong and ambiguous identities and empty histories', () => {
    for (const value of [null, {}, { Packages: [] }, { Packages: [{ ...payload().Packages[0], Tracking: '1LS0000000000002' }] }, { Packages: [payload().Packages[0], payload().Packages[0]] }]) {
      expect(() => parseOntrac(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const value = payload(); value.Packages[0].Events = [];
    expect(() => parseOntrac(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('keeps new wording undated and unmapped rather than inventing a stage', () => {
    const value = payload(); value.Packages[0].Events = [{ EventCode: 'NEW', EventShortDescription: 'New event', ZonedEventDateTime: '2026-01-03T14:00:00' }];
    expect(parseOntrac(value, NUMBER)).toMatchObject({ status: 'unknown', last_update: null,
      last_update_local: '2026-01-03T14:00:00', events: [{ description: 'New event', local_time: '2026-01-03T14:00:00' }] });
    expect(parseOntrac(value, NUMBER).events?.[0]).not.toHaveProperty('time');
    expect(parseOntrac(value, NUMBER).events?.[0]).not.toHaveProperty('stage');
  });
  it('keeps the newest unresolved delivery ahead of older timestamped scans', () => {
    const value = payload();
    value.Packages[0].Events[0].ZonedEventDateTime = '2026-01-03T14:00:00';
    const result = parseOntrac(value, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-01-03T14:00:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events?.map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'registered']);
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result.events?.[1]?.time).toBe('2026-01-03T08:00:00-08:00');
  });
  it('validates unresolved calendar digits and keeps distinct local scans', () => {
    const value = payload();
    const event = value.Packages[0].Events[0];
    value.Packages[0].Events = [
      { ...event, ZonedEventDateTime: '2026-01-03T14:00:00' },
      { ...event, ZonedEventDateTime: '2026-01-03T13:00:00' },
      { ...event, ZonedEventDateTime: '2026-01-03T14:00:00' },
    ];
    expect(parseOntrac(value, NUMBER).events?.map(e => e.local_time)).toEqual(['2026-01-03T14:00:00', '2026-01-03T13:00:00']);
    value.Packages[0].Events[0].ZonedEventDateTime = '2026-02-30T14:00:00';
    const result = parseOntrac(value, NUMBER);
    expect(result.last_update).toBeNull();
    expect(result.last_update_local).toBeNull();
    expect(result.events?.[0]).not.toHaveProperty('local_time');
    expect(result.events?.[0]).toHaveProperty('provider_time_text', '2026-02-30T14:00:00');
  });
  it('rejects malformed scans rather than presenting older delivery as current', () => {
    for (const scan of [null, { EventCode: 'NEW' }]) {
      const value = payload(); value.Packages[0].Events.unshift(scan);
      expect(() => parseOntrac(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });
  it.each([
    ['PU', 'The package was picked up', 'in_transit', 'accepted'],
    ['RL', 'Package received after cutoff', 'in_transit', 'accepted'],
    ['ALPK', 'Already picked up', 'in_transit', 'accepted'],
    ['RS', 'The package was returned to the sender', 'exception', 'returned'],
    ['UD', 'The contents of the package are damaged', 'exception', 'exception'],
    ['ONHD', 'Details needed. Please contact us', 'exception', 'exception'],
    ['NFRP', 'Order has been transferred to another carrier', 'in_transit', 'in_transit'],
  ])('interprets %s from its actual milestone rather than the portal presentation type', (code, description, status, stage) => {
    const value = payload();
    Object.assign(value.Packages[0].Events[0], { EventCode: code, EventShortDescription: description });
    const result = parseOntrac(value, NUMBER);
    expect(result).toMatchObject({ status, current_stage: stage, last_status_text: description });
    expect(result.events?.[0]).toMatchObject({ stage });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.expected_delivery).toBe('2026-01-03T20:00:00-08:00');
  });
  it('stages every code statuses.json records as the map does', () => {
    expect(statuses.entries.length).toBeGreaterThan(10);
    for (const entry of statuses.entries) expect(classifyOntracStatus(entry.code)?.stage, entry.code).toBe(entry.stage);
    // OnTrac's page calls the handoff delivered; the parcel is with another carrier.
    expect(classifyOntracStatus('NFRP')).toEqual({ status: 'in_transit', stage: 'in_transit' });
  });
  it('reads a delivery stopped for missing address details as a failed attempt', () => {
    const value = payload();
    Object.assign(value.Packages[0].Events[0], { EventCode: 'NDMI', EventShortDescription: 'Incomplete address. Please contact us' });
    const result = parseOntrac(value, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Incomplete address. Please contact us' });
    expect(result.events?.[0]).toMatchObject({ provider_code: 'NDMI', stage: 'failed_attempt' });
    expect(result).not.toHaveProperty('delivered_at');
  });
  it.each(['DSPD', 'RRDV', 'CTRF', 'PUKT', 'PURU'])('leaves generic or requested milestone %s unmapped', (code) => {
    const value = payload();
    Object.assign(value.Packages[0].Events[0], { EventCode: code, EventShortDescription: 'Provider request wording' });
    const result = parseOntrac(value, NUMBER);
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result.last_status_text).toBe('Provider request wording');
  });
  it('drops duplicate rows and never retains recipient or proof data', () => {
    const value = payload(); value.Packages[0].Events.push(value.Packages[0].Events[0]);
    const result = parseOntrac(value, NUMBER);
    expect(result.events).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/Private Recipient|Example Address|Private signature|secret-image|reference-secret|PostalCode/);
  });
  it('bounds requests, forwards cancellation and keeps generic missing-resource replies inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload())));
    const signal = new AbortController().signal;
    await new OntracTracker({ fetcher }).fetch(NUMBER, { signal, budgetMs: 1000 });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://webtrack.ontrac.com/PackageServices/tracking/${NUMBER}`);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ Title: 'Not Found', Status: 404 }), { status: 404 }));
    await expect(new OntracTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    fetcher.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(new OntracTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'maintenance' });
    expect(normalizeOntracNumber('1ls 0000000000001')).toBe(NUMBER);
    expect(() => normalizeOntracNumber('123')).toThrow(InvalidInputError);
  });
  it('preserves the upstream throttle window and rejection diagnostics', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Too many requests', {
      status: 429, headers: { 'Retry-After': '7200', 'Content-Type': 'text/plain' },
    }));
    await expect(new OntracTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({
      kind: 'rate_limited', retryAfterMs: 7_200_000,
      diagnostics: { body_signals: ['rate_limit_message'] },
      request: { method: 'GET', url: `https://webtrack.ontrac.com/PackageServices/tracking/${NUMBER}` },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
