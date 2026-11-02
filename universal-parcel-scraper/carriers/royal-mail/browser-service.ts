import type { BrowserServer } from 'playwright-core';
import { loadChromium } from '../../core/transport/optional.js';

/** A private Playwright service. Its capability path and process environment never enter browser pages. */
export async function startRoyalMailBrowserService(env: Readonly<Record<string, string | undefined>>): Promise<BrowserServer> {
  const executablePath = env.TRACKING_CHROMIUM_PATH?.trim();
  if (!executablePath) throw new TypeError('Royal Mail browser service requires TRACKING_CHROMIUM_PATH');
  const wsPath = env.ROYAL_MAIL_BROWSER_WS_PATH ?? '';
  if (!/^\/[A-Za-z0-9_-]{32,128}$/.test(wsPath)) {
    throw new TypeError('ROYAL_MAIL_BROWSER_WS_PATH must be an unguessable path of 32 to 128 URL-safe characters');
  }
  const rawPort = env.ROYAL_MAIL_BROWSER_PORT ?? '3001';
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
  if (port < 1 || port > 65535) throw new TypeError('Invalid Royal Mail browser service port');
  const chromium = await loadChromium('Royal Mail');
  return chromium.launchServer({ executablePath, headless: true, host: '127.0.0.1', port, wsPath,
    args: ['--disable-blink-features=AutomationControlled'], timeout: 20_000,
    env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '/tmp', LANG: 'en_US.UTF-8' } });
}
