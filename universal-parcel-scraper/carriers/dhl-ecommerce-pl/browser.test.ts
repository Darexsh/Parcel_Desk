import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { dhlPolandBrowser, parseDhlPolandHistory } from './browser.js';

const WAYBILL = '99999999990';
const ENDPOINT = 'https://sprawdz.dhl.com.pl/';
const history = () => ({ number: WAYBILL, events: [
  { date: '04.03.2026', time: '10:15', location: 'Example delivery depot', description: 'Delivered to customer. The shipment received by PRIVATE' },
  { date: '04.03.2026', time: '08:30', location: 'Example delivery depot', description: 'With delivery courier' },
  { date: '03.03.2026', time: '15:20', location: 'Example foreign depot', description: 'The shipment is handled in Sorting Center' },
] });
const capture = () => ({ url: ENDPOINT, status: 200, trackingNumberSubmitted: WAYBILL, headers: {}, body: JSON.stringify(history()),
  truncated: false, base64Encoded: false, error: null });
const service = (responses = [capture()], statusCode = 200) => new TrawlClient('https://browser.example.test', async () =>
  Response.json({ success: true, tier: 2, statusCode, html: '', capturedResponses: responses }));

describe('DHL Poland browser history', () => {
  it('keeps facility clocks local, maps observed wording and excludes recipient names', () => {
    const result = parseDhlPolandHistory(history(), WAYBILL);
    expect(result.summary_only).toBe(false);
    expect(result.last_update_local).toBe('2026-03-04T10:15:00');
    expect(result.events?.map(event => [event.local_time, event.stage])).toEqual([
      ['2026-03-04T10:15:00', 'delivered'], ['2026-03-04T08:30:00', 'out_for_delivery'], ['2026-03-03T15:20:00', 'in_transit'],
    ]);
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(result).not.toHaveProperty('timezone');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const polish = history();
    polish.events[0]!.description = 'Przesyłka doręczona do Odbiorcy. Przesyłka odebrana przez PRIVATE';
    expect(parseDhlPolandHistory(polish, WAYBILL).events?.[0]?.stage).toBe('delivered');
    expect(JSON.stringify(parseDhlPolandHistory(polish, WAYBILL))).not.toContain('PRIVATE');
  });
  it('requires the complete waybill and valid rows, dates and clock readings', () => {
    for (const payload of [{ ...history(), number: '0' + WAYBILL }, { ...history(), number: Number(WAYBILL) },
      { ...history(), events: [null] }, { ...history(), events: [{ ...history().events[0], date: '31.02.2026' }] },
      { ...history(), events: [{ ...history().events[0], time: '24:00' }] }]) {
      expect(() => parseDhlPolandHistory(payload, WAYBILL)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDhlPolandHistory({ challenge: true }, WAYBILL)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDhlPolandHistory({ number: WAYBILL, events: [] }, WAYBILL)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it("reads the courier's delivery hours and a terminal's planned delivery day", () => {
    const payload = history();
    payload.events[1]!.description = 'With delivery courier. Expected delivery hours: 08:00-12:00.';
    payload.events[2]!.description = 'The shipment has reached DHL terminal in . Planned date of delivery to: 04-03-2026.';
    expect(parseDhlPolandHistory(payload, WAYBILL).events?.slice(1).map(event => event.stage)).toEqual(['out_for_delivery', 'in_transit']);
    // A terminal the page leaves unnamed reads without the empty slot.
    expect(parseDhlPolandHistory(payload, WAYBILL).events?.[2]?.description)
      .toBe('The shipment has reached DHL terminal. Planned date of delivery to: 04-03-2026.');
    payload.events[2]!.description = 'The shipment has reached DHL terminal in Example. Planned date of delivery to: 04-03-2026.';
    expect(parseDhlPolandHistory(payload, WAYBILL).events?.[2]?.stage).toBe('in_transit');
  });
  it('reads the scans of a parcel sent abroad', () => {
    const payload = history();
    payload.events[0]!.description = 'The shipment has been delivered to the recipient.';
    payload.events[1]!.description = 'The shipment has arrived at gateway in destination country.';
    payload.events[2]!.description = 'The shipment left the origin country';
    payload.events.push({ date: '02.03.2026', time: '15:06', location: '', description: 'The shipment has reached DHL terminal in .' });
    expect(parseDhlPolandHistory(payload, WAYBILL).events?.map(event => event.stage)).toEqual(['delivered', 'in_transit', 'in_transit', 'accepted']);
    expect(parseDhlPolandHistory(payload, WAYBILL).events?.[3]?.description).toBe('The shipment has reached DHL terminal.');
    payload.events[0]!.description = 'The shipment has arrived at delivery depot.';
    expect(parseDhlPolandHistory(payload, WAYBILL).events?.[0]?.stage).toBe('in_transit');
    // The page now words the delivery so; rows stored with the older wording keep it.
    payload.events[0]!.description = 'The shipment was delivered to the Recipient. The shipment received by PRIVATE';
    expect(parseDhlPolandHistory(payload, WAYBILL).events?.[0]).toMatchObject({ description: 'The shipment was delivered to the Recipient.', stage: 'delivered' });
  });
  it('keeps unknown and informational wording without guessing a stage', () => {
    const payload = history(); payload.events[0]!.description = 'The recipient was informed about the date of delivery.';
    expect(parseDhlPolandHistory(payload, WAYBILL).events?.[0]).not.toHaveProperty('stage');
  });
  it('requires request binding and lets the latest refusal override an earlier success', async () => {
    const signal = new AbortController().signal;
    await expect(dhlPolandBrowser(service(), WAYBILL, signal, 5000)).resolves.toMatchObject({ summary_only: false });
    await expect(dhlPolandBrowser(service([{ ...capture(), trackingNumberSubmitted: '99999999991' }]), WAYBILL, signal, 5000))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(dhlPolandBrowser(service([capture(), { ...capture(), status: 429, body: '' }]), WAYBILL, signal, 5000))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(dhlPolandBrowser(service([]), WAYBILL, signal, 5000)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(dhlPolandBrowser(service([{ ...capture(), truncated: true }]), WAYBILL, signal, 5000))
      .rejects.toMatchObject({ kind: 'transport' });
  });
});
