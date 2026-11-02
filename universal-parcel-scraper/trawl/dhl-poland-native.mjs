// Keep the pinned upstream algorithm in a carrier-scoped module. Its default
// debug output includes capability URLs and answers; expose fixed events only.
const SIGNATURE = 'export async function solveRecaptchaV2(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {';
const EVENTS = new Map([
  ['[recaptcha] clicked checkbox', 'checkbox_started'],
  ['[recaptcha] auto-passed', 'checkbox_verified'],
  ['[recaptcha] bframe not found', 'challenge_missing'],
  ['[recaptcha] switched to audio challenge', 'audio_started'],
  ['[recaptcha] blocked by Google - audio challenge requires residential proxy', 'audio_blocked'],
  ['[recaptcha] audio answer refused', 'audio_refused'],
  ['[recaptcha] audio cooldown active', 'audio_cooldown'],
  ['[recaptcha] solved via audio ✓', 'audio_verified'],
  ['[recaptcha] solver error:', 'native_failed'],
]);

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Review the upstream DHL Poland native solver integration');
  return source.replace(before, after);
}

function safeLogs(source, native) {
  const output = source.split('\n').map(line => {
    if (!/^\s*console\.log\(/.test(line)) return line;
    if (!line.trimEnd().endsWith(')')) throw new Error('Review multiline upstream solver logging');
    const event = native && [...EVENTS].find(([message]) => line.includes(JSON.stringify(message)))?.[1];
    return event ? `    reportNative("${event}")` : '';
  }).join('\n');
  if (/console\s*(?:\.|\[)/.test(output)) throw new Error('Unexpected upstream solver logging');
  return output;
}

export function dhlPolandNativeSources(recaptcha, stt) {
  let native = replaceOnce(recaptcha, 'from "../utils/deadline"', 'from "../../utils/deadline"');
  if (native.includes('from "../utils/recaptcha-backoff.mjs"')) {
    native = replaceOnce(native, 'from "../utils/recaptcha-backoff.mjs"', 'from "../../utils/recaptcha-backoff.mjs"');
  }
  native = replaceOnce(native, SIGNATURE,
    SIGNATURE.replace('signal?: AbortSignal)', 'signal?: AbortSignal, report?: (event: string) => void)')
      + '\n  const reportNative = (event: string) => { try { report?.(event) } catch { /* Optional observer. */ } }');
  const audio = replaceOnce(stt, 'from "./subprocess"', 'from "../../solvers/subprocess"');
  return { recaptcha: safeLogs(native, true), stt: safeLogs(audio, false) };
}
