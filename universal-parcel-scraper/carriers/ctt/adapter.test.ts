import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchemaError, InvalidInputError } from '../../core/errors/index.js';
import {
  normalizeCttTrackingNumber,
  cttTrackingUrl,
  parseCttTrackingResponse,
  CttTracker,
  CttMaintenanceError,
} from './adapter.js';
import { classifyCttStatus } from './status.js';

// All identifiers and timestamps below are synthetic. Portuguese status labels
// reuse the vendor's fixed texts observed live on a delivered parcel, so
// classification exercises production wording rather than paraphrases.
const TRACKING_NUMBER = 'RL000000005PT';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;
const SCREEN_SCRIPT = [
  'callDataAction("DataActionGetObjectEventsByInputObjectCode", "screenservices/x", "apiv-track-1", function (b) {}',
  'callDataAction("DataActionCheckIPLocked", "screenservices/x", "apiv-maint-1", function (b) {}',
].join('\n');

function record(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(DELIVERED), ...overrides };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface CttScenario {
  record?: Record<string, unknown> | null;
  maintenance?: unknown;
  staleFirst?: boolean;
  noCookie?: boolean;
  calls?: string[];
}

/** Programmable stand-in for the OutSystems session flow. */
function mockCttFlow(scenario: CttScenario) {
  const calls: string[] = [];
  scenario.calls = calls;
  let trackCalls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (url.includes('moduleversioninfo')) return jsonResponse({ versionToken: 'mv-1' });
    if (url.includes('moduleinfo')) {
      return jsonResponse({ manifest: { urlVersions: { '/CustomerArea/scripts/CustomerArea.CustomerArea.PublicArea_Detail.mvc.js': '?s-1' } } });
    }
    if (url.includes('.mvc.js')) return new Response(SCREEN_SCRIPT, { headers: { 'Content-Type': 'application/javascript' } });
    if (url.includes('DataActionCheckIPLocked')) {
      return jsonResponse({ data: { IsMaintenance: scenario.maintenance ?? false }, versionInfo: {} });
    }
    if (url.includes('DataActionGetObjectEventsByInputObjectCode')) {
      trackCalls += 1;
      const headers = new Headers(init?.headers);
      if (!headers.get('Cookie')) {
        if (scenario.noCookie) return new Response('{}', { status: 403 });
        return new Response('{}', {
          status: 403,
          headers: { 'Set-Cookie': 'nr2Users=crf%3dTOKEN123%3buid%3d0%3bunm%3d; Path=/' },
        });
      }
      if (headers.get('X-CSRFToken') !== 'TOKEN123') {
        return new Response('{}', { status: 403 });
      }
      if (scenario.staleFirst && trackCalls === 2) {
        return jsonResponse({ versionInfo: { hasModuleVersionChanged: false, hasApiVersionChanged: true }, data: {} });
      }
      return jsonResponse({
        versionInfo: { hasModuleVersionChanged: false, hasApiVersionChanged: false },
        data: { ObjectEventsFromQuery: scenario.record === undefined ? record() : scenario.record },
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
  return { trackCalls: () => trackCalls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CTT tracking normalization', () => {
  it('accepts checksum-valid S10 numbers, mail from abroad included, and rejects the rest', () => {
    expect(normalizeCttTrackingNumber('rl000000005pt')).toBe(TRACKING_NUMBER);
    expect(normalizeCttTrackingNumber('RL402552798PT')).toBe('RL402552798PT');
    expect(normalizeCttTrackingNumber('LT 000 000 005 GB')).toBe('LT000000005GB');
    for (const raw of ['RL000000006PT', 'LT000000006GB', 'LT000000005G1', '12345', '']) {
      expect(() => normalizeCttTrackingNumber(raw)).toThrow(InvalidInputError);
    }
    expect(cttTrackingUrl(TRACKING_NUMBER)).toBe(
      'https://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects=RL000000005PT',
    );
  });
});

describe('CTT response parsing', () => {
  it('returns delivered history newest-first with identity binding', () => {
    const result = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record() } }, TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered parcel',
      last_update: '2026-01-04T14:46:00+00:00',
      expected_delivery: null,
    });
    expect(result.events?.map((event) => [event.description, event.stage, event.time])).toEqual([
      ['Delivered parcel', 'delivered', '2026-01-04T14:46:00+00:00'],
      ['Shipment accepted', 'accepted', '2026-01-01T08:00:00+00:00'],
    ]);
  });

  describe('scan clocks', () => {
    /** The clock of one scan of a parcel for `recipient`, as the result keeps it. */
    function scanAt(DateTime: string, Local: string, EventCode = 'EMB', recipient = 'PT') {
      const [scan] = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({ RecipientCountryCode: recipient,
        Events: { List: [{ DateTime, State: 'X', StateId: 11, Event: 'Wording', EventCode, Local }] } }) } }, TRACKING_NUMBER).events!;
      return scan!.time ?? `local ${String(scan!.local_time)}`;
    }

    it("reads CTT's Z as the wall clock of the Portuguese site that scanned", () => {
      expect(scanAt('2026-08-31T20:53:13Z', 'PTEXAA - (OUTRO) EXAMPLE')).toBe('2026-08-31T20:53:13+01:00');
      expect(scanAt('2026-08-29T11:46:23Z', 'Centro operacional Example')).toBe('2026-08-29T11:46:23+01:00');
      expect(scanAt('2026-08-28T10:34:52Z', '0000000 - (PC) Ponto CTT Example 2000')).toBe('2026-08-28T10:34:52+01:00');
      // The Azores keep an hour less, by postcode or by a town only the islands have.
      expect(scanAt('2026-08-28T10:34:52Z', 'Centro operacional 9580 Example')).toBe('2026-08-28T10:34:52+00:00');
      expect(scanAt('2026-08-28T10:34:52Z', 'Loja CTT Ponta Delgada')).toBe('2026-08-28T10:34:52+00:00');
      // An unlocated scan of a parcel that stays in Portugal is CTT's.
      expect(scanAt('2026-08-28T10:13:58Z', '', 'EMO')).toBe('2026-08-28T10:13:58+01:00');
    });

    it("reads a partner post's scans of a parcel abroad on the destination's clock, or keeps CTT's Z", () => {
      expect(scanAt('2026-08-04T13:29:00Z', '12345', 'EDG', 'IT')).toBe('2026-08-04T13:29:00+02:00');
      expect(scanAt('2026-08-04T14:46:00Z', 'EX12345', 'EMI', 'IT')).toBe('2026-08-04T14:46:00+02:00');
      // In a destination with several clocks only a scan sent without Z stays a wall time.
      expect(scanAt('2026-08-04T13:29:00Z', '12345', 'EDG', 'US')).toBe('2026-08-04T13:29:00Z');
      expect(scanAt('2026-08-04T13:29:00', '12345', 'EDG', 'US')).toBe('local 2026-08-04T13:29:00');
      // CTT's own scans of the same parcel stay on Portugal's clock.
      expect(scanAt('2026-08-01T11:10:15Z', 'PTEXAA - (OUTRO) EXAMPLE', 'EMC', 'IT')).toBe('2026-08-01T11:10:15+01:00');
      expect(scanAt('2026-08-01T10:13:58Z', '', 'EMO', 'IT')).toBe('2026-08-01T10:13:58+01:00');
    });

    it("reads the origin post's scans of mail from abroad on the origin's clock", () => {
      /** The clock of one scan of an inbound item issued in `issuer`, as the result keeps it. */
      function inboundAt(DateTime: string, Local: string, EventCode: string, issuer: string, SenderCountryCode = '') {
        const number = `LT000000005${issuer}`;
        const [scan] = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({ ObjectCode: number,
          RecipientCountryCode: 'PT', SenderCountryCode,
          Events: { List: [{ DateTime, State: 'X', StateId: 11, Event: 'Wording', EventCode, Local }] } }) } }, number).events!;
        return scan!.time ?? `local ${String(scan!.local_time)}`;
      }
      // Posting and export: the country that issued the number, or the sender's when the record names one.
      expect(inboundAt('2026-10-06T17:53:00Z', 'EXAMPLE MC', 'EMA', 'CN')).toBe('2026-10-06T17:53:00+08:00');
      expect(inboundAt('2026-10-07T06:32:00Z', 'CNEXAA - (OUTRO) EXAMPLE', 'EMC', 'CN')).toBe('2026-10-07T06:32:00+08:00');
      expect(inboundAt('2026-10-06T17:53:00Z', 'EXAMPLE MC', 'EMA', 'CN', 'JP')).toBe('2026-10-06T17:53:00+09:00');
      // An origin with several clocks keeps CTT's Z.
      expect(inboundAt('2026-10-06T17:53:00Z', 'EXAMPLE MC', 'EMA', 'US')).toBe('2026-10-06T17:53:00Z');
      // Arrival, customs and delivery in Portugal are CTT's.
      expect(inboundAt('2026-10-12T07:13:04Z', 'PTEXAB - (OUTRO) EXAMPLE', 'EMD', 'CN')).toBe('2026-10-12T07:13:04+01:00');
      expect(inboundAt('2026-10-12T08:37:39Z', 'PTEXAE - (CTC) EXAMPLE', 'EDB', 'CN')).toBe('2026-10-12T08:37:39+01:00');
    });

    it("reads a CTT Express agency's scans and the acceptance just before them on Madrid's clock", () => {
      const result = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({ RecipientCountryCode: 'PT',
        Events: { List: [
          { DateTime: '2026-10-21T09:18:36Z', State: 'X', StateId: 7, Event: 'Out for delivery', EventCode: 'EMZ', Local: '0000000 - (CO) C.O. EXAMPLE' },
          { DateTime: '2026-10-20T19:12:27Z', State: 'X', StateId: 11, Event: 'Arrived', EventCode: 'EMB', Local: '009999 - (PL) CENTRO DE TRATAMIENTO ADUANERO' },
          { DateTime: '2026-10-20T19:12:26Z', State: 'X', StateId: 2, Event: 'Accepted', EventCode: 'EMA', Local: '' },
          { DateTime: '2026-10-08T11:04:51Z', State: 'X', StateId: 1, Event: 'Information received', EventCode: 'EMO', Local: '' },
        ] } }) } }, TRACKING_NUMBER);
      expect(result.events?.map((event) => [event.description, event.time])).toEqual([
        ['Out for delivery', '2026-10-21T09:18:36+01:00'],
        ['Arrived', '2026-10-20T19:12:27+02:00'],
        ['Accepted', '2026-10-20T19:12:26+02:00'],
        ['Information received', '2026-10-08T11:04:51+01:00'],
      ]);
      // The shipment record CTT Express sends, which CTT places in Madrid, keeps Madrid's clock too.
      expect(scanAt('2026-10-08T09:55:27Z', 'Madrid')).toBe('2026-10-08T09:55:27+02:00');
      // A code of CTT's own sites, or a Ponto CTT, stays on Portugal's clock.
      expect(scanAt('2026-10-20T19:12:27Z', '000000 - (PC) Ponto CTT Example')).toBe('2026-10-20T19:12:27+01:00');
      expect(scanAt('2026-10-20T19:12:27Z', '0099999 - (CO) C.O. EXAMPLE')).toBe('2026-10-20T19:12:27+01:00');
    });

    it('drops a bare office code as a place but keeps it for the clock', () => {
      const number = 'LT000000005ES';
      const result = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({ ObjectCode: number, RecipientCountryCode: 'PT',
        Events: { List: [
          { DateTime: '2026-10-24T03:46:00Z', State: 'X', StateId: 11, Event: 'Forwarded', EventCode: 'EMC', Local: 'ESEXAA - (OUTRO) EXAMPLE AP' },
          { DateTime: '2026-10-23T18:22:00Z', State: 'X', StateId: 2, Event: 'Accepted', EventCode: 'EMA', Local: '9999999' },
          { DateTime: '2026-10-25T10:00:00Z', State: 'X', StateId: 11, Event: 'Arrived', EventCode: 'EMD', Local: '9500' },
        ] } }) } }, number);
      expect(result.events?.map((event) => [event.description, event.location, event.time])).toEqual([
        // An Azores postcode still sets the clock.
        ['Arrived', '', '2026-10-25T10:00:00-01:00'],
        ['Forwarded', 'ESEXAA - (OUTRO) EXAMPLE AP', '2026-10-24T03:46:00+02:00'],
        ['Accepted', '', '2026-10-23T18:22:00+02:00'],
      ]);
    });

    it('takes any other offset as sent and orders wall times among instants', () => {
      expect(scanAt('2026-08-01T10:00:00+02:00', '12345', 'EDG', 'US')).toBe('2026-08-01T10:00:00+02:00');
      const result = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({ RecipientCountryCode: 'US',
        Events: { List: [
          { DateTime: '2026-08-01T10:00:00Z', State: 'X', StateId: 2, Event: 'Accepted', EventCode: 'EMA', Local: 'Loja CTT Example' },
          { DateTime: '2026-08-09T09:00:00', State: 'X', StateId: 12, Event: 'Delivered parcel', EventCode: 'EMI', Local: '' },
        ] } }) } }, TRACKING_NUMBER);
      expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-08-09T09:00:00' });
      expect(result.events?.map((event) => event.description)).toEqual(['Delivered parcel', 'Accepted']);
    });
  });

  it('maps every documented StateId and reports unmapped ones as unknown', () => {
    const cases: Array<[number, string, string]> = [
      [1, 'pending', 'registered'],
      [2, 'in_transit', 'accepted'],
      [5, 'exception', 'returned'],
      [7, 'out_for_delivery', 'out_for_delivery'],
      [8, 'in_transit', 'in_transit'],
      [10, 'in_transit', 'customs'],
      [11, 'in_transit', 'in_transit'],
      [12, 'delivered', 'delivered'],
      [13, 'exception', 'failed_attempt'],
      [14, 'out_for_delivery', 'ready_for_pickup'],
    ];
    for (const [stateId, status, stage] of cases) {
      expect(classifyCttStatus(stateId)).toEqual({ status, stage });
      const result = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({
        Events: { List: [{ DateTime: '2026-01-04T14:46:00+00:00', State: 'X', StateId: stateId, Event: 'Wording', EventCode: 'EXX', Local: '' }] },
      }) } }, TRACKING_NUMBER);
      expect(result).toMatchObject({ status, current_stage: stage });
    }
    expect(classifyCttStatus(99)).toBeUndefined();
    const unknown = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({
      Events: { List: [{ DateTime: '2026-01-04T14:46:00+00:00', State: 'X', StateId: 99, Event: 'New wording', EventCode: 'EXX', Local: '' }] },
    }) } }, TRACKING_NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'New wording' });
    // No explicit mapping means no stage at all: the sync classifies the raw
    // wording and records where the final stage came from.
    expect(unknown.events?.[0]).toMatchObject({ description: 'New wording', provider_code: '99' });
    expect(unknown.events?.[0]?.stage).toBeUndefined();
  });

  it('binds the ObjectCode echo and rejects malformed envelopes', () => {
    expect(() => parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({ ObjectCode: 'RL000000006PT' }) } }, TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({ ObjectCode: undefined }) } }, TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({ Events: {} }) } }, TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCttTrackingResponse({ data: {} }, TRACKING_NUMBER)).toThrow(SchemaError);
    expect(() => parseCttTrackingResponse(null, TRACKING_NUMBER)).toThrow(SchemaError);
  });

  it('skips unusable rows without losing the shipment', () => {
    const result = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record({
      Events: { List: [
        { DateTime: '2026-01-04T14:46:00Z', State: 'Entregue', StateId: 12, Event: 'Delivered parcel', EventCode: 'EMI', Local: 'Test Depot' },
        { DateTime: '2026-01-04T14:46:00Z', State: 'Entregue', StateId: 12, Event: 'Delivered parcel', EventCode: 'EMI', Local: 'Test Depot' },
        { DateTime: 'not a date', State: 'X', StateId: 12, Event: 'Broken time', EventCode: 'EMI', Local: '' },
        // Empty wording falls back to the State label, so this row survives.
        { DateTime: '2026-01-03T10:00:00Z', State: 'Em trânsito', StateId: 11, Event: '', EventCode: 'EMC', Local: '' },
        'not a record',
      ] },
    }) } }, TRACKING_NUMBER);
    expect(result.events?.map((event) => event.description)).toEqual(['Delivered parcel', 'Em trânsito']);
  });

  it('never retains sender or recipient identity blocks', () => {
    const result = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record() } }, TRACKING_NUMBER);
    const serialized = JSON.stringify(result);
    for (const secret of [
      'Secret Sender', 'Secret Recipient', 'Secret Receptor', 'sender@example.invalid',
      '1 Example Street', 'SenderEmail', 'RecipientAddress', 'ReceptorName',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('produces every capability carrier.json declares', () => {
    const result = parseCttTrackingResponse({ data: { ObjectEventsFromQuery: record() } }, TRACKING_NUMBER);
    expect(CAPABILITIES).toEqual(['history', 'location', 'provider_code']);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
  });
});

describe('CttTracker fetch', () => {
  it('bootstraps the session from the 403 cookie and binds the record', async () => {
    const scenario: CttScenario = {};
    mockCttFlow(scenario);
    const result = await new CttTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER);
    expect(result.status).toBe('delivered');
    expect(scenario.calls?.filter((call) => call.includes('DataActionGetObjectEventsByInputObjectCode'))).toHaveLength(2);
    expect(scenario.calls?.some((call) => call.includes('moduleversioninfo'))).toBe(true);
  });

  it('reports genuine not-found only after the maintenance check clears', async () => {
    const scenario: CttScenario = { record: { ObjectCode: TRACKING_NUMBER, Found: false, Events: { List: [] } }, maintenance: false };
    mockCttFlow(scenario);
    await expect(new CttTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'NotFoundError', status: 404, message: 'CTT could not locate the shipment' });
    expect(scenario.calls?.some((call) => call.includes('DataActionCheckIPLocked'))).toBe(true);
  });

  it('turns a maintenance outage into a retryable error instead of not-found', async () => {
    mockCttFlow({ record: { ObjectCode: TRACKING_NUMBER, Found: false, Events: { List: [] } }, maintenance: true });
    await expect(new CttTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toBeInstanceOf(CttMaintenanceError);
  });

  it.each([null, {}, { Found: 'false' }])('keeps an incomplete tracking response inconclusive (%j)', async (record) => {
    const scenario: CttScenario = { record };
    mockCttFlow(scenario);
    await expect(new CttTracker().fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(scenario.calls?.some((call) => call.includes('DataActionCheckIPLocked'))).toBe(false);
  });

  it('requires an explicit healthy answer from the maintenance check before reporting not-found', async () => {
    mockCttFlow({ record: { Found: false }, maintenance: 'false' });
    await expect(new CttTracker().fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each(['moduleversioninfo', 'moduleinfo?', '.mvc.js', 'DataActionGetObjectEventsByInputObjectCode', 'DataActionCheckIPLocked'])(
    'retries a transient HTTP failure at %s without losing session state', async (endpoint) => {
      vi.useFakeTimers();
      mockCttFlow({ record: { Found: false } });
      let rejected = false;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        if (!rejected && String(input).includes(endpoint)
          && (!endpoint.startsWith('DataAction') || new Headers(init?.headers).has('Cookie') || endpoint === 'DataActionCheckIPLocked')) {
          rejected = true;
          return jsonResponse({}, 503);
        }
        return fetch(input, init);
      });
      const failure = expect(new CttTracker({ fetcher }).fetch(TRACKING_NUMBER))
        .rejects.toMatchObject({ kind: 'not_found', status: 404 });
      await vi.advanceTimersByTimeAsync(1_000);
      await failure;
      expect(rejected).toBe(true);
      const attempts = fetcher.mock.calls.filter(([input]) => String(input).includes(endpoint));
      const successfulRetry = attempts.at(-1)!;
      const rejectedAttempt = attempts.at(-2)!;
      expect(successfulRetry[1]?.body).toBe(rejectedAttempt[1]?.body);
      expect(successfulRetry[1]?.headers).toEqual(rejectedAttempt[1]?.headers);
    },
  );

  it('preserves maintenance diagnostics and Retry-After without treating the outage as a missing parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Service maintenance', {
      status: 503, headers: { 'Content-Type': 'text/plain', 'Retry-After': '120' },
    }));
    await expect(new CttTracker({ fetcher }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({
      kind: 'maintenance', status: 503, retryAfterMs: 120_000,
      diagnostics: { body_excerpt: 'Service maintenance' },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('re-derives rotated version tokens once and fails bootstrap loops fast', async () => {
    const scenario: CttScenario = { staleFirst: true };
    mockCttFlow(scenario);
    const result = await new CttTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER);
    expect(result.status).toBe('delivered');
    expect(scenario.calls?.filter((call) => call.includes('moduleversioninfo'))).toHaveLength(2);
    mockCttFlow({ noCookie: true });
    await expect(new CttTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow('anonymous session bootstrap failed');
  });

  it('surfaces transport and input failures distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(new CttTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    expect(() => new CttTracker({ timeoutMs: 0 })).toThrow(TypeError);
    await expect(new CttTracker({ timeoutMs: 1_000 }).fetch('nope'))
      .rejects.toThrow(InvalidInputError);
  });

  it("gives every request of the ceremony the caller's signal and starts none after an abort", async () => {
    const scenario: CttScenario = {};
    mockCttFlow(scenario);
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    // The caller cancels while the cookie-less 403 is being answered.
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.signal) signals.push(init.signal);
      const response = await fetch(input, init);
      if (response.status === 403) controller.abort(new Error('caller cancelled'));
      return response;
    };
    await expect(new CttTracker({ timeoutMs: 1_000, fetcher }).fetch(TRACKING_NUMBER, { signal: controller.signal }))
      .rejects.toThrow('caller cancelled');
    expect(scenario.calls).toHaveLength(4);
    expect(scenario.calls?.filter((call) => call.includes('DataActionGetObjectEventsByInputObjectCode'))).toHaveLength(1);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
