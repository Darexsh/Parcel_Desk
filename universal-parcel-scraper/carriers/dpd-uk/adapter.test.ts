import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DpdUkTracker } from './adapter.js';
import { classifyDpdUkWording, normalizeDpdUkNumber, parseDpdUkHistory, parseDpdUkReference } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '15500000000001';
const CODE = `${NUMBER}*10000`;
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const project = (payload = fixture()) => parseDpdUkHistory(payload.detail, payload.history, NUMBER, CODE);
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

describe('DPD UK public history projection', () => {
  it('binds the exact formatted number and handle, dating UK scans in winter and keeping source order', () => {
    const payload = fixture();
    expect(parseDpdUkReference(payload.reference, NUMBER)).toBe(CODE);
    const result = project(payload);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_update: '2026-01-06T08:15:00+00:00', delivered_at: '2026-01-06T08:15:00+00:00' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'registered']);
    expect(result.events?.map(event => event.time)).toEqual(['2026-01-06T08:15:00+00:00', '2026-01-06T06:59:00+00:00',
      '2026-01-06T02:49:00+00:00', '2026-01-05T20:22:00+00:00', '2026-01-05T12:38:00+00:00']);
    expect(result.events?.some(event => event.local_time !== undefined)).toBe(false);
    expect(result.sender_name).toBe('Example Merchant');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-SYNTHETIC|10000|15500000000001/);
  });

  it('dates DPD and sender records on summer time and keeps partner and Pickup shop clocks local', () => {
    const result = project(fixture('partner'));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-08-04T11:20:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(result).toHaveProperty('sender_name', null);
    expect(result.events?.map(event => [event.time, event.local_time])).toEqual([
      [undefined, '2026-08-04T11:20:00'],
      [undefined, '2026-08-04T07:40:00'],
      [undefined, '2026-07-31T03:10:00'],
      ['2026-07-30T04:05:00+01:00', undefined],
      [undefined, '2026-07-29T18:30:00'],
      ['2026-07-29T12:15:00+01:00', undefined],
    ]);
    expect(JSON.stringify(result.events)).not.toMatch(/Example|Sender/);
  });

  it('reads the sender record under the account display name, and no other account', () => {
    const payload = fixture('partner');
    payload.detail.data.shipperDetails.customerDisplayName = 'Example Merchant';
    payload.history.data[5].eventLocation = 'Example Merchant';
    payload.history.data[4].eventLocation = 'Other Merchant';
    const events = project(payload).events!;
    expect(events[5]).toMatchObject({ time: '2026-07-29T12:15:00+01:00', stage: 'registered' });
    expect(events[4]).toMatchObject({ local_time: '2026-07-29T18:30:00' });
    expect(events[4]?.time).toBeUndefined();
  });

  it('dates the newest UK scan as the last update and delivery', () => {
    const payload = fixture('partner');
    payload.history.data[0].eventLocation = 'DPD';
    expect(project(payload)).toMatchObject({ last_update: '2026-08-04T11:20:00+01:00', delivered_at: '2026-08-04T11:20:00+01:00' });
    expect(project(payload).last_update_local).toBeUndefined();
  });

  it.each([
    ['2026-03-29 00:30:00', '2026-03-29T00:30:00+00:00'],
    ['2026-03-29 01:30:00', undefined],
    ['2026-03-29 02:30:00', '2026-03-29T02:30:00+01:00'],
    ['2026-10-25 01:30:00', '2026-10-25T01:30:00+01:00'],
    ['2026-10-25 02:30:00', '2026-10-25T02:30:00+00:00'],
  ])('reads the UK clock change at %s', (clock, time) => {
    const payload = fixture(); payload.history.data[0].eventDate = clock;
    const event = project(payload).events![0]!;
    expect(event.time).toBe(time);
    expect(event.local_time).toBe(time ? undefined : clock.replace(' ', 'T'));
  });

  it('reads a check character that is a digit', () => {
    const payload = fixture();
    payload.reference.data[0].parcelNumber = '1550 0000 000 001 7';
    payload.detail.data.parcelNumber = '1550 0000 000 001 7';
    expect(parseDpdUkReference(payload.reference, NUMBER)).toBe(CODE);
    expect(project(payload).status).toBe('delivered');
  });

  it('names the network or sender of a scan nowhere as its place', () => {
    const payload = fixture();
    payload.history.data[1].eventLocation = 'Example Partner B.v.';
    const result = project(payload);
    expect(result.events?.some(event => event.location !== undefined)).toBe(false);
    expect(JSON.stringify(result.events)).not.toMatch(/Example|DPD/);
  });

  it('takes no sender from a missing or blank account name', () => {
    const payload = fixture();
    payload.detail.data.shipperDetails.customerDisplayName = '  ';
    expect(project(payload).sender_name).toBeUndefined();
    delete payload.detail.data.shipperDetails;
    expect(project(payload).sender_name).toBeUndefined();
  });

  it('names no sender for a parcel its sender hands in at a Pickup shop, whose account may be its recipient', () => {
    const payload = fixture();
    const record = payload.history.data.at(-1);
    record.eventText = "We've received your order details, and we're expecting your parcel shortly";
    expect(project(payload)).toHaveProperty('sender_name', null);
    record.eventText = "We've received your order details, but have not yet received your parcel";
    payload.history.data.splice(-1, 0, { eventDate: '2026-01-05 16:54:00', eventLocation: 'DPD', eventText: 'Your parcel has been dropped off at a DPD Pickup Shop' });
    expect(project(payload)).toHaveProperty('sender_name', null);
    payload.history.data.splice(-2, 1);
    expect(project(payload).sender_name).toBe('Example Merchant');
  });

  it('files every recorded wording under its stage, and its notices as gaps', () => {
    for (const entry of statuses.entries) {
      const answer = statusMapAnswer({ carrier: 'dpd-uk', providerCode: null, description: entry.wording });
      if ('unmapped' in entry) {
        expect(answer.kind).toBe('intentional_gap');
        continue;
      }
      expect(classifyDpdUkWording(entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(classifyDpdUkWording('constructor').source).not.toBe('carrier_map');
  });

  it.each([
    ['Your parcel is waiting for you at home (left in safe place) at 15:48 on Tue 16 Jun 2026', 'delivered'],
    ['The parcel has been delivered at 10:52 on Wed 05 Aug 2026', 'delivered'],
    ['Your parcel will be with you today ', 'out_for_delivery'],
    ['Your parcel will be with you today between 9:05 and 10:05.', 'out_for_delivery'],
    ['Your delivery has been cancelled, please contact Example Merchant for further details', 'exception'],
    ["We missed you. Your driver Sample won’t be back today but we'll be back Thu 05 November with your parcel", 'failed_attempt'],
  ])('reads the current summary %s', (summary, stage) => {
    const payload = fixture(); payload.detail.data.trackingStatusCurrent = summary;
    expect(project(payload)).toMatchObject({ current_stage: stage, current_stage_source: 'carrier_map' });
  });

  it.each(['A notification has been sent to advise you when the delivery will take place',
    'As requested, your parcel will now be left in your selected safe place',
    'As requested, your parcel will now be delivered on Mon 2 November 2026 at 9:30.',
    'As requested, your parcel will now be delivered on Mon 2 November 2026'])('gives the notice %s no mapped stage', text => {
    expect(classifyDpdUkWording(text).source).not.toBe('carrier_map');
    expect(statusMapAnswer({ carrier: 'dpd-uk', providerCode: null, description: text }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage it had/) });
  });

  it('leaves a delivery wording that names a day without a request open', () => {
    expect(statusMapAnswer({ carrier: 'dpd-uk', providerCode: null, description: 'Your parcel will now be delivered on Mon 2 November 2026' }).kind)
      .toBe('unknown');
  });

  it.each(['different', 'missing', 'malformed', 'ambiguous', 'unsafe-handle'])('rejects a %s reference lookup', mode => {
    const payload = fixture().reference;
    if (mode === 'different') payload.data[0].parcelNumber = '1550 0000 000 002 A';
    if (mode === 'missing') delete payload.data[0].parcelNumber;
    if (mode === 'malformed') payload.data[0].parcelNumber += 'OTHER';
    if (mode === 'ambiguous') payload.data.push(payload.data[0]);
    if (mode === 'unsafe-handle') payload.data[0].parcelCode = '../private?token=PRIVATE-SYNTHETIC';
    expect(() => parseDpdUkReference(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['number', 'handle', 'missing-handle', 'scan-number', 'scan-handle'])('rejects contradictory %s identity', mode => {
    const payload = fixture();
    if (mode === 'number') payload.detail.data.parcelNumber = '1550 0000 000 002 A';
    if (mode === 'handle') payload.detail.data.parcelCode = `${NUMBER}*20000`;
    if (mode === 'missing-handle') delete payload.detail.data.parcelCode;
    if (mode === 'scan-number') payload.history.data[0].parcelNumber = '1550 0000 000 002 A';
    if (mode === 'scan-handle') payload.history.data[0].parcelCode = `${NUMBER}*20000`;
    expect(() => project(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires nonempty history and validates all rows before truncation', () => {
    const payload = fixture(); payload.history.data = [];
    expect(() => project(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const row of [null, {}, { eventText: [], eventDate: '2026-01-01 01:00:00' }]) {
      const malformed = fixture(); malformed.history.data.unshift(row);
      expect(() => project(malformed)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    payload.history.data = Array.from({ length: 1001 }, () => fixture().history.data[0]);
    expect(() => project(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    payload.history.data = Array.from({ length: 101 }, (_, index) => ({ eventText: `Scan ${index}`, eventDate: '2026-01-01 01:00:00' }));
    expect(project(payload).events).toHaveLength(100);
    payload.history.data[100] = {};
    expect(() => project(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['invalid', '2026-02-30 12:00:00', '2026-01-06T08:15:00+99:00', '2026-01-06T08:15:00+02:99',
    '2026-01-06T08:15:00+14:01', '2026-01-06 24:00:00'])('keeps invalid newest clock unresolved: %s', clock => {
    const payload = fixture(); payload.history.data[0].eventDate = clock;
    payload.history.data[1].eventDate = '2026-01-06T07:00:00Z';
    const result = project(payload);
    expect(result.last_update).toBeNull(); expect(result.last_update_local).toBeUndefined(); expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: clock, stage: 'delivered' });
    expect(result.events?.[0]?.time).toBeUndefined(); expect(result.events?.[1]?.time).toBe('2026-01-06T07:00:00Z');
  });

  it('accepts a stated instant and never borrows a movement time for a terminal summary', () => {
    const payload = fixture(); payload.history.data[0].eventDate = '2026-01-06T08:15:00+01:00';
    expect(project(payload)).toMatchObject({ last_update: '2026-01-06T08:15:00+01:00', delivered_at: '2026-01-06T08:15:00+01:00' });
    payload.history.data[0].eventText = 'Your parcel is at our depot';
    expect(project(payload)).toMatchObject({ status: 'delivered', last_update: '2026-01-06T08:15:00+01:00' });
    expect(project(payload).delivered_at).toBeUndefined();
  });

  it('uses the authoritative current summary and preserves unknown wording as unknown', () => {
    const payload = fixture(); payload.detail.data.trackingStatusCurrent = 'Your parcel will be with you today';
    expect(project(payload)).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    payload.detail.data.trackingStatusCurrent = 'Unrecognized checkpoint';
    payload.history.data = [{ eventText: 'Unrecognized checkpoint', eventDate: '2026-01-06 08:15:00' }];
    const result = project(payload);
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
  });

  it('does not borrow a delivered stage from history when the current summary is unrecognized', () => {
    const payload = fixture(); payload.detail.data.trackingStatusCurrent = 'Unrecognized current checkpoint';
    payload.history.data[0].eventDate = '2026-01-06T08:15:00Z';
    const result = project(payload);
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', time: '2026-01-06T08:15:00Z' });
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined(); expect(result.delivered_at).toBeUndefined();
    expect(result.last_status_text).toBe('Unrecognized current checkpoint');
  });

  it('sanitizes recipient wording while retaining sender-return semantics', () => {
    const payload = fixture(); payload.detail.data.trackingStatusCurrent = 'Your parcel has been delivered to PRIVATE-SYNTHETIC';
    payload.history.data[0].eventText = 'Your parcel has been delivered and signed for by PRIVATE-SYNTHETIC';
    expect(project(payload).status).toBe('delivered'); expect(JSON.stringify(project(payload))).not.toContain('PRIVATE-SYNTHETIC');
    payload.detail.data.trackingStatusCurrent = 'The parcel has been delivered back to the sender';
    payload.history.data[0].eventText = 'The parcel has been delivered back to the sender';
    expect(project(payload).current_stage).toBe('returned');
  });

  it("leaves out the driver's name a scan gives", () => {
    const payload = fixture();
    payload.detail.data.trackingStatusCurrent = "We missed you. Your driver PRIVATE SYNTHETIC won't be back today but we'll be back Wed 28 October with your parcel";
    payload.history.data[0].eventText = payload.detail.data.trackingStatusCurrent;
    const result = project(payload);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: "We missed you. Your driver won't be back today but we'll be back Wed 28 October with your parcel" });
    expect(result.events?.[0]).toMatchObject({ stage: 'failed_attempt', description: result.last_status_text });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('maps the observed partner wording without assigning numeric codes', () => {
    const payload = fixture(); delete payload.detail.data.trackingStatusCurrent;
    payload.history.data[0].eventText = 'The parcel is on the vehicle for delivery';
    expect(project(payload)).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
  });
});

describe('DPD UK recognition', () => {
  const carrier = (fetcher: typeof fetch) => adapter({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });
  const absent = (message: string) => json({ error: { statusCode: 404, error: 'Not Found', message } }, 404);

  it('knows a parcel the reference service finds, through the same three reads', async () => {
    const payload = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(payload.reference)).mockResolvedValueOnce(json(payload.detail)).mockResolvedValueOnce(json(payload.history));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('takes the named unknown reference as unknown, a bare 404 as a failure, and asks nothing about a number DPD UK does not issue', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(absent('Your reference number could not be found'))).recognize!(NUMBER))
      .resolves.toEqual({ known: false });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(absent('Not Found'))).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ORDER-REFERENCE', '1550000000000', `${NUMBER}N`]) await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('DPD UK anonymous retrieval', () => {
  it('performs three bounded reads with an empty postcode and server-returned handle', async () => {
    const payload = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(payload.reference)).mockResolvedValueOnce(json(payload.detail)).mockResolvedValueOnce(json(payload.history));
    const instance = adapter({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });
    await instance.track({ number: NUMBER, postcode: 'PRIVATE-SYNTHETIC' });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `https://apis.track.dpd.co.uk/v1/reference?origin=PRTK&postcode=&referenceNumber=${NUMBER}`,
      `https://apis.track.dpd.co.uk/v1/parcels/${CODE}`,
      `https://apis.track.dpd.co.uk/v1/parcels/${CODE}/parcelevents`,
    ]);
    expect(fetcher.mock.calls.every(call => call[1]?.signal instanceof AbortSignal && call[1]?.redirect === 'error')).toBe(true);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('PRIVATE-SYNTHETIC');
  });

  it('stops before history when the detail identity contradicts the lookup', async () => {
    const payload = fixture(); payload.detail.data.parcelCode = 'PRIVATE-SYNTHETIC';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(payload.reference)).mockResolvedValueOnce(json(payload.detail));
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['exact', 'generic', 'contradictory'])('distinguishes %s reference 404', async mode => {
    const payload: Record<string, unknown> = { error: { statusCode: 404, error: 'Not Found', message: mode === 'generic' ? 'Not Found' : 'Your reference number could not be found' } };
    if (mode === 'contradictory') payload.data = fixture().reference.data;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(payload, 404));
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: mode === 'exact' ? 'not_found' : 'transport' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])('keeps detail HTTP %s separate from parcel absence and removes handle diagnostics', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture().reference))
      .mockResolvedValueOnce(new Response(`PRIVATE-SYNTHETIC ${CODE}`, { status: Number(status), headers: { 'Content-Type': 'text/plain' } }));
    const error = await new DpdUkTracker({ fetcher }).fetch(NUMBER).catch(error => error);
    expect(error).toMatchObject({ kind });
    expect(error.cause).toBeUndefined(); expect(error.request).toBeUndefined(); expect(error.diagnostics).toBeUndefined();
    expect(String(error)).not.toMatch(/PRIVATE-SYNTHETIC|10000/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('discards malformed payload bodies and opaque handles from parser error causes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture().reference))
      .mockResolvedValueOnce(new Response(`PRIVATE-SYNTHETIC ${CODE}`));
    const error = await new DpdUkTracker({ fetcher }).fetch(NUMBER).catch(error => error);
    expect(error.kind).toBe('schema'); expect(error.cause).toBeUndefined(); expect(error.response_body).toBeUndefined();
  });

  it('preserves cancellation before and between requests', async () => {
    const reason = new Error('Caller canceled'); const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      controller.abort(reason); return json(fixture().reference);
    });
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear();
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds response allocation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['123', `${NUMBER}&other=1`, 'ORDER-REFERENCE'])('rejects unsupported input %s before I/O', async number => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new DpdUkTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDpdUkNumber('1550 0000 000 001')).toBe(NUMBER);
    // The printed check letter is dropped when it matches; a mistyped one is not another parcel.
    expect(normalizeDpdUkNumber('1550 0000 000 001 M')).toBe(NUMBER);
    expect(() => normalizeDpdUkNumber(`${NUMBER}N`)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});
