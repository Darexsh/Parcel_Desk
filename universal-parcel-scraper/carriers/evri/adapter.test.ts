import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adapter, EvriTracker, normalizeEvriNumber, parse } from './adapter.js';
import { evriPartner } from './parser.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { DEFAULT_USER_AGENT } from '../../core/transport/index.js';

const NUMBER = 'H000000000000001';
const UNKNOWN = 'H000000000000000';
const html = readFileSync(new URL('./fixtures/international.html', import.meta.url), 'utf8');
const empty = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const capabilities = (JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { capabilities: string[] }).capabilities;

describe('Evri International parser', () => {
  it('binds the shipment identity independently of the partner-alias form field', () => {
    const result = parse(html, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      last_update: null, last_update_local: '2026-06-08T12:08:00', last_status_text: 'Delivery Attempted', expected_delivery: null });
    expect(result.events).toHaveLength(7);
    expect(result.events?.map((event) => event.stage)).toEqual([
      'failed_attempt', 'in_transit', 'in_transit', 'customs', 'in_transit', 'accepted', 'registered',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example\.invalid|CI000000005NL|H000000000000001/);
  });

  it('exercises every declared capability', () => {
    expect(capabilities).toEqual(['history', 'location', 'weight']);
    const result = parse(html, NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.[0]?.location).toBe('ET');
    expect(result.weight_kg).toBe(1.95);
  });

  it('preserves portal order and wall clocks across international legs', () => {
    const value = html.replaceAll('2026-06-08 12:08:00', '2026-06-08 09:00:00');
    const result = parse(value, NUMBER);
    expect(result.events?.slice(0, 2).map((event) => event.local_time)).toEqual(['2026-06-08T09:00:00', '2026-06-08T11:51:00']);
    expect(result.events?.every((event) => !event.time)).toBe(true);
    expect(result.timezone).toBeUndefined();
  });

  it('only accepts the exact unambiguous parcel-not-found response to the scoped POST', () => {
    expect(() => parse(empty, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(empty.replace('name="tracking_number" value=""', `name="tracking_number" value="${NUMBER}"`), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse('<main><h2>Parcel not found</h2></main>', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(empty.replace('Parcel not found', 'Temporarily unavailable'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects wrong, ambiguous, empty and malformed shipment results', () => {
    for (const value of [
      html.replace(`Shipment Details #${NUMBER}`, `Shipment Details #${UNKNOWN}`),
      html.replace(`Tracking:</strong> ${NUMBER}`, `Tracking:</strong> ${UNKNOWN}`),
      html.replace('</main>', '<div class="card"><h2>Shipment History</h2></div></main>'),
      html.replace('<th>Comments</th>', '<th>Changed schema</th>'),
      html.replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody></tbody>'),
      html.replace('2026-06-08 12:08:00', '2026-02-31 12:08:00'),
      html.replace('2026-06-08 12:08:00', '2026-06-08'),
      html.replace('<td>Delivery Attempted</td>', '<td></td>'),
      html.replace('<td>Delivery Attempted</td>', '<td colspan="2">Delivery Attempted</td>'),
      html.replace('<strong>Current Status:</strong> Delivery Attempted', '<strong>Current Status:</strong>'),
    ]) expect(() => parse(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const row = '<tr><td>2026-06-08 12:08:00</td><td>Delivered</td><td>GB</td><td></td></tr>';
    expect(() => parse(html.replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${row.repeat(501)}</tbody>`), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('leaves unknown current and historical wording unclassified', () => {
    const result = parse(html.replaceAll('Delivery Attempted', 'Future Evri milestone'), NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ description: 'Future Evri milestone' });
    expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it.each([
    ['Delivered', 'delivered', 'delivered'],
    ['Out for delivery', 'out_for_delivery', 'out_for_delivery'],
    ['Ready for collection', 'in_transit', 'ready_for_pickup'],
    ['Returned to sender', 'exception', 'returned'],
    ['Carrier label error', 'exception', 'exception'],
    ['Delivery Attempted', 'exception', 'failed_attempt'],
    ['Delivery awaiting collection', 'in_transit', 'ready_for_pickup'],
    ['Delivery Exception', 'exception', 'exception'],
    ['Arrived In Country', 'in_transit', 'in_transit'],
    ['Handed to Partner Carrier', 'in_transit', 'in_transit'],
    ['Received by carrier', 'in_transit', 'in_transit'],
    ['Delayed', 'in_transit', 'in_transit'],
  ])('maps %s without confusing completion, collection and return', (label, status, stage) => {
    expect(parse(html.replaceAll('Delivery Attempted', label), NUMBER)).toMatchObject({ status, current_stage: stage });
  });

  it('reads the delivery estimate a comment states, and nothing else in the comments', () => {
    const estimated = (comment: string, page = html) => parse(page.replace('<td>CROSSDOCK</td>', `<td>${comment}</td>`), NUMBER);
    expect(estimated('Estimated delivery date is: 10-30-2026').expected_delivery).toBe('2026-10-30');
    expect(estimated('ESTIMATED DELIVERY DATE IS 2026-10-30').expected_delivery).toBe('2026-10-30');
    // The newest row's estimate stands.
    const revised = html.replace('<td>AT LOCAL DEPOT</td>', '<td>Estimated delivery date is: 11-02-2026</td>');
    expect(estimated('Estimated delivery date is: 10-30-2026', revised).expected_delivery).toBe('2026-11-02');
    for (const comment of ['Estimated delivery date is: 30-10-2026', 'Estimated delivery date is: soon', 'Delivery date 10-30-2026']) {
      expect(estimated(comment).expected_delivery, comment).toBeNull();
    }
    // A delivered parcel has no estimate.
    expect(estimated('Estimated delivery date is: 10-30-2026', html.replaceAll('Delivery Attempted', 'Delivered')).expected_delivery).toBeNull();
  });

  it('does not claim malformed or nonpositive weights', () => {
    for (const value of ['0 kg', '-1 kg', '2 lb', 'unknown']) {
      expect(parse(html.replace('1.95 kg', value), NUMBER).weight_kg).toBeUndefined();
    }
  });

  it('recognizes an interactive challenge and validates input before retrieval', () => {
    expect(() => parse('<title>Verify you are human</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(normalizeEvriNumber('h0000 0000 0000 001')).toBe(NUMBER);
    expect(() => normalizeEvriNumber('12345678')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('Evri International delivery partners', () => {
  const partner = (label: string, number: string) => html
    .replace('Example Delivery Partner', label)
    .replaceAll('CI000000005NL', number);

  it('names USPS for OSM Worldwide\'s expedited line, by its routing barcode without the ZIP code', () => {
    // A synthetic PIC behind a routing ZIP of zeros; the check digit is calculated independently.
    const barcode = '42000000' + '9210090000000012345679';
    const result = parse(partner('Smart Kargo - OSM Expedited', barcode), NUMBER);
    expect(result).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: barcode });
    expect(normalizeCarrierResult(result)).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9210090000000012345679' });
    expect(parse(partner('Smart Kargo - OSM Expedited', 'CI000000005NL'), NUMBER)).not.toHaveProperty('delivery_carrier');
  });

  it('names the partner and its number when the label maps and the number is that carrier\'s', () => {
    expect(parse(partner('Paack 48H', 'PK000000000000000001'), NUMBER))
      .toMatchObject({ delivery_carrier: 'paack', delivery_tracking_number: 'PK000000000000000001' });
    expect(parse(partner('Hermes HSI Courier', 'H1000000000000000003'), NUMBER))
      .toMatchObject({ delivery_carrier: 'hermes-de', delivery_tracking_number: 'H1000000000000000003' });
  });

  it('names nobody for an unmapped label, a number of another shape or the Evri barcode again', () => {
    for (const value of [
      html,
      partner('Paack 48H', 'PK00000000000000001'),
      partner('GLS Italy', 'CI000000005NL'),
      partner('AnPost Direct', NUMBER),
      partner('Paack 48H', NUMBER),
    ]) {
      const result = parse(value, NUMBER);
      expect(result.delivery_carrier).toBeUndefined();
      expect(result.delivery_tracking_number).toBeUndefined();
    }
  });

  it('maps each label to an automatic catalog carrier with its own adapter', () => {
    for (const label of ['Paack 48H', 'Colis Prive', 'Hermes HSI Courier', 'GLS Italy', 'DHL Connect', 'Spring Tracked',
      'Cross Border Connect SpeedX', 'Mondial Point Relais delivery PUDO', 'Smart Kargo - OSM Expedited']) {
      const carrier = evriPartner(label);
      expect(carrier, label).toBeDefined();
      const definition = CARRIER_DEFINITIONS[carrier as keyof typeof CARRIER_DEFINITIONS];
      expect(definition.tracking.mode, label).toBe('automatic');
      expect(definition.tracking.adapter, label).toBe(carrier);
    }
    expect(evriPartner('paack 48h ')).toBe('paack');
    expect(evriPartner('Evri 48H Courier')).toBeUndefined();
  });

  it('answers only for its own barcode when the tracker found the parcel by a partner number', () => {
    expect(() => parse(html, 'H000000000000002')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Evri International retrieval', () => {
  it('uses one cookie-free bounded form POST and the caller-provided transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(html));
    const carrier = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(carrier.track({ number: NUMBER }, { budgetMs: 1234.5 })).resolves.toMatchObject({ status: 'exception' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://globaleco.app/track', expect.objectContaining({
      method: 'POST', body: `tracking_number=${NUMBER}`, cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': DEFAULT_USER_AGENT },
    }));
  });

  it.each([403, 404, 410, 429, 503])('does not report endpoint HTTP %i as a missing parcel', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status }));
    await expect(new EvriTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({
      kind: [404, 410].includes(status) ? 'transport' : status === 403 ? 'challenge' : status === 429 ? 'rate_limited' : 'maintenance',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized responses and respects caller cancellation', async () => {
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(html, { headers: { 'content-length': '1000001' } }));
    await expect(new EvriTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response(html);
    });
    await expect(new EvriTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    fetcher.mockClear();
    await expect(new EvriTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a parcel from the same POST and reads only the not-found heading as unknown', async () => {
    const recognize = (reply: () => Response, number: string) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
      return { fetcher, answer: adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} }).recognize!(number, { budgetMs: 1_000 }) };
    };
    await expect(recognize(() => new Response(html), NUMBER).answer).resolves.toMatchObject({ known: true });
    await expect(recognize(() => new Response(empty), UNKNOWN).answer).resolves.toEqual({ known: false });
    await expect(recognize(() => new Response('Unavailable', { status: 503 }), NUMBER).answer).rejects.toMatchObject({ kind: 'maintenance' });
    const invalid = recognize(() => new Response(html), 'invalid');
    await expect(invalid.answer).resolves.toEqual({ known: false });
    expect(invalid.fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid input and timeout without making a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new EvriTracker({ fetcher }).fetch('invalid')).rejects.toMatchObject({ kind: 'invalid_input' });
    for (const budgetMs of [0, -1, NaN, Infinity]) await expect(new EvriTracker({ fetcher }).fetch(NUMBER, { budgetMs })).rejects.toThrow('positive');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
