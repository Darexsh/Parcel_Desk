import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dhlPolandNativeSources } from '/app/packages/tiers/src/utils/dhl-poland-native.mjs';
import { fastRecaptchaAudio } from '/app/packages/tiers/src/utils/recaptcha-audio.mjs';
import { logTierFailures } from '/app/apps/api/src/tier-failure-log.mjs';
import { trawlLicense } from '/app/packages/tiers/src/utils/license.mjs';

// Every caller of the reCAPTCHA solver stops once Google blocks or refuses its audio.
const solverPath = '/app/packages/tiers/src/solvers/recaptcha.ts';
const solver = fastRecaptchaAudio(readFileSync(solverPath, 'utf8'));
writeFileSync(solverPath, solver);
const nativeDir = '/app/packages/tiers/src/utils/dhl-poland-native';
const nativeSources = dhlPolandNativeSources(solver, readFileSync('/app/packages/tiers/src/solvers/stt.ts', 'utf8'));
mkdirSync(nativeDir, { recursive: true });
writeFileSync(`${nativeDir}/recaptcha.ts`, nativeSources.recaptcha);
writeFileSync(`${nativeDir}/stt.ts`, nativeSources.stt);
// TRAWL drops a result that arrives at its request deadline. Helpers, capture
// waits and CAPTCHA solvers end this long before it, which leaves time to close
// a context and return what was observed.
const reserveMs = 2_500;
// Tier 2 reuses a cached session; tiers 3 and 4 share one fresh-context task.
// Both must use the same capture semantics.
for (const [file, tier, fresh] of [['2.ts', '2', false], ['browser.ts', 'tier', true]]) {
  const path = `/app/packages/tiers/src/tiers/${file}`;
  const source = readFileSync(path, 'utf8');
  const needle = 'const pageCapture = attachPageCapture(page, capture)';
  if (source.split(needle).length !== 2) throw new Error('TRAWL source changed: review the tracking capture integration');
  const solverGuard = 'if (capture.solveEmbeddedCaptchas !== false && budget.remaining() > 5000)';
  if (source.split(solverGuard).length !== 2) throw new Error('TRAWL solver guard changed');
  const beforeSolve = 'const solveRemaining = Math.max(0, budget.remaining() - 2000)';
  if (source.split(beforeSolve).length !== 2) throw new Error('TRAWL solver integration changed');
  const documentCapture = 'captureBrowserDocument(page, capture, pageCapture, budget, screenshot)';
  if (source.split(documentCapture).length !== 2) throw new Error('TRAWL document capture integration changed');
  // The helpers open their own context, so they run before the tier opens one.
  const entry = 'if (!budget) throw new Error("Browser task requires an operation budget")';
  if (source.split(entry).length !== 2) throw new Error('TRAWL tier entry changed');
  const carrierRunners = `${entry}
  const carrierPage = !proxyUrl && ${fresh ? '!capture.sessionContext && ' : ''}!screenshot && (!method || method === "GET")
    && !body && !Object.keys(extraHeaders ?? {}).length
  const carrierRun = { url, handle, tier: ${tier}, maxTimeout: budget.remaining() - ${reserveMs}, capture,
    installPolicy: page => installOutboundPolicy(page, validateOutboundUrl) }
  if (carrierPage && dhlPolandBrowserNumber(url, capture)) {
    return await runDhlPolandBrowser({ ...carrierRun,
      solveNativeCaptcha: (page, timeout, report) => solveDhlPolandNative(page, timeout, budget.signal, report) })
  }
  if (carrierPage && asendiaBrowserNumber(url, capture)) return await runAsendiaBrowser(carrierRun)
  if (carrierPage && correiosBrowserNumber(url, capture)) return await runCorreiosBrowser(carrierRun)
  if (carrierPage && track718JuxiNumber(url, capture)) return await runTrack718Juxi({ ...carrierRun, signal: budget.signal })
  if (carrierPage && ozonBrowserRequest(url, capture)) return await runOzonBrowser({ ...carrierRun, signal: budget.signal })
  if (carrierPage && dhlExpressBrowserNumber(url, capture)) return await runDhlExpressBrowser(carrierRun)
  if (carrierPage && posteItalianeBrowserNumber(url, capture)) {
    return await runPosteItalianeBrowser({ ...carrierRun, signal: budget.signal,
      solveCaptcha: (page, timeout, signal, report) => solveDhlPolandNative(page, timeout, AbortSignal.any([budget.signal, signal]), report) })
  }
  if (carrierPage && ztoBrowserNumber(url, capture)) return await runZtoBrowser({ ...carrierRun, signal: budget.signal })
  if (carrierPage && chinaPostBrowserNumber(url, capture)) return await runChinaPostBrowser({ ...carrierRun, signal: budget.signal })
  if (carrierPage && jdDomesticNumber(url, capture)) return await runJdDomestic({ ...carrierRun, signal: budget.signal })
  if (carrierPage && sfExpressSessionNumber(url, capture)) {
    return await sfExpressSessions.run({ ...carrierRun, signal: budget.signal })
  }
  if (carrierPage && australiaPostBrowserRequest(url, capture)) return await runAustraliaPostBrowser(carrierRun)
  if (carrierPage && track123Number(url, capture)) return await runTrack123Browser(carrierRun)
  if (carrierPage && fedexSessionNumber(url, capture)) return await fedexSessions.run(carrierRun)
  if (carrierPage && wanbBrowserNumber(url, capture)) {
    return await runWanbBrowser({ ...carrierRun, signal: budget.signal,
      solveCaptcha: (page, timeout) => solveRecaptchaV2(page, timeout, budget.signal) })
  }
  if (carrierPage && xpoBrowserNumber(url, capture)) {
    return await runXpoBrowser({ ...carrierRun, solveCaptcha: (page, timeout) => solveRecaptchaV2(page, timeout) })
  }
  if (carrierPage && magyarPostaBrowserNumber(url, capture)) {
    return await runMagyarPostaBrowser({ ...carrierRun,
      solveCaptcha: (page, timeout, signal) => solveRecaptchaV2(page, timeout, AbortSignal.any([budget.signal, signal])) })
  }
  if (carrierPage && magyarPostaAppRequest(url, capture)) {
    return await runMagyarPostaApp({ ...carrierRun, signal: budget.signal,
      transcribe: (audio, signal) => transcribeMagyarPostaAudio(audio, AbortSignal.any([budget.signal, signal])) })
  }`;
  writeFileSync(path, 'import { attachTrackingCapture, reserveDeadline } from "../utils/tracking-capture.mjs"\n'
    + 'import { solveRecaptchaV2 } from "../solvers/recaptcha"\n'
    + 'import { wanbBrowserNumber, runWanbBrowser } from "../utils/wanbexpress-browser.mjs"\n'
    + 'import { xpoBrowserNumber, runXpoBrowser } from "../utils/xpo-browser.mjs"\n'
    + 'import { magyarPostaBrowserNumber, runMagyarPostaBrowser } from "../utils/magyar-posta-browser.mjs"\n'
    + 'import { magyarPostaAppRequest, runMagyarPostaApp } from "../utils/magyar-posta-app.mjs"\n'
    + 'import { transcribeAudio as transcribeMagyarPostaAudio } from "../solvers/stt"\n'
    + 'import { solveRecaptchaV2 as solveDhlPolandNative } from "../utils/dhl-poland-native/recaptcha"\n'
    + 'import { dhlPolandBrowserNumber, runDhlPolandBrowser } from "../utils/dhl-poland-browser.mjs"\n'
    + 'import { asendiaBrowserNumber, runAsendiaBrowser } from "../utils/asendia-browser.mjs"\n'
    + 'import { correiosBrowserNumber, runCorreiosBrowser } from "../utils/correios-browser.mjs"\n'
    + 'import { track718JuxiNumber, runTrack718Juxi } from "../utils/track718-juxi.mjs"\n'
    + 'import { ozonBrowserRequest, runOzonBrowser } from "../utils/ozon-browser.mjs"\n'
    + 'import { dhlExpressBrowserNumber, runDhlExpressBrowser } from "../utils/dhl-express-browser.mjs"\n'
    + 'import { posteItalianeBrowserNumber, runPosteItalianeBrowser } from "../utils/poste-italiane-browser.mjs"\n'
    + 'import { ztoBrowserNumber, runZtoBrowser } from "../utils/zto-browser.mjs"\n'
    + 'import { chinaPostBrowserNumber, runChinaPostBrowser } from "../utils/china-post-browser.mjs"\n'
    + 'import { jdDomesticNumber, runJdDomestic } from "../utils/jd-domestic-browser.mjs"\n'
    + 'import { australiaPostBrowserRequest, runAustraliaPostBrowser } from "../utils/australia-post-browser.mjs"\n'
    + 'import { sfExpressSessionNumber, sfExpressSessions } from "../utils/sf-express-session.mjs"\n'
    + 'import { track123Number, runTrack123Browser } from "../utils/track123-browser.mjs"\n'
    + 'import { fedexSessions, fedexSessionNumber } from "../utils/fedex-session.mjs"\n'
    + source.replace(entry, carrierRunners)
      .replace(documentCapture, 'captureBrowserDocument(page, pageCapture.contentOptions?.(capture) ?? capture, pageCapture, budget, screenshot)')
      .replace(needle, 'const pageCapture = reserveDeadline(await attachTrackingCapture(page, url, capture)'
        + ` ?? attachPageCapture(page, capture), ${reserveMs})`)
      .replace(solverGuard, solverGuard.slice(0, -1) + ' && !pageCapture.hasResponse?.() && !pageCapture.hasTrackingRequest?.())')
      // A widget the solver cannot pass must not cost the page behind it.
      .replace(beforeSolve, 'await pageCapture.prepare?.(budget.remaining())\n    '
        + `const solveRemaining = Math.max(0, budget.remaining() - ${reserveMs})`));
}

// The client classifies an HTTP-only failure by the page's own status and
// headers, which TRAWL leaves out of its attempt history.
const orchestratorPath = '/app/packages/tiers/src/orchestrator.ts';
const orchestrator = readFileSync(orchestratorPath, 'utf8');
const attempt = '      ...(r.reason === undefined ? {} : { reason: r.reason }),';
if (orchestrator.split(attempt).length !== 2) throw new Error('TRAWL attempt history changed');
writeFileSync(orchestratorPath, orchestrator.replace(attempt, attempt + '\n      ...(r.status === "success"'
  + ' || r.statusCode === undefined ? {} : { statusCode: r.statusCode, responseHeaders: r.responseHeaders }),'));

// Retention only helps if the next pool lease returns to the working browser.
// The helper has no dependency on BrowserPool and shares the tier singleton.
const poolPath = '/app/packages/browser/src/pool.ts';
const pool = readFileSync(poolPath, 'utf8');
const pick = '    if (domain) {\n      const sticky = available.find';
if (pool.split(pick).length !== 2) throw new Error('TRAWL browser affinity integration changed');
writeFileSync(poolPath, 'import { preferredFedExEntry } from "../../tiers/src/utils/fedex-session.mjs"\n'
  + pool.replace(pick, '    const retained = preferredFedExEntry(available, domain)\n'
    + '    if (retained) return retained\n' + pick));

// A failed tier says why at the image's warn level.
const tierFailurePaths = { browser: '/app/packages/tiers/src/tiers/browser.ts', tier2: '/app/packages/tiers/src/tiers/2.ts',
  orchestrator: orchestratorPath, requestLogging: '/app/apps/api/src/requestLogging.ts' };
const tierFailureSources = logTierFailures(Object.fromEntries(Object.entries(tierFailurePaths)
  .map(([file, path]) => [file, readFileSync(path, 'utf8')])));
for (const [file, path] of Object.entries(tierFailurePaths)) writeFileSync(path, tierFailureSources[file]);

// TRAWL's LICENSE, from the AGPL-3.0 text Debian ships.
mkdirSync('/usr/share/licenses/trawl', { recursive: true });
writeFileSync('/usr/share/licenses/trawl/LICENSE', trawlLicense(readFileSync('/usr/share/common-licenses/AGPL-3.0', 'utf8')));
