import { normalizeTrackingNumber } from './normalize.js';

/** Normalize a complete provider identifier; display-text limits must never hide a suffix. */
export function returnedTrackingNumber(value: unknown, allowNumeric = false): string {
  const text = typeof value === 'string' ? value
    : allowNumeric && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  return text.length <= 4096 ? normalizeTrackingNumber(text) : '';
}
