import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { validateInstaboxTrackingUrl } from '../../core/catalog/urls.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { parseInstabox } from './parser.js';

const number = 'IB9990000001';
const code = 'synthetic-notification-code';
const url = `https://track.instabox.com/sv/${number}/locker-to-locker-recipient?authCode=${code}`;
const fixture = (identity = number) => {
  const items = [
    { id: 'synthetic-collected', title: 'Example City, SE', subtitle: '2031-04-18T15:00:00.123Z', description: 'Ditt paket har hämtats upp', icon: 'CHECKMARK' },
    { id: 'synthetic-locker', title: 'Example City, SE', subtitle: '2031-04-18T10:00:00.000Z', description: 'Ditt paket är framme i skåpet', icon: 'CHECKMARK' },
    { id: 'synthetic-registered', subtitle: '2031-04-16T10:00:00.000Z', description: 'Vi har fått information om en kommande leverans', icon: 'CHECKMARK' },
  ];
  const models = [
    ['$', '$L33', null, { items }],
    ['$', '$L34', null, { value: identity, itemName: 'Paket-ID' }],
    ['$', 'div', null, { phone: 'PRIVATE', verificationCode: code }],
  ];
  const flight = '33:I["synthetic-module",[],"ParcelJourneyItems"]\n34:I["synthetic-module",[],"CopyTextButton"]\n18:' + JSON.stringify(models) + '\n';
  return `<html><script>self.__next_f.push(${JSON.stringify([1, flight])})</script></html>`;
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

describe('Instabox notifications', () => {
  it('reads the complete server-rendered journey without executing scripts or returning recipient details', () => {
    const result = parseInstabox(fixture(), number);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2031-04-18T15:00:00.123Z',
      events: [{ stage: 'delivered' }, { stage: 'ready_for_pickup' }, { stage: 'registered' }] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain(code);
    expect(() => parseInstabox(fixture('IB9990000002'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseInstabox(fixture().replace('ParcelJourneyItems', 'AnotherComponent'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInstabox(fixture().replace('15:00:00.123Z', '15:00:00'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInstabox('<script>globalThis.executed=true</script>', number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds a notification to one carrier host, one full identifier and one verification code', () => {
    expect(validateInstaboxTrackingUrl(url + '&utm_source=Instabox', number)).toBe(url);
    expect(normalizeCarrierInputs('instabox', number, url, '')).toEqual({ trackingUrl: url, postcode: null });
    expect(normalizeCarrierInputs('instabox', number, '', '')).toEqual({ trackingUrl: null, postcode: null });
    expect(parseTrackingInput(url)).toMatchObject({ trackingNumber: number, carrier: 'instabox', trackingUrl: url });
    for (const invalid of [url.replace('https:', 'http:'), url.replace('track.instabox.com', 'example.test'),
      url.replace('track.instabox.com', 'user@track.instabox.com'), url + '#extra', url + '&authCode=' + code,
      url + '&c=' + code, url.replace(number, number + '0'), url.replace('locker-to-locker-recipient', 'change-phone'),
      url.replace(code, 'short'), url + '&returnUrl=https://example.test']) {
      expect(() => validateInstaboxTrackingUrl(invalid, number), invalid.replace(code, '<synthetic>')).toThrow(TypeError);
    }
  });

  it('routes an accepted notification through the adapter and follows a bound legacy redirect', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(fixture()));
    await expect(createTracker({ fetcher, env: {}, providers: [] }).track({ number, carrier: 'instabox', trackingUrl: url }))
      .resolves.toMatchObject({ carrier: 'instabox', source: 'instabox', result: { current_stage: 'delivered' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const failed = vi.fn<typeof fetch>(async () => { throw new Error(url); });
    const network: unknown = await carrier(failed).track({ number, trackingUrl: url }).catch(value => value);
    expect(network).toMatchObject({ kind: 'transport' });
    expect(String((network as Error).cause)).not.toContain(code);
    expect(fetcher.mock.calls[0]![1]?.signal).toBeDefined();
    const legacy = `https://track.instabox.com/sv-SE/${number}?c=${code}`;
    const redirected = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: url } }))
      .mockResolvedValueOnce(new Response(fixture()));
    await expect(carrier(redirected).track({ number, trackingUrl: legacy })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(redirected).toHaveBeenCalledTimes(2);
  });

  it('keeps bad links and upstream failures distinct from missing parcels and drops capability diagnostics', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('gateway error', { status: 502 }));
    const error: unknown = await carrier(fetcher).track({ number, trackingUrl: url }).catch(value => value);
    expect(error).toMatchObject({ kind: 'indeterminate' });
    expect(JSON.stringify(error)).not.toContain(code);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const verify = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { Location: `/sv/${number}/verify` } }));
    await expect(carrier(verify).track({ number, trackingUrl: url })).rejects.toMatchObject({ kind: 'indeterminate' });
    const outside = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }));
    await expect(carrier(outside).track({ number, trackingUrl: url })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(outside).toHaveBeenCalledTimes(1);
    expect(() => carrier(fetcher).track({ number })).toThrow(expect.objectContaining({ kind: 'input_required' }));
    await expect(carrier(fetcher).track({ number, trackingUrl: url }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
  });
});
