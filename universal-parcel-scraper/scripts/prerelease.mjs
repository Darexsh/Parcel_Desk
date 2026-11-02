import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Plans an npm release of the built checkout for the Release workflow.
//
// By default it plans the prerelease of HEAD, `<base>-main.<commit count>`
// under the `next` tag, and publishes only when the files a consumer would
// install differ from the newest version on npm. With `--stable` it plans the
// release of the package.json version under `latest`.
//
// The plan is printed, and written to GITHUB_OUTPUT and GITHUB_STEP_SUMMARY
// when they are set. Nothing is published here.
//
// With `--await <version>` it waits until npm lists that version. npm accepts
// a publish before it serves the version, and until then neither the next
// plan nor a consumer can see it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
// Shipped, but a change to it alone is not worth a release.
const IGNORED_FILES = new Set(['README.md']);

/** @param {string} version */
export function parseVersion(version) {
  const match = VERSION.exec(version);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split('.') ?? [] };
}

function compareIdentifiers(a, b) {
  const numeric = [a, b].map((identifier) => /^\d+$/.test(identifier));
  if (numeric[0] && numeric[1]) return Math.sign(Number(a) - Number(b));
  if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
  return a < b ? -1 : Number(a > b);
}

/**
 * Semver precedence: negative when `a` is older than `b`.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const [left, right] = [a, b].map((version) => {
    const parsed = parseVersion(version);
    if (!parsed) throw new Error(`Not a semver version: ${version}`);
    return parsed;
  });
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return Math.sign(left.core[index] - right.core[index]);
  }
  // A release outranks its own prereleases.
  if (!left.prerelease.length || !right.prerelease.length) return Math.sign(right.prerelease.length - left.prerelease.length);
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index += 1) {
    const order = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (order) return order;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

/**
 * The highest published version, prereleases included.
 * @param {string[]} published
 * @returns {string | undefined}
 */
export function newestVersion(published) {
  return published
    .filter((version) => parseVersion(version))
    .reduce((newest, version) => (newest === undefined || compareVersions(version, newest) > 0 ? version : newest), undefined);
}

/**
 * The stable version HEAD is heading for: the package.json version until it
 * is released, then the next patch.
 * @param {string} packageVersion
 * @param {string[]} published
 */
export function baseVersion(packageVersion, published) {
  const parsed = parseVersion(packageVersion);
  if (!parsed) throw new Error(`package.json version is not semver: ${packageVersion}`);
  const [major, minor, patch] = parsed.core;
  return published.includes(`${major}.${minor}.${patch}`) ? `${major}.${minor}.${patch + 1}` : `${major}.${minor}.${patch}`;
}

/**
 * @param {string} packageVersion
 * @param {string[]} published
 * @param {number} count Commits reachable from HEAD.
 */
export function prereleaseVersion(packageVersion, published, count) {
  return `${baseVersion(packageVersion, published)}-main.${count}`;
}

/**
 * A prerelease already published from a later commit than `count`.
 * @param {string[]} published
 * @param {number} count
 */
export function laterPrerelease(published, count) {
  return published.find((version) => Number(/-main\.(\d+)$/.exec(version)?.[1]) > count);
}

/**
 * Decides everything that needs no package contents. A plan carrying
 * `baseline` still has to be compared with that published version.
 * @param {string} packageVersion
 * @param {string[]} published
 * @param {number} count
 */
export function planPrerelease(packageVersion, published, count) {
  const version = prereleaseVersion(packageVersion, published, count);
  const newest = newestVersion(published);
  const isPublished = published.includes(version);
  // Publishing or announcing an older commit would move consumers backwards.
  const newer = laterPrerelease(published, count) ?? (newest && compareVersions(version, newest) < 0 ? newest : undefined);
  if (newer) return { version, publish: false, published: isPublished, notify: false, reason: `${newer} is newer` };
  if (isPublished) return { version, publish: false, published: true, notify: true, reason: 'already on npm' };
  if (!newest) return { version, publish: true, published: false, notify: true, reason: 'nothing is published yet' };
  return { version, published: false, baseline: newest };
}

/**
 * A version that is already on npm stands for HEAD only when it was built
 * from HEAD. Rewriting the history of main gives another commit the same count.
 * @param {string} version
 * @param {string | undefined} publishedFrom The commit npm recorded, when it recorded one.
 * @param {string} head
 */
export function assertPublishedFrom(version, publishedFrom, head) {
  if (!publishedFrom || publishedFrom === head) return;
  throw new Error(`${version} is already on npm from commit ${publishedFrom.slice(0, 7)}, and HEAD is ${head.slice(0, 7)}. Push another commit to release it.`);
}

/**
 * @param {string} packageVersion
 * @param {string[]} published
 * @param {number} count
 */
export function planStable(packageVersion, published, count) {
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) throw new Error(`A stable release needs an X.Y.Z version, not ${packageVersion}`);
  if (published.includes(packageVersion)) {
    const notify = newestVersion(published) === packageVersion;
    return { version: packageVersion, publish: false, published: true, notify, reason: 'already on npm' };
  }
  const later = laterPrerelease(published, count);
  if (later) throw new Error(`${later} is already published from a later commit. Release from the tip of main.`);
  return { version: packageVersion, publish: true, published: false, notify: true, reason: 'not on npm yet' };
}

function comparable(file, bytes) {
  if (file !== 'package.json') return bytes;
  try {
    const manifest = JSON.parse(bytes.toString('utf8'));
    delete manifest.version;
    // npm does not install the devDependencies of a dependency.
    delete manifest.devDependencies;
    return Buffer.from(JSON.stringify(manifest));
  } catch {
    return bytes;
  }
}

/**
 * Paths that exist on one side only or whose bytes differ, ignoring the
 * README and the version and devDependencies fields of package.json.
 * @param {Map<string, Buffer>} fresh
 * @param {Map<string, Buffer>} baseline
 */
export function compareTrees(fresh, baseline) {
  return [...new Set([...fresh.keys(), ...baseline.keys()])]
    .filter((file) => {
      if (IGNORED_FILES.has(file)) return false;
      const [ours, theirs] = [fresh.get(file), baseline.get(file)];
      return !ours || !theirs || !comparable(file, ours).equals(comparable(file, theirs));
    })
    .sort();
}

/** @param {string} directory */
export function readTree(directory) {
  const files = new Map();
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.set(path.relative(directory, file).split(path.sep).join('/'), readFileSync(file));
  }
  return files;
}

/** Files that package.json promises to consumers. */
export function entryPoints(manifest) {
  const leaves = (value) => (typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(leaves));
  return [...leaves(manifest.exports), ...leaves(manifest.bin)]
    .filter((file) => !file.includes('*'))
    .map((file) => file.replace(/^\.\//, ''));
}

/**
 * @param {{ version: string, publish: boolean, published: boolean, notify: boolean, reason: string }} plan
 * @param {Record<string, string | undefined>} [env]
 */
export function report({ version, publish, published, notify, reason }, env = process.env) {
  const outputs = Object.entries({ version, publish, published, notify, reason: reason.replace(/\s+/g, ' ').trim() })
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  const summary = `${publish ? 'Publish' : 'Skip'} \`${version}\`: ${reason.replace(/\s+/g, ' ').trim()}.`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${outputs}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(`${summary}\n${outputs}`);
}

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitCount() {
  if (run('git', ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error('The commit count needs the full history. Check out with fetch-depth 0.');
  }
  return Number(run('git', ['rev-list', '--count', 'HEAD']).trim());
}

function publishedVersions(name) {
  try {
    return [JSON.parse(run('npm', ['view', name, 'versions', '--json']))].flat();
  } catch (error) {
    let code;
    try { code = JSON.parse(error.stdout).error.code; } catch { /* Not an npm error report. */ }
    if (code === 'E404') return [];
    throw error;
  }
}

/** The commit npm recorded for a published version, when it recorded one. */
function publishedCommit(name, version) {
  try {
    return [JSON.parse(run('npm', ['view', `${name}@${version}`, 'gitHead', '--json']))].flat()[0];
  } catch {
    return undefined;
  }
}

/** Packs `spec` (the checkout when empty) the way npm would publish it. */
function packedTree(scratch, label, ...spec) {
  const directory = path.join(scratch, label);
  mkdirSync(directory);
  const [{ filename }] = JSON.parse(run('npm', ['pack', ...spec, '--ignore-scripts', '--json', '--pack-destination', scratch]));
  run('tar', ['-xzf', path.join(scratch, filename), '-C', directory, '--strip-components=1']);
  return readTree(directory);
}

function describe(files) {
  const shown = `${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}`;
  return files.length === 1 ? `1 file (${shown}) differs` : `${files.length} files (${shown}) differ`;
}

/**
 * Settles a plan that carries a baseline. `differences` returns the paths
 * that differ from it, and throws when the two packages cannot be compared.
 * @param {{ version: string, baseline: string }} plan
 * @param {() => string[]} differences
 */
export function settlePlan({ version, baseline }, differences) {
  let changed = true;
  let reason;
  try {
    const files = differences();
    changed = files.length > 0;
    reason = changed ? `${describe(files)} from ${baseline}` : `the package is identical to ${baseline}`;
  } catch (error) {
    // Without a baseline nothing proves the package is unchanged.
    console.error(error.message);
    reason = `could not compare with ${baseline}`;
  }
  return { version, publish: changed, published: false, notify: changed, reason };
}

/**
 * Waits until `listed()` includes `version`, for an hour and a half by default:
 * npm has taken close to half an hour to list a version. A lookup that fails
 * counts as not listed yet.
 * @param {string} version
 * @param {() => string[]} listed
 * @param {{ attempts?: number, pauseMs?: number, pause?: (ms: number) => Promise<unknown> }} [options]
 */
export async function awaitVersion(version, listed, { attempts = 360, pauseMs = 15_000, pause = delay } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (listed().includes(version)) return;
    } catch (error) {
      console.error(error.message.split('\n')[0]);
    }
    if (attempt >= attempts) throw new Error(`npm still does not list ${version}. Rerun this job once it does.`);
    if (attempt === 1) console.log(`Waiting for npm to list ${version}.`);
    await pause(pauseMs);
  }
}

async function main() {
  const { values } = parseArgs({ options: { stable: { type: 'boolean', default: false }, await: { type: 'string' } } });
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (values.await !== undefined) {
    if (!parseVersion(values.await)) throw new Error(`--await needs a version, not ${JSON.stringify(values.await)}`);
    return awaitVersion(values.await, () => publishedVersions(manifest.name));
  }
  const published = publishedVersions(manifest.name);
  const count = commitCount();
  if (values.stable) return report(planStable(manifest.version, published, count));

  const plan = planPrerelease(manifest.version, published, count);
  if (plan.published && plan.notify) {
    assertPublishedFrom(plan.version, publishedCommit(manifest.name, plan.version), run('git', ['rev-parse', 'HEAD']).trim());
  }
  if (!plan.baseline) return report(plan);

  const scratch = mkdtempSync(path.join(tmpdir(), 'parcel-scraper-prerelease-'));
  try {
    const fresh = packedTree(scratch, 'fresh');
    const missing = entryPoints(manifest).filter((file) => !fresh.has(file));
    if (missing.length) throw new Error(`The package is missing ${missing.join(', ')}. Run npm run build first.`);
    return report(settlePlan(plan, () => compareTrees(fresh, packedTree(scratch, 'baseline', `${manifest.name}@${plan.baseline}`))));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
