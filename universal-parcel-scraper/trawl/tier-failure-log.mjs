// TRAWL says why a tier failed only at info level, which the image keeps off for
// its page paths. These patches log each failed tier at warn level instead,
// with the name of the error it caught. Replies and their timings are unchanged.

/** One bounded line without URLs, query strings or runs that could be identifiers. */
export function boundedError(text) {
  const line = String(text).split(/\r?\n/).find(row => row.trim()) ?? '';
  return line.replace(/[^\s"'<>]*(?::|%3A)(?:\/\/|%2F%2F)[^\s"'<>]*/gi, '<url>')
    .replace(/[?#][^\s"'<>]*=[^\s"'<>]*/g, '')
    .replace(/[A-Za-z0-9]{8,}/g, run => /\d/.test(run) || run.length >= 20 ? '<id>' : run)
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** A failed tier's log fields, with the host of the page it was asked for. */
export function tierFailure(attempt, errorName, url) {
  if (!['error', 'blocked', 'timeout'].includes(attempt.status)) return undefined;
  return {
    host: URL.canParse(url) ? new URL(url).host : undefined, tier: attempt.tier, status: attempt.status, durationMs: attempt.durationMs,
    statusCode: Number.isInteger(attempt.statusCode) ? attempt.statusCode : undefined,
    errorName: /^[A-Za-z]{1,40}$/.test(errorName ?? '') ? errorName : undefined,
    error: attempt.reason === undefined ? undefined : boundedError(attempt.reason),
  };
}

const caught = '  } catch (err) {\n    return {\n';
const named = caught + '      errorName: err instanceof Error ? err.name : undefined,\n';
const hard = '    if (isHardNetworkFailure(gotoErr)) {\n      return {\n';
const attempt = '            attempts.push(attempt)\n            deps.onTierAttempt?.(attempt';
const traced = '    onTierAttempt: (attempt: TierResult';
// The name travels beside the public attempt, never inside it.
const PATCHES = {
  browser: [[caught, named], [hard, hard + '        errorName: gotoErr.name,\n']],
  tier2: [[caught, named]],
  orchestrator: [['    deps.onTierAttempt?.(publicResult', '$&, r.errorName'],
    ['          onTierAttempt: (attempt) => {\n' + attempt, '          onTierAttempt: (attempt, errorName) => {\n' + attempt + ', errorName']],
  requestLogging: [[traced + ') => {\n      originalAttempt?.(attempt)\n', traced + ', errorName?: string) => {\n'
    + '      originalAttempt?.(attempt)\n      const failure = tierFailure(attempt, errorName, req.url)\n'
    + '      if (failure) log("warn", "scrape", { event: "tier.failure", request: id, ...failure })\n']],
};

/** Patches TRAWL's sources by file key, and stops when the code they change has moved. */
export function logTierFailures(sources) {
  const patched = Object.fromEntries(Object.entries(PATCHES).map(([file, patches]) => [file, patches.reduce((source, [needle, text]) => {
    if (source.split(needle).length !== 2) throw new Error(`TRAWL ${file} changed: review the tier failure log`);
    return source.replace(needle, text);
  }, sources[file])]));
  patched.requestLogging = 'import { tierFailure } from "./tier-failure-log.mjs"\n' + patched.requestLogging;
  return patched;
}
