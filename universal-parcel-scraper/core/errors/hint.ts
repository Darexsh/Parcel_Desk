import { carrierErrorKind, retryAfterMsOf, type CarrierErrorKind } from './index.js';

export interface FailureHint {
  kind: CarrierErrorKind;
  retryAfterMs?: number;
}

/**
 * The kind of any failure. An error outside the taxonomy that the runtime
 * raises while reading a reply (a TypeError, RangeError or SyntaxError) means
 * the payload was not the expected shape, so it is `schema`: retrying at once
 * cannot help. Anything else untyped stays a transport failure.
 */
export function failureKind(error: unknown): CarrierErrorKind {
  return carrierErrorKind(error)
    ?? (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 'schema' : 'transport');
}

/** The upstream's advice; consumers own their refresh cadence and backoff. */
export function failureHint(error: unknown): FailureHint {
  const kind = failureKind(error);
  const retryAfterMs = retryAfterMsOf(error);
  return { kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}
