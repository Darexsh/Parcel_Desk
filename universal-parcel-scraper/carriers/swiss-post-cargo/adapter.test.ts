import { readFileSync } from 'node:fs';
import { Settings } from 'luxon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import {
  normalizeSwissPostCargoTrackingNumber,
  parseSwissPostCargoResponse,
  SwissPostCargoTracker,
  swissPostCargoIdentifiers,
  swissPostCargoTrackingUrl,
} from './adapter.js';
import { statusFor } from './status.js';

const fixture = (name: string): Record<string, unknown> => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
) as Record<string, unknown>;
const delivered = () => fixture('delivered');
const deliveredShipment = () => (delivered().Data as Record<string, unknown>[])[0]!;

afterEach(() => {
  vi.restoreAllMocks();
  Settings.defaultZone = 'system';
});

describe('Swiss Post Cargo tracking', () => {
  it('normalizes public barcodes and builds the official result URL', () => {
    expect(normalizeSwissPostCargoTrackingNumber(' 12.34-abc789 ')).toBe('1234ABC789');
    expect(swissPostCargoTrackingUrl('12.34-abc789'))
      .toBe('https://apv.swisspost-cargo.com/public/trackandtrace/1234ABC789');
    expect(() => normalizeSwissPostCargoTrackingNumber('letters-only'))
      .toThrow('Swiss Post Cargo tracking requires a 6- to 40-character barcode or reference');
    expect(() => normalizeSwissPostCargoTrackingNumber('letters-only')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('maps only public history fields and rejects a different barcode', () => {
    expect(parseSwissPostCargoResponse(delivered(), '1234ABC789')).toEqual({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-08-30T12:30:00.777+02:00',
      expected_delivery: null,
      delivered_at: '2026-08-30T12:30:00.777+02:00',
      timezone: 'Europe/Zurich',
      events: [
        {
          time: '2026-08-30T12:30:00.777+02:00',
          location: 'Zürich',
          description: 'Delivered',
          stage: 'delivered',
          provider_code: 'DLV',
        },
        {
          time: '2026-08-29T07:15:00.100+02:00',
          location: 'Dintikon',
          description: 'Shipment accepted',
          stage: 'accepted',
          provider_code: 'RFS',
        },
      ],
      tracking_url: 'https://apv.swisspost-cargo.com/public/trackandtrace/1234ABC789',
    });
    expect(() => parseSwissPostCargoResponse({
      ...delivered(),
      Data: [{ ...deliveredShipment(), Identifier: '9876OTHER1' }],
    }, '1234ABC789')).toThrow('different shipment');
    expect(() => parseSwissPostCargoResponse({
      ...delivered(),
      Type: 1,
      Data: [{ ...deliveredShipment(), Identifier: undefined }],
    }, '1234ABC789')).toThrow('no shipment identifier');
    expect(() => parseSwissPostCargoResponse({ ...delivered(), Type: 4 }, '1234ABC789'))
      .toThrow('invalid tracking response type');
    expect(() => parseSwissPostCargoResponse({ Data: delivered().Data }, '1234ABC789'))
      .toThrow('invalid tracking response type');
  });

  it('reads offset-less times on Swiss time in any server zone and keeps sent offsets', () => {
    // Stands in for the server's zone: production runs in UTC, and a machine on
    // Swiss time must not pass for it.
    Settings.defaultZone = 'UTC';
    const scan = (TimeStamp: string, Description: string) => ({ TimeStamp, City: 'Dintikon', Status: 'TRN', Description });
    // One barcode with a winter and a summer scan.
    const result = parseSwissPostCargoResponse({
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        History: [
          scan('2026-01-15T09:30:00.1', 'Loaded'),
          scan('2026-08-30T12:30:00.777', 'Unloaded'),
          scan('2026-08-30T11:00:00+01:00', 'Sorted'),
          scan('2026-08-30T08:00:00Z', 'Shipment accepted'),
        ],
      }],
    }, '1234ABC789');
    expect(result.events?.map((event) => event.time)).toEqual([
      '2026-08-30T12:30:00.777+02:00',
      '2026-08-30T11:00:00+01:00',
      '2026-08-30T08:00:00Z',
      '2026-01-15T09:30:00.100+01:00',
    ]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('never retains the consignee or the internal full description', () => {
    const serialized = JSON.stringify(parseSwissPostCargoResponse(delivered(), '1234ABC789'));
    for (const privateValue of ['Private recipient', 'Secret street', 'Private operational detail']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('covers every capability declared in carrier.json', () => {
    const result = parseSwissPostCargoResponse(delivered(), '1234ABC789');
    const capabilities: string[] = (JSON.parse(
      readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
    ) as { capabilities: string[] }).capabilities;
    expect(capabilities).toEqual(['history', 'location', 'provider_code', 'delivered_at']);
    expect(result.delivered_at).toBe('2026-08-30T12:30:00.777+02:00');
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
  });

  it('turns the official null-data response into a clean unannounced error', () => {
    expect(() => parseSwissPostCargoResponse({ Data: null }, 'CODEXINVALID20260831'))
      .toThrow(NotFoundError);
    try {
      parseSwissPostCargoResponse({ Data: null }, 'CODEXINVALID20260831');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'NotFoundError',
        status: 404,
        message: 'Swiss Post Cargo could not locate the shipment',
      });
    }
  });

  it('leaves a Type 3 relay of Swiss Post tracking to the Swiss Post adapter', () => {
    const relayed = fixture('relayed-swiss-post');
    expect(() => parseSwissPostCargoResponse(relayed, '99.34.123456.12345678')).toThrow(NotFoundError);
    try {
      parseSwissPostCargoResponse(relayed, '99.34.123456.12345678');
    } catch (error) {
      expect(error).toMatchObject({
        status: 404,
        kind: 'not_found',
        message: 'Swiss Post Cargo only relays Swiss Post tracking for this barcode',
      });
    }
    expect(() => parseSwissPostCargoResponse(relayed, '1234ABC789')).toThrow('different shipment');
  });

  it('folds the delivery photo and signature into the delivery scan', () => {
    // eos lists the photo first, at the delivery scan's very instant and with no place.
    const result = parseSwissPostCargoResponse({
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        History: [
          { Id: 4, TimeStamp: '2026-08-30T12:30:00.917', City: '', Status: 'IMG', Description: 'IMAGE' },
          { Id: 3, TimeStamp: '2026-08-30T12:30:00.917', City: 'Zürich', Status: 'POD', Description: 'DELIVERED SCANNED' },
          { Id: 5, TimeStamp: '2026-08-30T12:30:14.2', City: 'Zürich', Status: 'SIG', Description: 'SIGNATURE' },
          { Id: 2, TimeStamp: '2026-08-30T07:16:23.363', City: '', Status: 'SCA', Description: 'Loaded for Delivery' },
        ],
      }],
    }, '1234ABC789');
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'DELIVERED SCANNED',
      last_update: '2026-08-30T12:30:00.917+02:00',
      delivered_at: '2026-08-30T12:30:00.917+02:00',
    });
    expect(result.events?.map((event) => [event.provider_code, event.location])).toEqual([
      ['POD', 'Zürich'], ['SCA', ''],
    ]);
    // Before the delivery scan arrives, the photo is the only sign of the
    // delivery, but it never passes a scan made at the same instant.
    const photoOnly = parseSwissPostCargoResponse({
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        History: [
          { TimeStamp: '2026-08-30T12:30:00.917', City: '', Status: 'IMG', Description: 'IMAGE' },
          { TimeStamp: '2026-08-30T12:30:00.917', City: 'Zürich', Status: 'SCA', Description: 'Loaded for Delivery' },
          { TimeStamp: '2026-08-30T12:45:00', City: '', Status: 'SIG', Description: 'SIGNATURE' },
        ],
      }],
    }, '1234ABC789');
    expect(photoOnly.events?.map((event) => event.provider_code)).toEqual(['SIG', 'SCA', 'IMG']);
    expect(photoOnly).toMatchObject({ status: 'delivered', last_status_text: 'SIGNATURE' });
  });

  it('keeps scans of one instant in the carrier\'s order', () => {
    const result = parseSwissPostCargoResponse({
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        History: [
          { TimeStamp: '2026-08-29T07:15:00', City: 'Zürich', Status: 'RFS', Description: 'Received' },
          { TimeStamp: '2026-08-30T07:16:23', City: 'Zürich', Status: 'TOV', Description: 'Sorted' },
          { TimeStamp: '2026-08-30T07:16:23', City: '', Status: 'SCA', Description: 'Loaded for Delivery' },
        ],
      }],
    }, '1234ABC789');
    expect(result.events?.map((event) => event.provider_code)).toEqual(['SCA', 'TOV', 'RFS']);
  });

  it('classifies negative delivery wording before the delivered substring', () => {
    expect(statusFor('ERR', 'Not delivered')).toEqual({ status: 'exception', stage: 'failed_attempt' });
    expect(parseSwissPostCargoResponse({
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        History: [{
          TimeStamp: '2026-08-30T12:30:00+02:00',
          Status: 'ERR',
          Description: 'Not delivered',
        }],
      }],
    }, '1234ABC789')).toMatchObject({
      status: 'exception',
      events: [{ stage: 'failed_attempt' }],
    });
  });

  it('posts the identifier to the anonymous bounded endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      Type: 1,
      Data: [{
        Identifier: '1234ABC789',
        History: [{
          TimeStamp: '2026-08-30T12:30:00+02:00',
          City: 'Zürich',
          Status: 'DLV',
          Description: 'Delivered',
        }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(new SwissPostCargoTracker({ timeoutMs: 2_000 }).fetch('1234ABC789'))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://eosapi.swisspost-cargo.com/api/trackandtrace/public',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ Identifier: '1234ABC789' }),
      }),
    );
  });
});

describe('Swiss Post Cargo recognition', () => {
  const sscc = '00312345670000000016';
  const answer = (payload: unknown) => vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(payload), { status: 200 }),
  );

  it('knows an SSCC eos has dated scans for', async () => {
    const fetcher = answer({
      Type: 1,
      Data: [{
        Identifier: sscc,
        History: [
          { TimeStamp: '2026-08-29T10:00:00', Status: 'NTF', Description: 'Dateneingang Post' },
          { TimeStamp: '2026-08-29T18:30:00', Status: 'RFS', Description: 'Wareneingang POST', City: 'Hub Dintikon' },
        ],
      }],
    });
    await expect(new SwissPostCargoTracker({ fetcher }).recognizes(sscc))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-08-29T16:30:00.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('knows a compact PL reference under its printed spelling', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Data: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture('shared-reference')), { status: 200 }));
    await expect(new SwissPostCargoTracker({ fetcher, now: () => Date.parse('2026-09-01T12:00:00Z') }).recognizes('PL12345678'))
      .resolves.toMatchObject({ known: true });
    expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ Identifier: 'PL12345678' }),
      JSON.stringify({ Identifier: 'PL-12345678' }),
    ]);
  });

  it('reports an unknown SSCC as unknown and an outage as a failure', async () => {
    await expect(new SwissPostCargoTracker({ fetcher: answer({ Data: null }) }).recognizes(sscc))
      .resolves.toEqual({ known: false });
    await expect(new SwissPostCargoTracker({ fetcher: answer({ Data: 'unexpected' }) }).recognizes(sscc))
      .rejects.toMatchObject({ kind: 'schema' });
  });
});

describe('Swiss Post Cargo customer references', () => {
  // A week after the fixture's current consignment was delivered.
  const NOW = Date.parse('2026-09-01T12:00:00Z');
  const sharedReference = () => fixture('shared-reference');

  it('reads a shared reference as the one consignment it still names', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(sharedReference()), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const result = await new SwissPostCargoTracker({ fetcher, now: () => NOW }).fetch('12345678');

    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      tracking_url: 'https://apv.swisspost-cargo.com/public/trackandtrace/12345678',
    });
    // Both barcodes of the current consignment, each signature folded into its
    // delivery scan; their shared announcement once.
    expect(result.events?.map((event) => [event.provider_code, event.location])).toEqual([
      ['POD', 'Zürich'], ['POD', 'Zürich'],
      ['SCA', ''], ['SCA', ''], ['RFS', 'Dintikon'], ['RFS', 'Dintikon'],
      ['TOV', ''], ['TOV', ''], ['NTF', ''],
    ]);
    const serialized = JSON.stringify(result);
    for (const excluded of ['Olten', 'Chur', 'Sion', 'Privatdorf', '0999', 'Private operational detail']) {
      expect(serialized).not.toContain(excluded);
    }
  });

  it('refuses the form example once every shipment behind it is older than 60 days', () => {
    expect(() => parseSwissPostCargoResponse(sharedReference(), '12345678', Date.parse('2026-11-30T12:00:00Z')))
      .toThrow(expect.objectContaining({
        name: 'NotFoundError',
        status: 404,
        message: 'Swiss Post Cargo only has older shipments for this reference',
      }));
  });

  it('asks again with the printed dash once eos does not know the compact reference', async () => {
    expect(swissPostCargoIdentifiers('ab-12345678')).toEqual(['AB12345678', 'AB-12345678']);
    expect(swissPostCargoIdentifiers('12345678')).toEqual(['12345678']);
    expect(swissPostCargoIdentifiers('AB12CD34')).toEqual(['AB12CD34']);
    expect(swissPostCargoIdentifiers('ABCDEFGHIJKL12345678')).toEqual(['ABCDEFGHIJKL12345678']);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Data: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sharedReference()), { status: 200 }));
    const result = await new SwissPostCargoTracker({ fetcher, now: () => NOW }).fetch('AB12345678');

    expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ Identifier: 'AB12345678' }),
      JSON.stringify({ Identifier: 'AB-12345678' }),
    ]);
    expect(result).toMatchObject({
      status: 'delivered',
      tracking_url: 'https://apv.swisspost-cargo.com/public/trackandtrace/AB-12345678',
    });
  });

  it('keeps a compact reference eos knows, and the 404 of one it never knew', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(sharedReference()), { status: 200 }));
    await expect(new SwissPostCargoTracker({ fetcher: known, now: () => NOW }).fetch('AB12345678'))
      .resolves.toMatchObject({ tracking_url: 'https://apv.swisspost-cargo.com/public/trackandtrace/AB12345678' });
    expect(known).toHaveBeenCalledTimes(1);

    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ Data: null }), { status: 200 }));
    await expect(new SwissPostCargoTracker({ fetcher: unknown }).fetch('AB12345678'))
      .rejects.toMatchObject({ name: 'NotFoundError', status: 404 });
    expect(unknown).toHaveBeenCalledTimes(2);
  });

  it('refuses a reference that names two current consignments', () => {
    const payload = sharedReference();
    (payload.Data as unknown[]).push({
      Identifier: '00312345670000000055',
      History: [
        { TimeStamp: '2026-08-18T06:00:00', Status: 'NTF', Description: 'Shipment data received' },
        { TimeStamp: '2026-08-19T10:00:00', Status: 'POD', Description: 'Delivered', City: 'Bern' },
      ],
    });
    expect(() => parseSwissPostCargoResponse(payload, '12345678', NOW)).toThrow(expect.objectContaining({
      name: 'NotFoundError',
      message: 'Swiss Post Cargo has several shipments for this reference',
    }));
  });
});
