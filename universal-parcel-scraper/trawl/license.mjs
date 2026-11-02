import { createHash } from 'node:crypto';

// Debian's base-files ship the AGPL-3.0 text, and the image builds TRAWL's
// LICENSE from it rather than carry 34 KB in the Dockerfile Coolify stores.
// Debian wraps one line of the appendix differently from upstream's copy.
const debianWrap = 'License as published by\n    the Free Software Foundation';
const upstreamWrap = 'License as published\n    by the Free Software Foundation';
/** The SHA-256 of the LICENSE beside this file. */
export const licenseSha256 = '8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef';

/** TRAWL's LICENSE from Debian's AGPL-3.0 text, or a stop when that text has changed. */
export function trawlLicense(debianText) {
  const text = debianText.replace(debianWrap, upstreamWrap);
  if (createHash('sha256').update(text).digest('hex') !== licenseSha256) throw new Error("Debian's AGPL-3.0 text changed: review TRAWL's LICENSE");
  return text;
}
