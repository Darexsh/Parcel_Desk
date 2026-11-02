import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { dhlPolandNativeSources } from './dhl-poland-native.mjs';

const recaptcha = `import { sleep } from "../utils/deadline"
import { transcribeAudio } from "./stt"
export async function solveRecaptchaV2(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
 console.log("[recaptcha] clicked checkbox")
 console.log("[recaptcha] raw audio href:", "PRIVATE")
 console.log("[recaptcha] answer:", "PRIVATE")
 console.log("[recaptcha] switched to audio challenge")
 console.log("[recaptcha] solved via audio ✓")
 return true
}`;
const stt = `import { runFfmpeg } from "./subprocess"
export function audio(){
 console.log("[stt] raw response:", "PRIVATE")
 console.log("[stt] raw transcript:", "PRIVATE")
 return "synthetic answer"
}`;

test('the scoped upstream algorithm retains only fixed diagnostics and survives observer errors', async () => {
  const output = dhlPolandNativeSources(recaptcha, stt);
  assert.ok(output.recaptcha.includes('from "../../utils/deadline"'));
  assert.ok(output.stt.includes('from "../../solvers/subprocess"'));
  assert.equal(/console\./.test(output.recaptcha + output.stt), false);
  assert.equal((output.recaptcha + output.stt).includes('PRIVATE'), false);
  const js = stripTypeScriptTypes(output.recaptcha.replace(/^import .*\n/gm, ''), { mode: 'strip' });
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const events = [];
  assert.equal(await module.solveRecaptchaV2({}, 1000, undefined, value => events.push(value)), true);
  assert.deepEqual(events, ['checkbox_started', 'audio_started', 'audio_verified']);
  assert.equal(await module.solveRecaptchaV2({}, 1000, undefined, () => { throw new Error('PRIVATE'); }), true);
});

test('unknown logging and upstream signature changes stop the build', () => {
  assert.throws(() => dhlPolandNativeSources(recaptcha.replace('console.log("[recaptcha] answer:", "PRIVATE")', 'console.log(\n "PRIVATE"\n)'), stt));
  assert.throws(() => dhlPolandNativeSources(recaptcha + '\nconsole.warn("PRIVATE")', stt));
  assert.throws(() => dhlPolandNativeSources(recaptcha.replace('signal?: AbortSignal', 'cancel?: AbortSignal'), stt));
});
