import { CarrierError, carrierErrorKind } from '../errors/index.js';
import type { TrawlCallOptions, TrawlClient, TrawlScrapeRequest, TrawlScrapeResponse } from './trawl.js';
import type { JsonObject } from '../types.js';

/** Reimport only bounded cookies belonging to the carrier's approved domains. */
export function scopedTrawlCookies(cookies: readonly JsonObject[], domains: readonly string[], target?: string): JsonObject[] {
  const allowed = new Set(domains.map(domain => domain.toLowerCase()));
  const selected: JsonObject[] = [];
  let path: string | undefined;
  if (target) {
    try { path = new URL(target).pathname; } catch { return selected; }
  }
  for (const cookie of cookies) {
    // A pooled browser may return cookies for unrelated origins. Do not read
    // their values or pass them into another carrier's context.
    if (typeof cookie.domain !== 'string' || !allowed.has(cookie.domain.toLowerCase().replace(/^\./, ''))) continue;
    if (typeof cookie.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(cookie.name)
      || typeof cookie.value !== 'string' || cookie.value.length > 8192
      || [...cookie.value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === ';')
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 2048) continue;
    if (path !== undefined && path !== cookie.path && !path.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)) continue;
    selected.push({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
      ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) ? { expires: cookie.expires } : {}),
      ...(['Strict', 'Lax', 'None'].includes(String(cookie.sameSite)) ? { sameSite: cookie.sameSite } : {}),
    });
    if (selected.length === 32) break;
  }
  return selected;
}

/**
 * Guest verification can put one-use credentials in the URL, headers or a
 * nested request body. Keep failure classification without allowing transport
 * diagnostics, service messages or their causes to retain those credentials.
 */
export async function trawlPrivateScrape(
  client: TrawlClient,
  request: TrawlScrapeRequest,
  options: TrawlCallOptions,
): Promise<TrawlScrapeResponse> {
  options.signal?.throwIfAborted();
  try {
    return await client.scrape(request, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    const seen = new Set<unknown>();
    let detail: CarrierError | undefined;
    for (let current = error; current instanceof Error && !seen.has(current) && seen.size < 8; current = current.cause) {
      seen.add(current);
      if (current instanceof CarrierError) { detail = current; break; }
    }
    const kind = carrierErrorKind(error) ?? 'transport';
    // A missing service or verification route proves nothing about a parcel.
    throw new CarrierError(kind === 'not_found' ? 'transport' : kind, options.provider,
      `${options.provider} could not complete the verified tracking request`, {
        status: detail?.status, retryAfterMs: detail?.retryAfterMs,
      });
  }
}
