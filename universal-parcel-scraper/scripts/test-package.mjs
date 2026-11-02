import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'parcel-scraper-package-'));
let tarball;
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root, encoding: 'utf8' }))[0];
  tarball = path.join(scratch, packed.filename);
  assert(packed.files.every(file => !/fixtures|private\.numbers|\.env|\.test\.|\.git\//.test(file.path)));
  writeFileSync(path.join(scratch,'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install','--ignore-scripts','--omit=optional','--no-audit','--no-fund',tarball], { cwd: scratch, stdio: 'pipe' });
  const dpdAppReplies = Object.fromEntries([
    ['getSessionFullState', 'session'], ['getTrackingData', 'tracking'], ['getTrackingScanList', 'scans'],
  ].map(([operation, fixture]) => [operation, readFileSync(path.join(root, 'carriers/dpd-de/fixtures', `app-${fixture}.xml`), 'utf8')]));
  const regionalGofoReplies = Object.fromEntries(['fr', 'it'].map(region => [region,
    JSON.parse(readFileSync(path.join(root, `carriers/gofo-${region}/fixtures/delivered.json`), 'utf8'))]));
  const omgoReplies = Object.fromEntries(['tracking-page.html', 'tracking.json'].map(file => [file,
    readFileSync(path.join(root, 'carriers/omgo/fixtures', file), 'utf8')]));
  const ninjaReply = JSON.parse(readFileSync(path.join(root, 'carriers/ninja-van/fixtures/delivered.json'), 'utf8'));
  writeFileSync(path.join(scratch,'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync, existsSync } from 'node:fs';
    import { parseTrackingInput, CARRIER_CATALOG } from 'universal-parcel-scraper';
    import { createTracker } from 'universal-parcel-scraper/node';
    import { locatePlace } from 'universal-parcel-scraper/places';
    import * as tracking from 'universal-parcel-scraper';
    import { carrierTrackingHintKey } from 'universal-parcel-scraper/app';
    import catalog from 'universal-parcel-scraper/data/catalog.json' with { type: 'json' };
    import stages from 'universal-parcel-scraper/data/stages.json' with { type: 'json' };
    import golden from 'universal-parcel-scraper/data/detection-golden.json' with { type: 'json' };
    import checksumVectors from 'universal-parcel-scraper/data/checksum-vectors.json' with { type: 'json' };
    import schema from 'universal-parcel-scraper/data/carrier.schema.json' with { type: 'json' };
    const match = parseTrackingInput('1Z999AA10123456784');
    assert.equal(match.carrier, 'ups');
    assert.equal(createTracker({ providers: [] }).detect(match.trackingNumber).carrier, 'ups');
    // Exercise Chronopost through the installed registry, without optional browsers.
    const chronopostNumber = 'XU123456799FR';
    const chronopostXml = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
      + '<t:trackSkybillV2Response xmlns:t="http://cxf.tracking.soap.chronopost.fr/"><return><errorCode>0</errorCode><listEventInfoComp>'
      + "<events><code>TS</code><eventDate>2026-01-03T15:01:15+01:00</eventDate><eventLabel>Colis en cours d'acheminement</eventLabel></events>"
      + '<skybillNumber>' + chronopostNumber + '</skybillNumber></listEventInfoComp></return></t:trackSkybillV2Response></s:Body></s:Envelope>';
    const chronopost = await createTracker({ providers: [], fetcher: async (url, init) => {
      assert.equal(String(url), 'https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS');
      assert(init.signal instanceof AbortSignal && init.body.includes(chronopostNumber));
      return new Response(chronopostXml);
    } }).track({ number: chronopostNumber, carrier: 'chronopost' });
    assert.equal(chronopost.source, 'chronopost');
    assert.equal(chronopost.result.events[0].instant, '2026-01-03T15:01:15+01:00');
    // Read DPD Germany's forecast through the installed adapter and result facade.
    const dpdAppReplies = ${JSON.stringify(dpdAppReplies)};
    const dpd = await createTracker({ providers: [], fetcher: async (url, init) => {
      assert.equal(String(url), 'https://api.paketnavigator.de/services/v1/Navigator3Service.asmx');
      const operation = new Headers(init.headers).get('SOAPAction').split('/').at(-1).replaceAll('"', '');
      assert(dpdAppReplies[operation] && init.signal instanceof AbortSignal);
      return new Response(dpdAppReplies[operation]);
    } }).track({ number: '01000000000001', carrier: 'dpd-de' });
    assert.equal(dpd.result.expected_delivery, '2026-01-03');
    assert.equal(dpd.result.events.length, 5);
    // Regional GOFO lookups must load their own maps and shared implementation from the package.
    const regionalGofoReplies = ${JSON.stringify(regionalGofoReplies)};
    for (const region of ['fr', 'it']) {
      const carrier = 'gofo-' + region;
      const number = regionalGofoReplies[region].data[0].waybillNo;
      const answer = await createTracker({ providers: [], fetcher: async (url, init) => {
        assert.equal(String(url), 'https://www.gofo.com/' + region + '/open-api/official/track/queryTrackV2');
        assert(init.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(init.body), { numberList: [number] });
        return Response.json(regionalGofoReplies[region]);
      } }).track({ number, carrier });
      assert.equal(answer.source, carrier);
      assert.equal(answer.result.status, 'delivered');
      assert(answer.result.events.length >= 7);
    }
    const omgoReplies = ${JSON.stringify(omgoReplies)};
    let omgoRequests = 0;
    const omgo = await createTracker({ providers: [], fetcher: async (url, init) => {
      omgoRequests += 1;
      assert(init.signal instanceof AbortSignal);
      if (omgoRequests === 1) {
        assert.equal(new URL(url).pathname, '/track-package/');
        return new Response(omgoReplies['tracking-page.html']);
      }
      assert.equal(String(url), 'https://omgoexpress.cn/wp-admin/admin-ajax.php');
      assert.equal(init.body.get('tracking_codes'), 'OMGO0000000000001');
      return new Response(omgoReplies['tracking.json']);
    } }).track({ number: 'OMGO0000000000001', carrier: 'omgo' });
    assert.equal(omgo.source, 'omgo');
    assert.equal(omgo.result.status, 'in_transit');
    assert.equal(omgoRequests, 2);
    const ninjaReply = ${JSON.stringify(ninjaReply)};
    for (const country of ['sg', 'my', 'id', 'ph', 'th', 'vn']) {
      const number = 'NL' + country.toUpperCase() + 'A00000001';
      const answer = await createTracker({ providers: [], fetcher: async (url, init) => {
        const request = new URL(url);
        assert.equal(request.origin, 'https://walrus.ninjavan.co');
        assert.equal(request.pathname, '/' + country + '/dash/1.2/public/orders');
        assert.equal(request.searchParams.get('tracking_id'), number);
        assert(init.signal instanceof AbortSignal);
        return Response.json({ ...ninjaReply, tracking_id: number });
      } }).track({ number, carrier: 'ninja-van' });
      assert.equal(answer.source, 'ninja-van');
      assert.equal(answer.result.status, 'delivered');
      assert.equal(answer.result.events.length, ninjaReply.events.length);
      const portal = new URL(tracking.CARRIERS['ninja-van'].trackingUrl(number));
      assert.equal(portal.pathname, '/en-' + country + '/tracking');
      assert.equal(portal.searchParams.get('id'), number);
    }
    assert.deepEqual(catalog, CARRIER_CATALOG);
    assert(stages.includes('delivered') && golden.length > 0 && checksumVectors.vectors.ups.length > 0 && schema.type === 'object');
    assert.equal(locatePlace('Paris, FR').country, 'FR');
    assert.equal(locatePlace('Example TMO 800001', { countries: ['IN'] })?.name, 'Patna');
    assert.equal(typeof carrierTrackingHintKey('ups'), 'string');
    assert(!('carrierTrackingHintKey' in tracking));
    const base = new URL('.', import.meta.resolve('universal-parcel-scraper/node'));
    for (const file of ['carriers/correios-br/ocr-worker.mjs','carriers/correios-br/model/captcha.onnx','carriers/correios-br/model/LICENSE',
      'carriers/viettel-post/ocr-worker.mjs','core/transport/text-captcha-worker.mjs','core/transport/text-captcha-model/captcha.onnx','core/transport/text-captcha-model/characters.json','core/transport/text-captcha-model/arithmetic-characters.json','core/transport/text-captcha-model/LICENSE',
      'places/places.tsv.br','places/pincodes.json','places/zipcodes.json','browser/scraper.js']) assert(existsSync(new URL(file, base)), file);
    assert(!readFileSync(new URL('browser/scraper.js', base), 'utf8').includes('node:'));
  `);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: scratch, stdio: 'inherit' });
  writeFileSync(path.join(scratch,'smoke.cjs'), `
    const assert = require('node:assert/strict');
    assert.equal(require('universal-parcel-scraper').parseTrackingInput('1Z999AA10123456784').carrier, 'ups');
    assert.equal(typeof require('universal-parcel-scraper/node').createTracker, 'function');
    assert.equal(require('universal-parcel-scraper/places').locatePlace('Paris, FR').country, 'FR');
  `);
  execFileSync(process.execPath, ['smoke.cjs'], { cwd: scratch, stdio: 'inherit' });
  const cli = execFileSync(path.join(scratch, 'node_modules/.bin/parcel-scraper'), ['detect','1Z999AA10123456784'], { cwd: scratch, encoding: 'utf8' });
  assert.equal(JSON.parse(cli).carrier, 'ups');
  assert(existsSync(tarball));
  const forbidden = /"(?:next|react|@supabase|@sentry)/;
  assert(!forbidden.test(readFileSync(path.join(scratch,'node_modules/universal-parcel-scraper/package.json'),'utf8')));
  console.log(`Packed package verified: ${packed.files.length} files; all entry points load through import and require; CLI and assets work without optional dependencies.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
