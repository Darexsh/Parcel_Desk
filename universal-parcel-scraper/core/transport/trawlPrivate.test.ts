import { describe, expect, it, vi } from 'vitest';
import { CarrierError, ChallengeError, RateLimitedError, UpstreamHttpError } from '../errors/index.js';
import { TrawlClient } from './trawl.js';
import { scopedTrawlCookies, trawlPrivateScrape } from './trawlPrivate.js';

const SECRET = 'SYNTHETIC-ONE-USE-VERIFICATION';
const request = { url: `https://carrier.invalid/?token=${SECRET}`, headers: { 'X-Session-Token': SECRET }, body: JSON.stringify({ token: SECRET }) };
const options = { provider: 'Synthetic Carrier', timeoutMs: 1000 };

describe('private TRAWL request failures', () => {
  it('reimports only approved domain cookies and excludes unrelated fields and origins', () => {
    const good = { domain: '.carrier.invalid', path: '/', name: 'guest_sid', value: SECRET, httpOnly: true, sameSite: 'Lax', unrelated: 'drop' };
    expect(scopedTrawlCookies([good, { ...good, domain: '.other.invalid' }, { ...good, domain: '.invalid' },
      { ...good, name: 'invalid;name' }, { ...good, value: 'bad\r\nvalue' }, { ...good, path: '/account' }], ['carrier.invalid'], 'https://carrier.invalid/tracking'))
      .toEqual([{ domain: '.carrier.invalid', path: '/', name: 'guest_sid', value: SECRET, httpOnly: true, sameSite: 'Lax' }]);
  });

  it.each([
    new Error(SECRET),
    new UpstreamHttpError('TRAWL', 503, undefined, undefined, {
      url: request.url, method: 'POST', headers: { Cookie: SECRET }, body: JSON.stringify(request), timeout_ms: 1000,
    }),
    new RateLimitedError('TRAWL', 4500, SECRET),
    new ChallengeError('TRAWL', SECRET),
    new Error(SECRET, { cause: new RateLimitedError('TRAWL', 7000, SECRET) }),
  ])('retains failure kind and status without request diagnostics or arbitrary messages', async failure => {
    const client = new TrawlClient('https://trawl.invalid');
    vi.spyOn(client, 'scrape').mockRejectedValue(failure);
    let error: unknown;
    try { await trawlPrivateScrape(client, request, options); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CarrierError);
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(SECRET);
    expect((error as Error).cause).toBeUndefined();
    if (failure instanceof RateLimitedError) expect(error).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 4500 });
    if (failure instanceof ChallengeError) expect(error).toMatchObject({ kind: 'challenge', status: 403 });
    if (failure instanceof UpstreamHttpError) expect(error).toMatchObject({ kind: failure.kind, status: 503 });
    if (failure.cause instanceof RateLimitedError) expect(error).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 7000 });
  });

  it('honors cancellation and starts no request after abort', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller cancelled');
    controller.abort(reason);
    const client = new TrawlClient('https://trawl.invalid');
    const scrape = vi.spyOn(client, 'scrape');
    await expect(trawlPrivateScrape(client, request, { ...options, signal: controller.signal })).rejects.toBe(reason);
    expect(scrape).not.toHaveBeenCalled();
  });

  it('does not treat a missing browser-service route as a missing parcel', async () => {
    const client = new TrawlClient('https://trawl.invalid', async () => new Response(SECRET, { status: 404 }));
    await expect(trawlPrivateScrape(client, request, options)).rejects.toMatchObject({ kind: 'transport', status: 404 });
  });
});
