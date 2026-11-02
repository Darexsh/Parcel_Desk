import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { dhlPolandNativeSources } from './dhl-poland-native.mjs';
import { fastRecaptchaAudio } from './recaptcha-audio.mjs';
import { createRecaptchaAudioBackoff } from './recaptcha-backoff.mjs';

// The upstream solver's audio loop, reduced to the parts the patch replaces.
const upstream = `import { sleep } from "../utils/deadline"
import type { Page } from "patchright"
import { transcribeAudio } from "./stt"

export async function solveRecaptchaV2(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  try {
    const anchor = page.frameLocator("anchor").first()
    const bframe = page.frameLocator("bframe").first()
    console.log("[recaptcha] switched to audio challenge")
    let attempt = 0
    while (Date.now() < deadline && attempt < 3) {
      attempt++

      const hasAudioSrc = await bframe
        .locator("#audio-source, audio")
        .waitFor({ timeout: Math.max(1, Math.min(10_000, deadline - Date.now())) })
        .then(() => true)
        .catch(() => false)
      if (!hasAudioSrc) {
        const bframeText2 = await bframe
          .locator("body")
          .innerText()
          .catch(() => "")
        console.log("[recaptcha] audio element not found; bframe:", bframeText2.slice(0, 120).replace(/\\s+/g, " "))
        if (/automated queries|try again|network may be/i.test(bframeText2)) {
          console.log("[recaptcha] blocked by Google - audio challenge requires residential proxy")
          return false
        }
      }

      const answer = await transcribeAudio("audio", signal)
      await bframe
        .locator("#recaptcha-verify-button")
        .click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())) })
        .catch(() => {})
      await sleep(2000, signal)

      if (
        await anchor
          .locator('#recaptcha-anchor[aria-checked="true"]')
          .isVisible({ timeout: Math.max(1, Math.min(2000, deadline - Date.now())) })
          .catch(() => false)
      ) {
        console.log("[recaptcha] solved via audio ✓")
        return true
      }
      await bframe.locator("#recaptcha-reload-button").click().catch(() => {})
    }
    return false
  } catch (err) {
    console.log("[recaptcha] solver error:", err instanceof Error ? err.message : err)
    return false
  }
}
`;
const stt = 'import { runFfmpeg } from "./subprocess"\nexport const transcribe = () => "synthetic"\n';

const prelude = `const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")) }, { once: true })
})
const transcribeAudio = (...args) => globalThis.recaptchaAudioTest.transcribe(...args)
const recaptchaAudioBackoff = globalThis.recaptchaAudioTestBackoff
`;

let loadId = 0;
async function load(source, backoff = createRecaptchaAudioBackoff()) {
  globalThis.recaptchaAudioTestBackoff = backoff;
  const js = prelude + stripTypeScriptTypes(source.replace(/^import .*\n/gm, ''), { mode: 'strip' });
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${++loadId}`);
}

test('the generic solver awaits the shared pause before accessing a page', async () => {
  const backoff = createRecaptchaAudioBackoff(() => 1000, { load: async () => 21601000 });
  const { solveRecaptchaV2 } = await load(fastRecaptchaAudio(upstream), backoff);
  let accessed = 0;
  const page = { frameLocator: () => { accessed++; throw new Error('Should not reach the page'); } };
  assert.equal(await solveRecaptchaV2(page), false);
  assert.equal(accessed, 0);
});

/** A page whose challenge frame changes as the solver clicks; `on` reacts to clicks. */
function challenge(on = {}) {
  const state = { audio: false, blocked: false, error: '', checked: false, clicks: [], answers: 0, logs: [] };
  const shown = (visible, text = '') => visible ? { getClientRects: () => [{}], textContent: text } : null;
  const document = {
    querySelector: selector => selector.includes('rc-doscaptcha') ? shown(state.blocked, 'Próbálja újra később')
      : selector === '.rc-audiochallenge-error-message' ? { getClientRects: () => state.error ? [{}] : [], textContent: state.error }
        : null,
  };
  const locator = (frame, selector) => ({
    evaluate: async fn => {
      const saved = [globalThis.document, globalThis.getComputedStyle];
      Object.assign(globalThis, { document, getComputedStyle: () => ({ visibility: 'visible' }) });
      try { return fn(); } finally { [globalThis.document, globalThis.getComputedStyle] = saved; }
    },
    count: async () => frame === 'anchor' ? Number(selector.includes('aria-checked') && state.checked)
      : Number(selector === '#audio-source, audio' && state.audio),
    isVisible: async () => frame === 'anchor' && selector.includes('aria-checked') && state.checked,
    waitFor: () => new Promise(resolve => setTimeout(resolve, 10_000)),
    innerText: async () => 'Próbálja újra később',
    click: async () => { state.clicks.push(selector); on[selector]?.(state); },
  });
  const page = { frameLocator: frame => ({ first: () => ({ locator: selector => locator(frame, selector) }) }) };
  globalThis.recaptchaAudioTest = { transcribe: async () => { state.answers++; return 'synthetic answer'; } };
  return { page, state };
}

async function solve(module, page, report) {
  const log = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); };
  const start = Date.now();
  try {
    return { solved: await module.solveRecaptchaV2(page, 20_000, undefined, report), ms: Date.now() - start, logs };
  } finally { console.log = log; }
}

test('a block page in any language ends the audio solve at once', async () => {
  const module = await load(fastRecaptchaAudio(upstream));
  const { page, state } = challenge();
  state.blocked = true;
  const { solved, ms, logs } = await solve(module, page);
  assert.equal(solved, false); assert.ok(ms < 1000, `took ${ms} ms`);
  assert.equal(state.answers, 0); assert.deepEqual(state.clicks, []);
  assert.ok(logs.some(line => line.includes('blocked by Google')));
});

test('a refused answer ends the solve without another audio request', async () => {
  const backoff = createRecaptchaAudioBackoff();
  const module = await load(fastRecaptchaAudio(upstream), backoff);
  const { page, state } = challenge({ '#recaptcha-verify-button': state => { state.error = 'Több helyes megoldást kell megadni.'; } });
  state.audio = true;
  const { solved, ms } = await solve(module, page);
  assert.equal(solved, false); assert.ok(ms < 1000, `took ${ms} ms`);
  assert.equal(state.answers, 1); assert.deepEqual(state.clicks, ['#recaptcha-verify-button']);
  assert.equal(backoff.remainingMs(), 0);
});

test('a block in the generic solver stops the scoped solver before any page access until expiry', async () => {
  let now = 1000;
  const backoff = createRecaptchaAudioBackoff(() => now);
  const generic = await load(fastRecaptchaAudio(upstream), backoff);
  const nativeSource = dhlPolandNativeSources(fastRecaptchaAudio(upstream), stt).recaptcha;
  assert.ok(nativeSource.includes('from "../../utils/recaptcha-backoff.mjs"'));
  const native = await load(nativeSource, backoff);
  const blocked = challenge(); blocked.state.blocked = true;
  assert.equal((await solve(generic, blocked.page)).solved, false);
  const events = [];
  assert.equal((await solve(native, {}, event => events.push(event))).solved, false);
  assert.deepEqual(events, ['audio_cooldown']);
  now += 6 * 60 * 60 * 1000;
  const clear = challenge({ '#recaptcha-verify-button': state => { state.checked = true; } });
  clear.state.audio = true;
  assert.equal((await solve(native, clear.page)).solved, true);
  assert.equal(clear.state.answers, 1);
});

test('an accepted answer and a late audio clip still solve', async () => {
  const module = await load(fastRecaptchaAudio(upstream));
  const { page, state } = challenge({ '#recaptcha-verify-button': state => { setTimeout(() => { state.checked = true; }, 300); } });
  setTimeout(() => { state.audio = true; }, 600);
  const { solved, ms } = await solve(module, page);
  assert.equal(solved, true); assert.ok(ms < 2000, `took ${ms} ms`);
  assert.equal(state.answers, 1);
});

test('an answer Google does not judge gets a fresh challenge, as upstream does', async () => {
  const module = await load(fastRecaptchaAudio(upstream));
  let verified = 0;
  const { page, state } = challenge({ '#recaptcha-verify-button': state => { if (++verified === 2) state.checked = true; } });
  state.audio = true;
  const { solved } = await solve(module, page);
  assert.equal(solved, true); assert.equal(state.answers, 2);
  assert.deepEqual(state.clicks, ['#recaptcha-verify-button', '#recaptcha-reload-button', '#recaptcha-verify-button']);
});

test('the DHL Poland copy reports blocks and refusals as fixed events', async () => {
  const native = dhlPolandNativeSources(fastRecaptchaAudio(upstream), stt);
  assert.equal(/console\./.test(native.recaptcha), false);
  for (const [setup, expected] of [
    [state => { state.blocked = true; }, 'audio_blocked'],
    [state => { state.audio = true; }, 'audio_refused'],
  ]) {
    const module = await load(native.recaptcha);
    const { page, state } = challenge({ '#recaptcha-verify-button': state => { state.error = 'Multiple correct solutions required'; } });
    setup(state);
    const events = [];
    assert.equal((await solve(module, page, event => events.push(event))).solved, false);
    assert.deepEqual(events, ['audio_started', expected]);
  }
});

test('an upstream change to the patched blocks stops the build', () => {
  assert.throws(() => fastRecaptchaAudio(upstream.replace('Math.min(10_000,', 'Math.min(15_000,')), /Review the upstream/);
  assert.throws(() => fastRecaptchaAudio(upstream.replace('await sleep(2000, signal)', 'await sleep(2500, signal)')), /Review the upstream/);
  assert.throws(() => fastRecaptchaAudio(upstream.replace('import type { Page } from "patchright"', '')), /Review the upstream/);
});
