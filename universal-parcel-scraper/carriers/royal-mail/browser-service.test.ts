import { chromium } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { startRoyalMailBrowserService } from './browser-service.js';

vi.mock('playwright-core', () => ({ chromium: { launchServer: vi.fn() } }));
afterEach(() => { vi.mocked(chromium.launchServer).mockReset(); vi.restoreAllMocks(); });

it('binds the worker to loopback and gives Chrome only its operating environment', async () => {
  const server = { close: vi.fn() }; vi.mocked(chromium.launchServer).mockResolvedValue(server as never);
  const wsPath = '/' + 's'.repeat(40);
  await expect(startRoyalMailBrowserService({ TRACKING_CHROMIUM_PATH: '/test/chrome', ROYAL_MAIL_BROWSER_WS_PATH: wsPath,
    ROYAL_MAIL_BROWSER_PORT: '3001', PATH: '/test/bin', HOME: '/test/user', PRIVATE_TOKEN: 'PRIVATE' })).resolves.toBe(server);
  expect(chromium.launchServer).toHaveBeenCalledWith(expect.objectContaining({ executablePath: '/test/chrome', host: '127.0.0.1',
    headless: true, port: 3001, wsPath, env: { PATH: '/test/bin', HOME: '/test/user', LANG: 'en_US.UTF-8' } }));
});

it('rejects missing browser, weak paths and invalid ports without exposing settings', async () => {
  for (const env of [{}, { TRACKING_CHROMIUM_PATH: '/test/chrome', ROYAL_MAIL_BROWSER_WS_PATH: '/PRIVATE' },
    { TRACKING_CHROMIUM_PATH: '/test/chrome', ROYAL_MAIL_BROWSER_WS_PATH: '/' + 's'.repeat(40), ROYAL_MAIL_BROWSER_PORT: '99999' }]) {
    const error = await startRoyalMailBrowserService(env).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError); expect(String(error)).not.toContain('/PRIVATE');
  }
  expect(chromium.launchServer).not.toHaveBeenCalled();
});
