// TRAWL's reCAPTCHA v2 solver waits up to ten seconds for an audio clip, and
// recognizes Google's block page only by its English wording. Google states
// its verdict in the challenge frame's class names, the same in every
// language, so the patched solver reads those and stops at once: on its
// "try again later" page, or when it refuses an answer. Another audio request
// from a refused address only adds to the block, and every carrier on the
// service shares that address.
const VERDICT = `
// Google's verdict in the challenge frame, by class name so any language counts.
async function audioVerdict(bframe: FrameLocator): Promise<"blocked" | "refused" | undefined> {
  return await bframe
    .locator("body")
    .evaluate(() => {
      const shown = (element: Element | null) =>
        !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"
      if (shown(document.querySelector(".rc-doscaptcha-header-text, .rc-doscaptcha-body-text"))) return "blocked"
      const error = document.querySelector(".rc-audiochallenge-error-message")
      return shown(error) && (error?.textContent ?? "").trim() ? "refused" : undefined
    }, undefined, { timeout: 1000 })
    .catch(() => undefined)
}

export async function solveRecaptchaV2(`;

const AUDIO_WAIT = `      const hasAudioSrc = await bframe
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
      }`;

const FAST_AUDIO_WAIT = `      const audioWaitEnd = Math.min(deadline, Date.now() + 10_000)
      let hasAudioSrc = false
      while (!hasAudioSrc && Date.now() < audioWaitEnd) {
        const verdict = await audioVerdict(bframe)
        if (verdict === "blocked") {
          await recaptchaAudioBackoff.block()
          console.log("[recaptcha] blocked by Google - audio challenge requires residential proxy")
          return false
        }
        if (verdict === "refused") {
          console.log("[recaptcha] audio answer refused")
          return false
        }
        hasAudioSrc = (await bframe.locator("#audio-source, audio").count().catch(() => 0)) > 0
        if (!hasAudioSrc) await sleep(250, signal)
      }
      if (!hasAudioSrc) {
        console.log("[recaptcha] audio element not found")
      }`;

const VERIFY = `        .locator("#recaptcha-verify-button")
        .click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())) })
        .catch(() => {})
      await sleep(2000, signal)
`;

const FAST_VERIFY = `        .locator("#recaptcha-verify-button")
        .click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())) })
        .catch(() => {})
      // Google answers within a moment: the checkbox ticks, or the frame blocks or refuses.
      const verdictEnd = Math.min(deadline, Date.now() + 3000)
      while (Date.now() < verdictEnd) {
        if ((await anchor.locator('#recaptcha-anchor[aria-checked="true"]').count().catch(() => 0)) > 0) break
        const verdict = await audioVerdict(bframe)
        if (verdict === "blocked") {
          await recaptchaAudioBackoff.block()
          console.log("[recaptcha] blocked by Google - audio challenge requires residential proxy")
          return false
        }
        if (verdict === "refused") {
          console.log("[recaptcha] audio answer refused")
          return false
        }
        await sleep(250, signal)
      }
`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Review the upstream reCAPTCHA audio solver patch');
  return source.replace(before, () => after);
}

/** Stop blocked audio attempts across lookups, keeping upstream verification bounds. */
export function fastRecaptchaAudio(source) {
  let output = replaceOnce(source, 'import type { Page } from "patchright"', 'import type { FrameLocator, Page } from "patchright"');
  output = replaceOnce(output, '\nexport async function solveRecaptchaV2(', VERDICT);
  output = replaceOnce(output, AUDIO_WAIT, FAST_AUDIO_WAIT);
  output = replaceOnce(output, VERIFY, FAST_VERIFY);
  output = replaceOnce(output, '  const deadline = Date.now() + timeoutMs', `  if (await recaptchaAudioBackoff.remainingMs() > 0) {
    console.log("[recaptcha] audio cooldown active")
    return false
  }
  const deadline = Date.now() + timeoutMs`);
  return 'import { recaptchaAudioBackoff } from "../utils/recaptcha-backoff.mjs"\n' + output;
}
