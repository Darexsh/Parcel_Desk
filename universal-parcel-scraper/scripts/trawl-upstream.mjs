import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions } from './prerelease.mjs';

// Compares the TRAWL release this repository pins with the newest one
// germondai/trawl has published. With `--write` it moves every pin to that
// release. That is the mechanical part of an upgrade: the patches in
// trawl/install.mjs still have to apply, which the image build tells.
//
// The result is printed, and written to GITHUB_OUTPUT when it is set.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'germondai/trawl';
const IMAGE = `ghcr.io/${REPOSITORY}`;
const MANIFESTS = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];

/**
 * Every place that names the pinned release, as the text it is written in.
 * @typedef {{ version: string, digest: string, commit: string }} Pin
 * @type {ReadonlyArray<{ file: string, text: (pin: Pin) => string }>}
 */
export const PINS = [
  { file: 'trawl/Dockerfile', text: (pin) => `FROM ${IMAGE}:${pin.version}@${pin.digest}\n` },
  { file: 'trawl/SOURCE.md', text: (pin) => `at tag \`v${pin.version}\`, commit\n\`${pin.commit}\`` },
  { file: 'trawl/SOURCE.md', text: (pin) => `${REPOSITORY}/tree/${pin.commit})` },
  { file: 'trawl/SOURCE.md', text: (pin) => `${REPOSITORY}/archive/${pin.commit}.tar.gz` },
  { file: '.github/workflows/release.yml', text: (pin) => `repos/${REPOSITORY}/tarball/${pin.commit} ` },
  { file: 'providers/seventeentrack/README.md', text: (pin) => `Stock ${pin.version} refuses` },
];

const count = (text, part) => text.split(part).length - 1;

/**
 * The pinned release, once every place agrees on it.
 * @param {(file: string) => string} read
 * @returns {Pin}
 */
export function readPin(read) {
  const image = /^FROM (\S+):(\d+\.\d+\.\d+)@(sha256:[0-9a-f]{64})$/m.exec(read('trawl/Dockerfile'));
  const commit = /commit\n`([0-9a-f]{40})`/.exec(read('trawl/SOURCE.md'))?.[1];
  if (image?.[1] !== IMAGE || !commit) throw new Error('trawl/Dockerfile and trawl/SOURCE.md no longer pin a TRAWL release');
  const pin = { version: image[2], digest: image[3], commit };
  for (const { file, text } of PINS) {
    if (count(read(file), text(pin)) !== 1) throw new Error(`${file} does not name TRAWL ${pin.version} as ${JSON.stringify(text(pin).trim())}`);
  }
  return pin;
}

/**
 * The files that change when the pins move, with their new text.
 * @param {(file: string) => string} read
 * @param {Pin} from
 * @param {Pin} to
 * @returns {Map<string, string>}
 */
export function movePins(read, from, to) {
  const files = new Map();
  for (const { file, text } of PINS) files.set(file, (files.get(file) ?? read(file)).replace(text(from), text(to)));
  return files;
}

/**
 * The newest release with its commit and image digest.
 * @param {typeof fetch} fetcher
 * @param {string} [token] Lifts GitHub's anonymous rate limit.
 * @returns {Promise<Pin>}
 */
export async function newestRelease(fetcher, token) {
  const get = async (url, headers = {}) => {
    const reply = await fetcher(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!reply.ok) throw new Error(`${new URL(url).host} answered ${reply.status} for ${new URL(url).pathname}`);
    return reply;
  };
  const github = { 'user-agent': 'universal-parcel-scraper', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  const tag = (await (await get(`${api}/releases/latest`, { ...github, accept: 'application/vnd.github+json' })).json()).tag_name;
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version) throw new Error(`TRAWL's newest release is tagged ${JSON.stringify(tag)}, not a plain version`);
  const commit = (await (await get(`${api}/commits/${tag}`, { ...github, accept: 'application/vnd.github.sha' })).text()).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`GitHub named no commit for ${tag}`);
  const registry = (await (await get(`https://ghcr.io/token?scope=repository:${REPOSITORY}:pull`)).json()).token;
  const digest = (await get(`https://ghcr.io/v2/${REPOSITORY}/manifests/${version}`,
    { authorization: `Bearer ${registry}`, accept: MANIFESTS.join(', ') })).headers.get('docker-content-digest');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`${IMAGE}:${version} has no image digest`);
  return { version, digest, commit };
}

async function main() {
  const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } });
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const pinned = readPin(read);
  const newest = await newestRelease(fetch, process.env.GH_TOKEN);
  const newer = compareVersions(newest.version, pinned.version) > 0;
  if (newer && values.write) {
    for (const [file, text] of movePins(read, pinned, newest)) writeFileSync(path.join(root, file), text);
    readPin(read);
  }
  console.log(newer
    ? `TRAWL ${newest.version} is out and ${pinned.version} is pinned.${values.write ? ' The pins now name it.' : ''}`
    : `TRAWL ${pinned.version} is pinned and is the newest release.`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `pinned=${pinned.version}\nnewest=${newest.version}\nnewer=${newer}\n`);
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
