#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { InputRequiredError } from '../core/errors/index.js';
import { createTracker, TrackingError } from '../facade/index.js';
import type { UniversalSource } from '../providers/types.js';
import { CARRIER_CATALOG } from '../generated/catalog.js';
import { createTrackingServer } from '../server/index.js';
import { startRoyalMailBrowserService } from '../carriers/royal-mail/browser-service.js';

const help = `Universal Parcel Scraper

  parcel-scraper detect <number, link or text>
  parcel-scraper recognize <number>
  parcel-scraper track <number> [--carrier <id>] [--postcode <value>] [--tracking-url <url>] [--source <provider>]
  parcel-scraper carriers
  parcel-scraper serve [--host <address>] [--port <port>]
  parcel-scraper royal-mail-browser

SCRAPER_PROVIDERS selects comma-separated providers; default: UPU. --source asks one alone,
without the carrier: Ship24, ParcelsApp, 17TRACK, Postal Ninja, Track718 (Juxi only) or UPU.
FLARESOLVERR_URL and TRACKING_CHROMIUM_PATH enable browser transports.
SCRAPER_USER_AGENT replaces the client name adapters send to carriers.
SCRAPER_TOKEN protects the HTTP API. SCRAPER_DEMO_PAGE=true enables its one-off page.
SCRAPER_RATE_LIMIT, SCRAPER_MAX_CONCURRENT, SCRAPER_CACHE_MS and SCRAPER_FAILURE_CACHE_MS
bound the HTTP API; SCRAPER_TRUSTED_PROXIES counts the reverse proxies in front of it.`;

/** A whole number from the environment, or undefined when unset so the default applies. */
function count(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw new TypeError(`${name} must be a whole number`);
  return Number(raw);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const [command, ...args] = argv;
  if (!command || ['--help','-h','help'].includes(command)) { console.log(help); return 0; }
  if (command === 'royal-mail-browser') {
    if (args.length) throw new TypeError('Unexpected argument; configure the Royal Mail browser service through its environment');
    const server = await startRoyalMailBrowserService(env);
    console.error(JSON.stringify({ service: 'royal-mail-browser', state: 'ready' }));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close(); });
    return 0;
  }
  if (!['detect','recognize','track','carriers','serve'].includes(command)) throw new TypeError('Unknown command; use --help');
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const allowed = command === 'track' ? ['carrier','postcode','tracking-url','country-hint','source'] : command === 'serve' ? ['host','port'] : [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const name = argument.slice(2);
    if (!allowed.includes(name) || !args[i+1] || args[i+1]!.startsWith('--')) throw new TypeError('Unknown or incomplete command option; use --help');
    values[name] = args[++i]!;
  }
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const input = positional.join(' ');
  if (command === 'carriers' || command === 'serve') { if (input) throw new TypeError('Unexpected argument; use --help'); }
  else if (!input) throw new TypeError('Supply a tracking input; use --help');
  // The catalog and detection are offline: the transport settings below cannot break them.
  if (command === 'carriers') { print(CARRIER_CATALOG); return 0; }
  if (command === 'detect') { print(createTracker().detect(input)); return 0; }
  const source = values.source as UniversalSource | undefined;
  // A provider named for one lookup is asked whatever SCRAPER_PROVIDERS enables.
  const providers = source !== undefined ? [source] : env.SCRAPER_PROVIDERS === undefined ? undefined
    : env.SCRAPER_PROVIDERS.split(',').map(value => value.trim()).filter(Boolean) as UniversalSource[];
  const options = { providers, trawlUrl: env.FLARESOLVERR_URL, chromiumPath: env.TRACKING_CHROMIUM_PATH,
    userAgent: env.SCRAPER_USER_AGENT?.trim() || undefined, env };
  if (command === 'serve') {
    const port = Number(values.port ?? env.PORT ?? 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid port');
    const host = values.host ?? env.HOST ?? '127.0.0.1';
    const server = createTrackingServer({ ...options, token: env.SCRAPER_TOKEN, demoPage: env.SCRAPER_DEMO_PAGE === 'true',
      rateLimit: count(env, 'SCRAPER_RATE_LIMIT'), maxConcurrent: count(env, 'SCRAPER_MAX_CONCURRENT'),
      cacheMs: count(env, 'SCRAPER_CACHE_MS'), failureCacheMs: count(env, 'SCRAPER_FAILURE_CACHE_MS'),
      trustedProxies: count(env, 'SCRAPER_TRUSTED_PROXIES'),
      log: record => console.error(JSON.stringify(record)) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    console.error(`Parcel tracking server listening on ${host}:${port}`);
    for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => server.close());
    return 0;
  }
  const tracker = createTracker(options);
  if (command === 'recognize') print(await tracker.recognize(input));
  else print(await tracker.track({ number: input, carrier: values.carrier, postcode: values.postcode, trackingUrl: values['tracking-url'], countryHint: values['country-hint'], source }));
  return 0;
}

/** What a failed command prints: a rejected input, setting or listener explains itself; anything else stays generic. */
export function failureText(error: unknown): string {
  if (error instanceof TrackingError) return JSON.stringify({ error: error.message, attempts: error.attempts, hint: error.hint });
  return error instanceof TypeError || error instanceof RangeError || error instanceof InputRequiredError
    || (error instanceof Error && 'syscall' in error) ? error.message : 'Tracking could not be completed';
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch (error) {
    console.error(failureText(error));
    process.exitCode = 1;
  }
}
