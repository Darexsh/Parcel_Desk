// Runs inside the container image: the optional transports must be installed, its
// Chromium must launch through playwright-core, and nothing it started may be left
// behind as a zombie process.
import { readdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

await import('onnxruntime-web');
await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer();

const executablePath = process.env.TRACKING_CHROMIUM_PATH;
if (!executablePath) throw new Error('TRACKING_CHROMIUM_PATH is not set');
for (let round = 0; round < 3; round += 1) {
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 30_000,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', LANG: 'en_US.UTF-8' } });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>rendered</title>');
    if (await page.title() !== 'rendered') throw new Error('Chromium did not render the page');
  } finally {
    await browser.close();
  }
}

// /proc/<pid>/stat is "pid (command) state ..."; the command may itself contain parentheses.
function zombies() {
  return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    } catch {
      return false; // the process ended between the listing and the read
    }
  });
}
if (process.platform === 'linux') {
  let left = zombies();
  for (let attempt = 0; left.length > 0 && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = zombies();
  }
  if (left.length > 0) throw new Error(`${left.length} zombie process(es) remain after closing Chromium`);
}
console.log('The optional transports load, Chromium rendered three times, and no zombie process remains.');
