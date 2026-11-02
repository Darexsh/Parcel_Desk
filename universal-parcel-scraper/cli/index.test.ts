import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputRequiredError, SchemaError } from '../core/errors/index.js';
import { TrackingError } from '../facade/index.js';
import { failureText, main } from './index.js';

const number = '1Z999AA10123456784';
afterEach(() => {
  // `serve` closes its server on these signals; emitting one here ends it without ending the test process.
  process.emit('SIGTERM');
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('command line', () => {
  it('detects and lists carriers whatever the transport settings are', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { FLARESOLVERR_URL: 'localhost:8191', SCRAPER_PROVIDERS: 'ship24' };
    await expect(main(['detect', number], env)).resolves.toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ carrier: 'ups', confidence: 'high' });
    await expect(main(['carriers'], env)).resolves.toBe(0);
    expect(JSON.parse(log.mock.calls[1]![0] as string)).toHaveProperty('ups');
  });

  it('names the rejected command, option, setting or input before any lookup', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(main(['follow', number], {})).rejects.toThrow('Unknown command');
    await expect(main(['track'], {})).rejects.toThrow('Supply a tracking input');
    await expect(main(['carriers', 'ups'], {})).rejects.toThrow('Unexpected argument');
    await expect(main(['track', number, '--budget', '5'], {})).rejects.toThrow('Unknown or incomplete command option');
    await expect(main(['track', number], { SCRAPER_PROVIDERS: 'ship24' })).rejects.toThrow('Unknown universal provider');
    await expect(main(['track', number, '--source', 'ship24'], {})).rejects.toThrow('Unknown universal provider');
    await expect(main(['track', number], { FLARESOLVERR_URL: 'localhost:8191' })).rejects.toThrow('FLARESOLVERR_URL must be an HTTP(S) URL');
    await expect(main(['serve', '--port', '99999'], {})).rejects.toThrow('Invalid port');
    await expect(main(['track', number, '--carrier', 'nope'], {})).rejects.toThrow('Unknown carrier nope');
    await expect(main(['track', '12345678901234', '--carrier', 'gls-ch'], {})).rejects.toThrow('requires the four-digit delivery postcode');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks the provider --source names alone, whatever SCRAPER_PROVIDERS enables', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      carriers: ['Universal Postal Union'], states: [{ date: '2026-01-02T12:00:00Z', status: 'Delivered', carrier: 0 }] }));
    await expect(main(['track', number, '--source', 'ParcelsApp'], { SCRAPER_PROVIDERS: 'UPU' })).resolves.toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ carrier: 'ups', source: 'ParcelsApp',
      attempts: [{ source: 'ParcelsApp', kind: 'ok' }] });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([expect.stringContaining('parcelsapp')]);
  });

  it('prints those messages and keeps every other failure generic', () => {
    expect(failureText(new TypeError('Invalid port'))).toBe('Invalid port');
    expect(failureText(new RangeError('Unknown carrier nope'))).toBe('Unknown carrier nope');
    expect(failureText(new InputRequiredError('Tracking', 'carrier', 'Choose a carrier for this number'))).toBe('Choose a carrier for this number');
    expect(failureText(Object.assign(new Error('listen EADDRINUSE: address already in use'), { syscall: 'listen' }))).toContain('EADDRINUSE');
    expect(failureText(new SchemaError('UPS', 'private payload'))).toBe('Tracking could not be completed');
    expect(failureText(new Error('private payload'))).toBe('Tracking could not be completed');
    expect(JSON.parse(failureText(new TrackingError([{ source: 'ups', kind: 'not_found', durationMs: 1 }], { kind: 'not_found' }))))
      .toEqual({ error: 'No enabled source returned tracking history', attempts: [{ source: 'ups', kind: 'not_found', durationMs: 1 }], hint: { kind: 'not_found' } });
  });
});

describe('serve configuration', () => {
  it('applies the request limit and trusted proxy count from the environment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const port = await freePort();
    await expect(main(['serve', '--port', String(port)], { SCRAPER_RATE_LIMIT: '1', SCRAPER_TRUSTED_PROXIES: '1' })).resolves.toBe(0);
    const carriers = (forwarded: string) => fetch(`http://127.0.0.1:${port}/v1/carriers`, { headers: { 'X-Forwarded-For': forwarded } });
    expect((await carriers('198.51.100.7')).status).toBe(200);
    expect((await carriers('198.51.100.7')).status).toBe(429);
    expect((await carriers('198.51.100.8')).status).toBe(200);
  });

  it('refuses a limit that is not a whole number before listening', async () => {
    for (const name of ['SCRAPER_RATE_LIMIT', 'SCRAPER_MAX_CONCURRENT', 'SCRAPER_CACHE_MS', 'SCRAPER_FAILURE_CACHE_MS', 'SCRAPER_TRUSTED_PROXIES']) {
      await expect(main(['serve', '--port', '8080'], { [name]: 'many' })).rejects.toThrow(`${name} must be a whole number`);
    }
    await expect(main(['serve', '--port', '8080'], { SCRAPER_USER_AGENT: 'Exämple/1.0' })).rejects.toThrow(TypeError);
  });
});
