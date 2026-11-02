import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { licenseSha256, trawlLicense } from './license.mjs';

const license = readFileSync(new URL('./LICENSE', import.meta.url), 'utf8');
// Debian's copy differs from upstream's only in where one appendix line wraps.
const debian = license.replace('License as published\n    by the Free', 'License as published by\n    the Free');

test("the image rebuilds TRAWL's LICENSE byte for byte from Debian's AGPL-3.0 text", () => {
  assert.notEqual(debian, license);
  assert.equal(trawlLicense(debian), license);
  assert.equal(trawlLicense(license), license);
  assert.throws(() => trawlLicense(debian.replace('Version 3', 'Version 4')), /review TRAWL's LICENSE/);
  assert.match(licenseSha256, /^[0-9a-f]{64}$/);
});

test('the Dockerfile leaves the license text to the build', () => {
  const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
  assert.doesNotMatch(dockerfile, /^COPY LICENSE /m);
  assert.match(dockerfile, /^COPY license\.mjs \/app\/packages\/tiers\/src\/utils\/license\.mjs$/m);
  assert.match(readFileSync(new URL('./install.mjs', import.meta.url), 'utf8'),
    /writeFileSync\('\/usr\/share\/licenses\/trawl\/LICENSE', trawlLicense\(readFileSync\('\/usr\/share\/common-licenses\/AGPL-3\.0', 'utf8'\)\)\)/);
});
