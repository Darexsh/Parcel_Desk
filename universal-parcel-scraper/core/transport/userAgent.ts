/**
 * How adapters name themselves to carriers that accept a plain client. Hosts
 * set their own through the `userAgent` option, so one blocked install does
 * not block the rest. Adapters that must pass for a browser keep their own.
 */
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; PeekDeliveryTracker/1.0)';

/** The host's User-Agent when it is a usable header value, else the default. */
export function userAgentOf(configured: string | null | undefined): string {
  if (configured === undefined || configured === null) return DEFAULT_USER_AGENT;
  const value = configured.trim();
  if (!value || value.length > 256 || /[^\x20-\x7e]/.test(value)) throw new TypeError('User-Agent must be 1 to 256 printable ASCII characters');
  return value;
}
