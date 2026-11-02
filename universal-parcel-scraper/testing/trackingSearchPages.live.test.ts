import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromium, devices, type Browser, type Frame, type Page, type Response } from 'playwright-core';
import { CARRIERS } from '../core/catalog/index.js';
import type { CarrierId } from '../generated/catalog.js';
import { searchPageVerdict } from './trackingLinkProbe.js';
import { countNumberFields, FIELD_SELECTOR, uncheckedSearchPages } from './trackingSearchPages.js';

const RENDER_WINDOW_MS = 15_000;

// Several carriers share one page; each page is opened once.
const searchPages = [...Object.values(CARRIERS).reduce((pages, carrier) => {
  if (carrier.trackingSearchUrl && !uncheckedSearchPages[carrier.id]) {
    pages.set(carrier.trackingSearchUrl, [...pages.get(carrier.trackingSearchUrl) ?? [], carrier.id]);
  }
  return pages;
}, new Map<string, CarrierId[]>())].map(([url, carriers]) => ({ url, name: carriers.join(', ') }));

/** Visible, enabled fields that are neither a sign-in field nor the site's own search. */
function frameFields(frame: Frame): Promise<number> {
  const counted = frame.locator(FIELD_SELECTOR).evaluateAll(countNumberFields);
  // A frame whose host never answers would hold the check forever.
  return Promise.race([counted, new Promise<number>((resolve) => setTimeout(() => resolve(0), 5000))]).catch(() => 0);
}

async function numberFields(page: Page): Promise<number> {
  const counts = await Promise.all(page.frames().map(frameFields));
  return counts.reduce((sum, count) => sum + count, 0);
}

describe('carrier search pages (rendered at phone size)', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: process.env.TRACKING_CHROMIUM_PATH || chromium.executablePath(),
      headless: true,
    });
  });
  afterAll(async () => { await browser?.close(); });

  // The app links these pages when a shared parcel hides its number, and it is
  // read mostly on phones, where some trackers drop the field they show on a desktop.
  it.for(searchPages)('$name shows a field for the number', { timeout: RENDER_WINDOW_MS + 45_000, concurrent: true }, async ({ url }, context) => {
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 15'];
    const phoneContext = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale: 'en-US' });
    const page = await phoneContext.newPage();
    let documentStatus: number | undefined;
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documentStatus = response.status();
    });
    try {
      let response: Response | null;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (error) {
        // A headless transport failure is inconclusive when the page still answers plain HTTP.
        const http = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
        if (http?.ok && process.env.TRACKING_LINKS_STRICT !== '1') {
          console.warn(url + ': HTTP endpoint reachable; browser transport unverified');
          context.skip('HTTP endpoint reachable; browser transport failed, search page remains unverified');
        }
        throw error;
      }
      let fields = 0;
      // Allow hydration and client redirects; stop at the first field.
      for (let waited = 0; waited < RENDER_WINDOW_MS && fields === 0; waited += 1000) {
        await page.waitForTimeout(1000);
        fields = await numberFields(page);
      }
      const title = await page.title().catch(() => '');
      const verdict = searchPageVerdict({
        status: documentStatus ?? response?.status() ?? 0, url: page.url(), title,
        text: await page.locator('body').innerText({ timeout: 3000 }).catch(() => ''),
      }, fields);
      // Skipped is deliberately not a pass: bot protection cannot prove the page works.
      if ((verdict === 'blocked' || verdict === 'unverified') && process.env.TRACKING_LINKS_STRICT !== '1') {
        console.warn(url + ': carrier bot protection; search page unverified');
        context.skip(verdict === 'blocked' ? 'Carrier bot protection: search page remains unverified'
          : 'The page rendered nothing to an automated browser: search page remains unverified');
      }
      // Address and title only, like the tracking links.
      context.expect(verdict, `Expected a field to type a tracking number in; landed on ${page.url()} titled ${JSON.stringify(title)}`)
        .toBe('search-page');
    } finally {
      await phoneContext.close();
    }
  });
});
