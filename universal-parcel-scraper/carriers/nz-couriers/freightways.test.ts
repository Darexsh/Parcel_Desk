import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { activeRequirements } from '../../core/catalog/index.js';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { validateFreightwaysTrackingUrl } from '../../core/catalog/urls.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { freightwaysApi, parseFreightways, type FreightwaysNetwork } from './freightways.js';
import { NEW_ZEALAND_COURIERS } from './parser.js';
import { POST_HASTE } from '../post-haste/parser.js';
import { CASTLE_PARCELS } from '../castle-parcels/parser.js';
import { NOW_COURIERS } from '../now-couriers/parser.js';

// Synthetic: a customer printed label's consignment number and a sender's account.
const NUMBER = 'ZZZZ047193';
const ACCOUNT = '0000000';
const LOOKUP = 'https://public-website.ep-prod.freightways.co.nz/public-website/v2/carriers';

const NETWORKS: readonly [FreightwaysNetwork, string, string][] = [
  [NEW_ZEALAND_COURIERS, 'nzcouriers.co.nz', 'nzc'],
  [POST_HASTE, 'posthaste.co.nz', 'phl'],
  [CASTLE_PARCELS, 'castleparcels.co.nz', 'cpl'],
  [NOW_COURIERS, 'nowcouriers.co.nz', 'now'],
];

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/customer-label.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const empty = () => new Response(null, { status: 204 });
const carrier = (network: FreightwaysNetwork, fetcher: typeof fetch) =>
  REGISTRY.factories[network.carrier]!({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe.each(NETWORKS)('$provider tracking links with the sender’s account', (network, domain, code) => {
  const composite = `https://receiver.${domain}/?consignmentid=CU..${NUMBER}.Z.${ACCOUNT}.1`;
  const customerLabel = `https://receiver.${domain}/?request_id=3&customer_number=${ACCOUNT}&consignment_id=${NUMBER}`;
  const servlet = `http://www.${domain}:80/${code}/servlet/ITNG_TAndTServlet?page=1&VCCA=Enabled&Key_Type=CustomerLabel`
    + `&customer_number=${ACCOUNT}&consignment_id=${NUMBER}`;
  const accountLookup = `${LOOKUP}/${network.path}/customers/${ACCOUNT}/consignments/${NUMBER}/tracking-events`;

  it('keeps a pasted receiver or servlet link that names the account, and no other', () => {
    for (const link of [composite, `https://receiver.${domain}/?consignmentId=CU..${NUMBER}.Z.${ACCOUNT}.1&utm_source=email`,
      servlet, customerLabel]) {
      expect(parseTrackingInput(`Track it: ${link}`), link)
        .toMatchObject({ trackingNumber: NUMBER, carrier: network.carrier, confidence: 'high', trackingUrl: link, source: 'link' });
    }
    for (const link of [`https://receiver.${domain}/?track=${NUMBER}`, `https://receiver.${domain}/?consignment_id=${NUMBER}`,
      `https://tools.${domain}/${code}/servlet/ITNG_TAndTServlet?Key_Type=Charge&customer_number=${ACCOUNT}&label_number=01234567`,
      `https://receiver.${domain}/?manifest_customer_number=${ACCOUNT}&consignment_id=${NUMBER}`]) {
      const match = parseTrackingInput(link);
      expect(match.carrier, link).toBe(network.carrier);
      expect(match.trackingUrl, link).toBeUndefined();
    }
  });

  it('offers the link as an optional input and keeps it as a receiver link bound to the network and the number', () => {
    expect(activeRequirements(network.carrier, NUMBER)).toMatchObject([{ field: 'trackingUrl', validator: 'freightwaysCapabilityUrl', optional: true }]);
    expect(normalizeCarrierInputs(network.carrier, NUMBER, '', '')).toEqual({ trackingUrl: null, postcode: null });
    expect(normalizeCarrierInputs(network.carrier, NUMBER, ` ${composite.toLowerCase().replace('cu..', 'CU..')}&token=synthetic `, ''))
      .toEqual({ trackingUrl: composite, postcode: null });
    expect(validateFreightwaysTrackingUrl(servlet, NUMBER.toLowerCase(), network.carrier)).toBe(customerLabel);
    expect(validateFreightwaysTrackingUrl(
      `https://receiver.${domain}/?key_type=customerlabel&customer_id=${ACCOUNT}&consignment_id_ref=${NUMBER}`, NUMBER, network.carrier))
      .toBe(customerLabel);
    const other = NETWORKS.find(([candidate]) => candidate !== network)![1];
    for (const invalid of [
      composite.replace(domain, other), composite.replace(NUMBER, 'ZZZZ047194'), `https://receiver.${domain}/?consignmentid=CU..${NUMBER}`,
      `https://receiver.${domain}/?track=${NUMBER}`, servlet.replace(`customer_number=${ACCOUNT}&`, ''),
      `${customerLabel}&consignment_id=ZZZZ047194`, composite.replace('https://', 'ftp://'), composite.replace('https://', 'https://user@'),
      composite.replace(`${domain}/`, `${domain}:8443/`), `https://receiver.${domain}.example.invalid/?consignmentid=CU..${NUMBER}.Z.${ACCOUNT}.1`,
      `https://receiver.${domain}/parcels?consignmentid=CU..${NUMBER}.Z.${ACCOUNT}.1`, 'not a link',
    ]) {
      expect(() => normalizeCarrierInputs(network.carrier, NUMBER, invalid, ''), invalid).toThrow(TypeError);
    }
  });

  it('asks the receiver site’s lookup with the account first, and keeps the label’s creation it gives without a type', async () => {
    const body = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
    const result = await carrier(network, fetcher).track({ number: NUMBER, trackingUrl: composite });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([accountLookup]);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      delivered_at: '2026-04-07T19:17:00.977Z' });
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage ?? null, event.description])).toEqual([
      ['2026-04-07T19:17:00.977Z', 'D', 'delivered', 'Delivered'],
      ['2026-04-07T18:35:17.183Z', 'ONBD', 'out_for_delivery', 'Out for Delivery'],
      // The label's creation is dated after the pickup.
      ['2026-04-06T04:09:16Z', null, 'registered', 'Label Created'],
      ['2026-04-06T03:16:59Z', 'P', 'accepted', 'Picked Up'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Signer|example\.invalid/);
    // The servlet's link is asked the same way.
    await expect(carrier(network, vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number: NUMBER, trackingUrl: servlet }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it('asks the number alone when the account does not find it, and refuses another sender’s consignment', async () => {
    const fallback = vi.fn<typeof fetch>().mockResolvedValueOnce(empty()).mockResolvedValueOnce(reply(fixture()));
    await expect(carrier(network, fallback).track({ number: NUMBER, trackingUrl: composite })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fallback.mock.calls.map(([url]) => String(url))).toEqual([accountLookup, `${freightwaysApi(network)}?query=${NUMBER}`]);
    // A number only the account's lookup takes is asked once.
    const once = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    const longer = 'ZZ0000000001';
    await expect(carrier(network, once).track({ number: longer, trackingUrl: composite.replace(NUMBER, longer) }))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(once).toHaveBeenCalledTimes(1);
    await expect(carrier(network, vi.fn<typeof fetch>()).track({ number: longer })).rejects.toMatchObject({ kind: 'invalid_input' });
    // A reply that heads with another account is another consignment.
    const another = vi.fn<typeof fetch>().mockResolvedValue(reply({ ...fixture(), shortConsignmentId: `1111111 ${NUMBER}` }));
    await expect(carrier(network, another).track({ number: NUMBER, trackingUrl: composite })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parseFreightways(network, { ...fixture(), shortConsignmentId: `${ACCOUNT} ${NUMBER}` }, NUMBER, ACCOUNT)).not.toThrow();
    // A link of another number never reaches the lookup.
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(network, unused).track({ number: NUMBER, trackingUrl: composite.replace(NUMBER, 'ZZZZ047194') }))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('takes the link through the facade', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture()));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: network.carrier, trackingUrl: servlet }))
      .resolves.toMatchObject({ carrier: network.carrier, source: network.carrier, result: { current_stage: 'delivered' } });
    expect(String(fetcher.mock.calls[0]![0])).toBe(accountLookup);
  });
});
