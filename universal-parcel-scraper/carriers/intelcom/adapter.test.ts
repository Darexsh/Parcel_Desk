import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IntelcomTracker } from './adapter.js';
import { normalizeIntelcomNumber, parseIntelcom } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'INTLCM0000000000';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));

describe('Canadian Intelcom / Dragonfly response', () => {
  it('uses observed status codes for the website\'s marketing milestone labels', () => {
    const payload = JSON.parse(readFileSync(new URL('./fixtures/website-history.json', import.meta.url), 'utf8'));
    const result = parseIntelcom(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Hooray! Your package is here', delivered_at: '2026-01-03T17:00:00Z' });
    expect(result.events?.map(row => row.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.every(row => row.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
    payload.data.result.last_status.status = 860; payload.data.result.last_status.statusCode = 860;
    payload.data.result.last_status.step = -2; payload.data.result.last_status.isDelivered = false;
    payload.data.result.last_status.labels.shortLabel.en = "Uh-oh! We're unable to locate your package";
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception' });
    expect(parseIntelcom(payload, NUMBER).delivered_at).toBeUndefined();
  });

  it('uses the explicit delivered flag for an unmapped code and leaves other new codes unmapped', () => {
    const payload = fixture(); payload.data.result.last_status.statusCode = 9999;
    payload.data.result.last_status.labels.shortLabel.en = 'A new milestone';
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ status: 'unknown' });
    payload.data.result.last_status.isDelivered = true;
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ status: 'delivered', current_stage_source: 'carrier_map' });
  });

  it('projects English milestone labels and explicit scan clocks without recipient or driver details', () => {
    const result = parseIntelcom(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-03T17:00:00Z' });
    expect(result.events).toHaveLength(3);
    expect(result.events?.[1]).toMatchObject({ description: 'Out for delivery', stage: 'out_for_delivery', provider_code: 'OFD' });
    expect(result.events?.[0]?.stage_source).toMatch(/^wording:/);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic driver|Synthetic recipient|Private details|street/);
  });

  it('rejects wrong identity, malformed rows and excessive history', () => {
    for (const identity of [undefined, 'INTLCM1111111111', { number: NUMBER }]) {
      const payload = fixture(); payload.data.result.tracking_id = identity;
      expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const payload = fixture(); payload.data.result.status_list.unshift(null);
    expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    payload.data.result.status_list = Array.from({ length: 1001 }, () => payload.data.result.last_status);
    expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts only an explicit upstream negative reply', () => {
    expect(() => parseIntelcom({ success: false, data: { code: 'not_found', result: null } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIntelcom({ success: false, data: { code: 'upstream_error', result: null } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIntelcom({}, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('retains a dated summary when the public service returns no history', () => {
    const payload = fixture(); delete payload.data.result.status_list;
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ summary_only: true, events: [], status: 'delivered' });
    payload.data.result.last_status.timestamp = '2026-01-03 12:00:00';
    expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('leaves a local clock unresolved and does not borrow an older scan instant', () => {
    const payload = fixture(); payload.data.result.last_status.timestamp = '2026-01-03 12:00:00';
    const result = parseIntelcom(payload, NUMBER);
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
  });

  it.each(['2026-01-03T17:00:00+99:00', '2026-01-03T17:00:00+02:99', '2026-01-03T17:00:00+14:01',
    1767456000, 1767456000000.5, 10_000_000_000_000, Number.MAX_SAFE_INTEGER])(
    'preserves an invalid clock %s without resolving delivery or accepting an undated summary', clock => {
      const payload = fixture();
      payload.data.result.last_status.timestamp = clock;
      payload.data.result.status_list[0].timestamp = clock;
      const result = parseIntelcom(payload, NUMBER);
      expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
      expect(result.events?.[0]).toMatchObject({ provider_time_text: String(clock) });
      expect(result.events?.[0]?.time).toBeUndefined();
      delete payload.data.result.status_list;
      expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    },
  );

  it.each([[1767456000000, '2026-01-03T16:00:00Z'], ['2026-01-03T17:00:00+05:30', '2026-01-03T17:00:00+05:30'],
    ['2026-01-03T17:00:00+1400', '2026-01-03T17:00:00+14:00']])('resolves a valid bounded clock %s', (clock, expected) => {
    const payload = fixture(); payload.data.result.last_status.timestamp = clock;
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ last_update: expected, delivered_at: expected });
  });

  it('does not expand recipient-address template tokens', () => {
    const payload = fixture(); payload.data.result.last_status.labels.shortLabel.en = 'Delivered {street}';
    payload.data.result.last_status.package_location = { address: { street: 'Private synthetic street' } };
    expect(parseIntelcom(payload, NUMBER).last_status_text).toBe('Delivered');
  });

  it('accepts the website\'s older direct label shape and numeric-string steps', () => {
    const payload = fixture(); payload.data.result.last_status.labels = {};
    payload.data.result.last_status.shortLabel = { en: 'Delivered' };
    payload.data.result.last_status.step = '4';
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ status: 'delivered', last_status_text: 'Delivered' });
  });
});

describe('Intelcom estimates, returns and senders', () => {
  const history = () => JSON.parse(readFileSync(new URL('./fixtures/website-history.json', import.meta.url), 'utf8'));
  // The same parcel while a driver had it.
  const outForDelivery = () => {
    const payload = history(); const result = payload.data.result;
    result.status_list.shift();
    result.last_status = { ...result.status_list[0], task_type: 'last_mile_delivery', showEta: true, etaType: 'time' };
    result.public_eta = { from: '2026-01-03T18:00:00.000Z', to: '2026-01-03T19:00:00.000Z', min: 7, max: 22 };
    result.eta = '2026-01-03T13:00:00.000000-05:00';
    return payload;
  };

  it('reads the hour window the tracking page shows once a driver has the parcel', () => {
    expect(parseIntelcom(outForDelivery(), NUMBER)).toMatchObject({ status: 'out_for_delivery',
      expected_delivery_from: '2026-01-03T18:00:00Z', expected_delivery: '2026-01-03T19:00:00Z' });
  });

  it('reads a day estimate on the clock of the service\'s own estimate', () => {
    const payload = outForDelivery(); const result = payload.data.result;
    result.status_list.shift();
    result.last_status = { ...result.status_list[0], task_type: 'last_mile_delivery', showEta: true, etaType: 'period' };
    result.public_eta = { from: '2026-01-05T05:00:00.000Z', to: '2026-01-07T05:00:00.000Z', min: 7, max: 22 };
    result.eta = '2026-01-05T00:00:00.000000-05:00';
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ status: 'in_transit', expected_delivery_from: '2026-01-05', expected_delivery: '2026-01-07' });
    result.public_eta = { from: '2026-01-05T15:00:00.000Z', to: '2026-01-05T18:00:00.000Z' };
    const sameDay = parseIntelcom(payload, NUMBER);
    expect(sameDay.expected_delivery).toBe('2026-01-05'); expect(sameDay).not.toHaveProperty('expected_delivery_from');
    delete result.eta;
    expect(parseIntelcom(payload, NUMBER)).not.toHaveProperty('expected_delivery');
  });

  const hidden: [string, (row: Record<string, unknown>) => void][] = [
    ['the service hides it', row => { row.showEta = false; }],
    ['its type is none', row => { row.etaType = 'none'; }],
    ['the parcel is delivered', row => { row.isDelivered = true; }],
    ['the task is a pickup', row => { row.task_type = 'last_mile_pickup'; }],
    ['the step is a problem', row => { row.step = -2; }],
    ['the window ended before the latest scan', row => { row.timestamp = Date.parse('2026-01-03T20:00:00Z'); }],
  ];
  it.each(hidden)('shows no estimate when %s', (_, change) => {
    const payload = outForDelivery(); change(payload.data.result.last_status);
    const result = parseIntelcom(payload, NUMBER);
    expect(result).not.toHaveProperty('expected_delivery'); expect(result).not.toHaveProperty('expected_delivery_from');
  });

  it('follows a return collected from the customer without calling it delivered', () => {
    const row = (code: number, step: number, label: string, timestamp: number, isDelivered = false) => ({ status: code, statusCode: code,
      step, timestamp, isDelivered, task_type: 'last_mile_pickup', showEta: false, etaType: 'none', labels: { shortLabel: { en: label } } });
    const rows = [row(850, 4, 'Mission accomplished!', 1767459600000), row(602, 3, 'We got it!', 1767456000000, true),
      row(200, 2, 'We\'re on our way!', 1767448800000), row(0, 1, 'Pickup requested by merchant.', 1767362400000)];
    const payload = { success: true, data: { code: 'found', result: { tracking_id: NUMBER, client_code: 'AMAZON', last_status: rows[0]!, status_list: rows } } };
    const result = parseIntelcom(payload, NUMBER);
    // The client the return goes to is not its sender.
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', sender_name: null });
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'accepted', 'registered', 'registered']);
    expect(result).not.toHaveProperty('delivered_at');
    payload.data.result.last_status = rows[1]!;
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
  });

  it('names only the clients the tracking page names', () => {
    const payload = history(); payload.data.result.client_code = 'CANTIRE';
    expect(parseIntelcom(payload, NUMBER).sender_name).toBe('Canadian Tire');
    payload.data.result.client_code = 'UNLISTED';
    expect(parseIntelcom(payload, NUMBER)).not.toHaveProperty('sender_name');
  });

  it('maps every recorded status to the stage it records', () => {
    for (const entry of statuses.entries) {
      const pickup = ['200', '602', '850'].includes(entry.code) || entry.wording.startsWith('Pickup');
      const row = { status: Number(entry.code), statusCode: Number(entry.code), step: 2, timestamp: 1767459600000,
        isDelivered: ['601', '602'].includes(entry.code), task_type: pickup ? 'last_mile_pickup' : 'last_mile_delivery',
        labels: { shortLabel: { en: entry.wording } } };
      const payload = { success: true, data: { code: 'found', result: { tracking_id: NUMBER, last_status: row, status_list: [row] } } };
      expect(parseIntelcom(payload, NUMBER).current_stage, entry.code).toBe(entry.stage);
    }
  });
});

describe('Canadian Intelcom / Dragonfly retrieval', () => {
  it('uses the Canadian portal endpoint without cookies or authentication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    await new IntelcomTracker({ fetcher }).fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://dragonflyshipping.ca/cfworker/v3/tracking/${NUMBER}/`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(normalizeIntelcomNumber('intlcm-0000000000')).toBe(NUMBER);
  });

  it('rejects invalid input and already aborted lookups before I/O', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123', `${NUMBER}&context=OTHER`]) {
      await expect(new IntelcomTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(new IntelcomTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']])('does not confuse HTTP %s with a not-found response', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new IntelcomTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });
});
