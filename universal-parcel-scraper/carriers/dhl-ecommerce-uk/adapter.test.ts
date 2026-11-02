import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import statuses from './statuses.json' with { type: 'json' };
import { DhlEcommerceUkTracker, adapter } from './adapter.js';
import { normalizeDhlEcommerceUkNumber, parseDhlEcommerceUk } from './parser.js';
import { dhlEcommerceUkStage } from './status.js';

const NUMBER = '99990000000000';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const environment = (fetcher: typeof fetch) => ({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher });
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('DHL eCommerce UK parser', () => {
  it('reads a delivered shipment, newest scan first', () => {
    const result = normalizeCarrierResult(parseDhlEcommerceUk(fixture('delivered'), NUMBER));
    expect(result.status).toBe('delivered');
    expect(result.current_stage).toBe('delivered');
    expect(result.last_status_text).toBe('Your shipment is delivered');
    expect(result.last_update).toBe('2026-04-03T18:19:00+01:00');
    expect(result.delivered_at).toBe('2026-04-03T18:19:00+01:00');
    expect(result.expected_delivery).toBeNull();
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted']);
    expect(result.events?.[0]).toMatchObject({ stage_source: 'carrier_map' });
  });

  it('keeps the planned day while the shipment is on its way', () => {
    const result = parseDhlEcommerceUk(fixture('in-transit'), NUMBER);
    expect(result.status).toBe('in_transit');
    expect(result.expected_delivery).toBe('2026-04-03');
    expect(result.delivered_at).toBeUndefined();
  });

  it('drops a planned day that has passed', () => {
    const page = fixture('in-transit').replace('due to be delivered on Friday 03rd April 2026', 'due to be delivered on Thursday 02nd April 2026');
    expect(parseDhlEcommerceUk(page, NUMBER).expected_delivery).toBeNull();
  });

  it('follows the newest row when a depot scan comes after a delivery scan', () => {
    const row = (date: string, clock: string, text: string) => `<tr><td>${date}</td><td>${clock}</td><td>${text}</td></tr>`;
    const page = fixture('in-transit').replace('<tr><td nowrap="nowrap">03rd April 2026',
      `${row('04th April 2026', '01:32', `Your shipment ${NUMBER} is at the delivery depot`)}${row('03rd April 2026', '15:10', `Your shipment ${NUMBER} is delivered`)}<tr><td nowrap="nowrap">03rd April 2026`);
    const result = parseDhlEcommerceUk(page, NUMBER);
    expect(result.current_stage).toBe('in_transit');
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads rows that name no shipment', () => {
    const page = fixture('delivered').replace(`Your shipment ${NUMBER} is delivered</td>`, 'Collected</td>')
      .replace(`Your shipment ${NUMBER} is out for delivery</td>`, 'Delivery Attempted</td>');
    const result = parseDhlEcommerceUk(page, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-04-03T18:19:00+01:00', last_status_text: 'Collected' });
    expect(result.events?.slice(0, 2)).toMatchObject([{ stage: 'delivered' }, { description: 'Delivery Attempted', stage: 'failed_attempt' }]);
  });

  it('reads a return the headline announces after a refusal', () => {
    const row = (clock: string, text: string) => `<tr><td>03rd April 2026</td><td>${clock}</td><td>${text}</td></tr>`;
    const page = fixture('in-transit')
      .replace(/<h3>[^<]*<\/h3>/, `<h3>Your shipment ${NUMBER} (1 parcel expected) has now been returned to the sender. Please contact your sender for further information</h3>`)
      .replace('<tr><td nowrap="nowrap">03rd April 2026', `${row('14:09', `Your shipment ${NUMBER} is at the delivery depot`)}${row('10:39', `We’re sorry but your shipment ${NUMBER} was refused on delivery. Please contact your sender for further information`)}<tr><td nowrap="nowrap">03rd April 2026`);
    const result = parseDhlEcommerceUk(page, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
    expect(result.events?.slice(0, 2).map((event) => event.stage)).toEqual(['in_transit', 'exception']);
  });

  it('reads a winter clock in British time', () => {
    const page = fixture('delivered').replaceAll('April', 'January');
    expect(normalizeCarrierResult(parseDhlEcommerceUk(page, NUMBER)).last_update).toBe('2026-01-03T18:19:00+00:00');
  });

  it('keeps the signatory and the sender reference out of the result', () => {
    const output = JSON.stringify(parseDhlEcommerceUk(fixture('delivered'), NUMBER));
    expect(output).not.toMatch(/Example|REF-EXAMPLE|Signed for/);
    expect(output).not.toContain(NUMBER);
  });

  it('keeps an unlisted sentence without a stage', () => {
    const page = fixture('in-transit').replace(`Your shipment ${NUMBER} is at the delivery depot</td>`, `Your shipment ${NUMBER} is held for inspection</td>`);
    const result = parseDhlEcommerceUk(page, NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.events?.[0]).toEqual({ description: 'Your shipment is held for inspection', time: '2026-04-03T01:32:00+01:00' });
  });

  it('reads the page notice as a missing shipment', () => {
    expect(() => parseDhlEcommerceUk(fixture('missing'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('does not read an empty page, a block or another notice as a missing shipment', () => {
    expect(() => parseDhlEcommerceUk(fixture('no-lookup'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDhlEcommerceUk('<html><body>Request Rejected. Your support ID is 1</body></html>', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDhlEcommerceUk(fixture('missing').replace('We are unable to find a match', 'We are unable to show'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a page about another shipment', () => {
    expect(() => parseDhlEcommerceUk(fixture('delivered'), '99990000000001')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const mixed = fixture('delivered').replace(`Your shipment ${NUMBER} is out for delivery`, 'Your shipment 99990000000001 is out for delivery');
    expect(() => parseDhlEcommerceUk(mixed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects changed columns', () => {
    expect(() => parseDhlEcommerceUk(fixture('delivered').replace('<td>Message</td>', '<td>Photo</td>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts shipment and return numbers only', () => {
    expect(normalizeDhlEcommerceUkNumber(' 9999 0000 000000 ')).toBe(NUMBER);
    expect(normalizeDhlEcommerceUkNumber('999999999')).toBe('999999999');
    for (const value of ['', '1234567', '899999999', '999900000000001', 'JD014600000000000000']) {
      expect(() => normalizeDhlEcommerceUkNumber(value)).toThrow(InvalidInputError);
    }
  });

  it('maps every listed sentence to a known stage', () => {
    for (const entry of statuses.entries) {
      expect(STAGES).toContain(entry.stage);
      expect(dhlEcommerceUkStage(entry.wording.replace("'", '’'))).toBe(entry.stage);
    }
  });
});

describe('DHL eCommerce UK adapter', () => {
  it('asks the tracking page for the number and no postcode', async () => {
    const requests: string[] = [];
    const tracker = new DhlEcommerceUkTracker({ fetcher: async (input) => { requests.push(String(input)); return html(fixture('delivered')); } });
    const result = await tracker.fetch(NUMBER);
    expect(requests).toEqual([`https://track.dhlecommerce.co.uk/?con=${NUMBER}`]);
    expect(result.status).toBe('delivered');
  });

  it('reports a missing shipment and an unavailable page apart', async () => {
    await expect(new DhlEcommerceUkTracker({ fetcher: async () => html(fixture('missing')) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(new DhlEcommerceUkTracker({ fetcher: async () => html('<html><body>Request Rejected</body></html>') }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('recognizes a shipment the page knows', async () => {
    const instance = adapter(environment(async () => html(fixture('delivered'))));
    await expect(instance.recognize?.(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-03T17:19:00.000Z' });
    const absent = adapter(environment(async () => html(fixture('missing'))));
    await expect(absent.recognize?.(NUMBER)).resolves.toEqual({ known: false });
    await expect(absent.recognize?.('JVGL0099999999')).resolves.toEqual({ known: false });
  });

  it('asks recognition only about the ranges its page shows', () => {
    const asked = (number: string) => recognitionCandidates(number, { hint: 'dhl-ecommerce-uk' }).map(({ carrier }) => carrier);
    for (const number of ['60120000000001', '31000000000001', '41000000000001', '55000000000001']) expect(asked(number)[0], number).toBe('dhl-ecommerce-uk');
    expect(detectCarrierMatch('12000000000001').candidates).toContain('dhl-ecommerce-uk');
    expect(asked('12000000000001')).not.toContain('dhl-ecommerce-uk');
  });
});
