import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { boundedError, logTierFailures, tierFailure } from './tier-failure-log.mjs';

// TRAWL's sources, reduced to the paths a failed tier takes. The lines the
// patches change are kept as upstream writes them.
const upstream = {
  browser: `async function runBrowserTierTask<T extends 3 | 4>(tier: T, url: string, page: Page): Promise<BrowserTierResult<T>> {
  const start = Date.now()
  try {
    const gotoErr = await page
      .goto(url, { waitUntil: "domcontentloaded" })
      .catch((e: Error) => e)

    // Abort early on hard network failures - no point running challenge wait
    if (isHardNetworkFailure(gotoErr)) {
      return {
        tier,
        status: "error",
        durationMs: Date.now() - start,
        reason: tier === 4 ? "proxy-connection-failed" : gotoErr.message.split("\\n")[0],
      }
    }
    const html = await page.content()
    return { tier, status: "success", durationMs: Date.now() - start, html }
  } catch (err) {
    return {
      tier,
      status: "error",
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
`,
  tier2: `async function runTier2Task(url: string, page: Page): Promise<Tier2Result> {
  const start = Date.now()
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" })
    const html = await page.content()
    return { tier: 2, status: "success", durationMs: Date.now() - start, html }
  } catch (err) {
    return {
      tier: 2,
      status: "error",
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
`,
  orchestrator: `export class ScrapeError extends Error {
  timings: TierResult[]
  constructor(message: string, timings: TierResult[]) {
    super(message)
    this.name = "ScrapeError"
    this.timings = timings
  }
}

export async function scrape(req: ScrapeRequest, deps: OrchestratorDeps, runners: OrchestratorRunners): Promise<ScrapeResult> {
  const attempts: TierResult[] = []
  return await scrapeWithinBudget(
        req,
        {
          ...deps,
          onTierAttempt: (attempt) => {
            attempts.push(attempt)
            deps.onTierAttempt?.(attempt)
          },
        },
        runners,
      )
}

async function scrapeWithinBudget(req: ScrapeRequest, deps: OrchestratorDeps, runners: OrchestratorRunners) {
  const timings: TierResult[] = []
  const emit = (r: InternalTierResult) => {
    const publicResult: TierResult = {
      tier: r.tier,
      status: r.status,
      durationMs: r.durationMs,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
    }
    timings.push(publicResult)
    deps.onTierAttempt?.(publicResult)
  }
  const t2 = await runTier2Task(req.url, runners.page2)
  emit(t2)
  if (t2.status === "success") return { tier: 2, html: t2.html, timings }
  const t3 = await runBrowserTierTask(3, req.url, runners.page3)
  emit(t3)
  if (t3.status === "success") return { tier: 3, html: t3.html, timings }
  throw new ScrapeError("Max tier reached without success", timings)
}
`,
  requestLogging: `import { PoolExhaustedError } from "@trawl/browser"
import { type OrchestratorDeps, ScrapeError, scrape } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult, TierResult } from "@trawl/types"
import { log, requestId, safeMessage, safeUrl } from "./logger"

export async function runLoggedScrape(
  source: ScrapeSource,
  req: ScrapeRequest,
  deps: OrchestratorDeps,
  runScrape: typeof scrape = scrape,
  id = requestId(),
): Promise<ScrapeResult> {
  const started = Date.now()
  log("info", "scrape", { event: "request.start", request: id, source, target: safeUrl(req.url) })

  const originalAttempt = deps.onTierAttempt
  const tracedDeps: OrchestratorDeps = {
    ...deps,
    onTierAttempt: (attempt: TierResult) => {
      originalAttempt?.(attempt)
      log("info", "scrape", {
        event: "tier.complete",
        request: id,
        tier: attempt.tier,
        status: attempt.status,
        durationMs: attempt.durationMs,
        reason: attempt.reason ? safeMessage(attempt.reason) : undefined,
      })
    },
  }

  try {
    return await runScrape(req, tracedDeps)
  } catch (error) {
    const last = error instanceof ScrapeError ? error.timings.at(-1) : undefined
    log(error instanceof PoolExhaustedError ? "warn" : "error", "scrape", {
      event: "request.failure",
      request: id,
      source,
      totalMs: Date.now() - started,
      tier: last?.tier,
      status: last?.status,
      reason: safeMessage(error instanceof Error ? error.message : String(error)),
    })
    throw error
  }
}
`,
};

// TRAWL's logger at the image's level, and the helpers the reduced sources call.
const prelude = `import { tierFailure } from ${JSON.stringify(new URL('./tier-failure-log.mjs', import.meta.url).href)}
const ranks = { error: 0, warn: 1, info: 2, debug: 3, silent: -1 }
const LOG_LEVEL = "warn"
const quote = (value) => {
  if (value === null) return "null"
  if (value === undefined) return ""
  if (typeof value !== "string") return String(value)
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : JSON.stringify(value)
}
const safeUrl = (candidate) => { const url = new URL(candidate); return url.protocol + "//" + url.host + url.pathname }
const safeMessage = (message) => message.replace(/https?:\\/\\/[^\\s"'<>]+/gi, (candidate) => safeUrl(candidate))
function log(level, scope, fields) {
  if (LOG_LEVEL === "silent" || ranks[level] > ranks[LOG_LEVEL]) return
  const line = ["level=" + level, "scope=" + scope]
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) line.push(key + "=" + quote(value))
  const message = line.join(" ")
  if (level === "error") console.error(message)
  else if (level === "warn") console.warn(message)
  else console.log(message)
}
const requestId = () => "abc123"
class PoolExhaustedError extends Error {}
const isHardNetworkFailure = (err) => err instanceof Error && /ERR_NAME_NOT_RESOLVED|NS_ERROR_UNKNOWN_HOST/.test(err.message)
`;

async function load(sources) {
  const body = ['tier2', 'browser', 'orchestrator', 'requestLogging']
    .map(file => stripTypeScriptTypes(sources[file].replace(/^import .*\n/gm, ''), { mode: 'strip' })).join('\n');
  return import(`data:text/javascript;base64,${Buffer.from(prelude + body).toString('base64')}`);
}

// Synthetic page address with an identifier in its path and a token in its query.
const url = 'https://parcel.example.test/track/ZZ123456789XX?token=synthetic-secret';
class TimeoutError extends Error { name = 'TimeoutError'; }
const callLog = `\nCall log:\n  - navigating to "${url}", waiting until "domcontentloaded"\n`;
const page = ({ goto = async () => {}, content = async () => '<html>synthetic</html>' } = {}) => ({ goto, content });

/** Runs one logged request through the patched sources and returns its log lines and outcome. */
async function run(pages) {
  const module = await load(logTierFailures(upstream));
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) console[level] = line => lines.push(String(line).replace(/(durationMs|totalMs)=\d+/g, '$1=0'));
  try {
    const result = await module.runLoggedScrape('native', { url }, {}, (req, deps) => module.scrape(req, deps, pages))
      .catch(error => error);
    return { lines, result };
  } finally { Object.assign(console, saved); }
}

test('each failed browser tier logs its error at warn level without the page address', async () => {
  const { lines, result } = await run({
    page2: page({ goto: async () => { throw new TimeoutError(`page.goto: Timeout 30000ms exceeded.${callLog}`); } }),
    page3: page({ goto: async () => { throw new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}${callLog}`); } }),
  });
  assert.deepEqual(lines, [
    'level=warn scope=scrape event=tier.failure request=abc123 host=parcel.example.test tier=2 status=error durationMs=0 errorName=TimeoutError'
      + ' error="page.goto: Timeout 30000ms exceeded."',
    'level=warn scope=scrape event=tier.failure request=abc123 host=parcel.example.test tier=3 status=error durationMs=0 errorName=Error'
      + ' error="page.goto: net::ERR_NAME_NOT_RESOLVED at <url>"',
    'level=error scope=scrape event=request.failure request=abc123 source=native totalMs=0 tier=3 status=error'
      + ' reason="Max tier reached without success"',
  ]);
  // The reply's timings keep their fields and the tiers' own reasons.
  assert.equal(result.name, 'ScrapeError');
  assert.deepEqual(result.timings.map(timing => Object.keys(timing)), [['tier', 'status', 'durationMs', 'reason'], ['tier', 'status', 'durationMs', 'reason']]);
  assert.equal(result.timings[0].reason, `page.goto: Timeout 30000ms exceeded.${callLog}`);
  assert.equal(result.timings[1].reason, `page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}`);
});

test('an exception in the browser tier is named, and a tier that succeeds logs nothing', async () => {
  const failed = await run({
    page2: page({ goto: async () => { throw new Error('Target page, context or browser has been closed'); } }),
    page3: page({ content: async () => { throw new TypeError("Cannot read properties of undefined (reading 'ZZ123456789XX')"); } }),
  });
  assert.deepEqual(failed.lines.slice(0, 2), [
    'level=warn scope=scrape event=tier.failure request=abc123 host=parcel.example.test tier=2 status=error durationMs=0 errorName=Error'
      + ' error="Target page, context or browser has been closed"',
    'level=warn scope=scrape event=tier.failure request=abc123 host=parcel.example.test tier=3 status=error durationMs=0 errorName=TypeError'
      + ' error="Cannot read properties of undefined (reading \'<id>\')"',
  ]);
  const succeeded = await run({ page2: page(), page3: page() });
  assert.deepEqual(succeeded.lines, []);
  assert.deepEqual(succeeded.result, { tier: 2, html: '<html>synthetic</html>', timings: [{ tier: 2, status: 'success', durationMs: succeeded.result.timings[0].durationMs }] });
});

test('only failed, blocked and timed-out tiers produce a warn line', () => {
  for (const status of ['success', 'skipped', 'needs-js']) assert.equal(tierFailure({ tier: 1, status, durationMs: 1 }), undefined);
  assert.deepEqual(tierFailure({ tier: 3, status: 'blocked', durationMs: 9, reason: 'cloudflare-persistent', statusCode: 403 }),
    { host: undefined, tier: 3, status: 'blocked', durationMs: 9, statusCode: 403, errorName: undefined, error: 'cloudflare-persistent' });
  assert.deepEqual(tierFailure({ tier: 2, status: 'timeout', durationMs: 9, statusCode: '403' }, 'Error: <html>', url),
    { host: 'parcel.example.test', tier: 2, status: 'timeout', durationMs: 9, statusCode: undefined, errorName: undefined, error: undefined });
});

test('failure text keeps one bounded line without addresses, queries or identifiers', () => {
  assert.equal(boundedError('\npage.goto: NS_ERROR_UNKNOWN_HOST\nCall log:\n  - navigating to "https://a.test/x"'), 'page.goto: NS_ERROR_UNKNOWN_HOST');
  assert.equal(boundedError('Execution context was destroyed, most likely because of a navigation'),
    'Execution context was destroyed, most likely because of a navigation');
  assert.equal(boundedError(`failed at "${url}" (http://a.test:8080/p/1)`), 'failed at "<url>" <url>');
  assert.equal(boundedError('neterror about:neterror?e=dnsNotFound&u=https%3A//a.test/p&c=UTF-8'), 'neterror <url>');
  assert.equal(boundedError('wanted u=https%3A%2F%2Fa.test%2Fp and #nums=ZZ123 and ?n=1'), 'wanted <url> and and');
  assert.equal(boundedError('no reply for ZZ000AA00000000000, 12345678 or 0123-45678901 in 1234567'),
    'no reply for <id>, <id> or 0123-<id> in 1234567');
  assert.equal(boundedError('token abcdefghijklmnopqrstuvwxyz kept'), 'token <id> kept');
  const long = boundedError(`${'word '.repeat(80)}\nsecond line`);
  assert.equal(long.length, 200);
  assert.ok(!long.includes('second'));
});

test('the build stops when the code the patches change has moved', () => {
  for (const [file, source] of Object.entries(upstream)) {
    assert.throws(() => logTierFailures({ ...upstream, [file]: source.replaceAll('onTierAttempt', 'onAttempt').replaceAll('catch (err)', 'catch (e)') }),
      new RegExp(`TRAWL ${file} changed`));
  }
  assert.throws(() => logTierFailures({ ...upstream, tier2: upstream.tier2 + upstream.tier2 }), /TRAWL tier2 changed/);
});

test('the image installs the helper beside the request log that imports it', () => {
  const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY tier-failure-log\.mjs \/app\/apps\/api\/src\/tier-failure-log\.mjs$/m);
  assert.ok(logTierFailures(upstream).requestLogging.startsWith('import { tierFailure } from "./tier-failure-log.mjs"\n'));
  assert.match(readFileSync(new URL('./install.mjs', import.meta.url), 'utf8'), /from '\/app\/apps\/api\/src\/tier-failure-log\.mjs'/);
});
