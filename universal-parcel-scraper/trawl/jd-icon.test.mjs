import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jdIconGeometry, locateJdIcon } from './jd-icon.mjs';

const challenge = { scene: 'data:image/png;base64,AA==', tip: 'data:image/png;base64,AQ==' };

function worker(t, reply, hold = false) {
  const inputs = [], children = [];
  t.mock.method(childProcess, 'spawn', (_path, args, options) => {
    assert.ok(args[0].endsWith('/jd-icon.py'));
    assert.deepEqual(Object.keys(options.env).sort(), ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'PATH']);
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); };
    child.stdin.end = text => {
      inputs.push(JSON.parse(text));
      if (!hold) queueMicrotask(() => { child.stdout.emit('data', reply); child.emit('close', 0); });
    };
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { inputs, children };
}

test('the worker receives only images and returns a bounded point without arbitrary fields', async t => {
  const { inputs } = worker(t, JSON.stringify({ x: 40.5, y: 50, extra: 'PRIVATE' })), outcomes = [];
  const result = await locateJdIcon({ ...challenge, token: 'PRIVATE' }, new AbortController().signal, 1000, x => outcomes.push(x));
  assert.deepEqual(inputs, [challenge]);
  assert.deepEqual(result, { x: 40.5, y: 50 });
  assert.deepEqual(outcomes, ['planned']);
});

test('a decline names only its known reason', async t => {
  for (const [reply, outcome] of [['{"failure":"ambiguous"}', 'ambiguous'], ['{"failure":"geometry"}', 'geometry'],
    ['{"failure":"PRIVATE"}', 'unreadable'], ['null', 'unreadable']]) {
    worker(t, reply); const outcomes = [];
    assert.equal(await locateJdIcon(challenge, new AbortController().signal, 1000, x => outcomes.push(x)), null);
    assert.deepEqual(outcomes, [outcome]);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('only a foreground decline reports its bounded rejected count', async t => {
  for (const count of [0, 59, 901, 3888]) {
    worker(t, JSON.stringify({ failure: 'foreground', foregroundPixels: count, image: 'PRIVATE', token: 'PRIVATE' }));
    const diagnostics = [];
    assert.equal(await locateJdIcon(challenge, new AbortController().signal, 1000,
      (label, pixels) => diagnostics.push({ label, pixels })), null);
    assert.deepEqual(diagnostics, [{ label: 'foreground', pixels: count }]);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
  for (const reply of [
    ...[-1, 1.5, 60, 900, 3889, '901', null].map(count => ({ failure: 'foreground', foregroundPixels: count })),
    { failure: 'ambiguous', foregroundPixels: 901 }, { x: 40, y: 50, foregroundPixels: 901 },
  ]) {
    worker(t, JSON.stringify(reply)); const diagnostics = [];
    await locateJdIcon(challenge, new AbortController().signal, 1000, (_label, pixels) => diagnostics.push(pixels));
    assert.deepEqual(diagnostics, [undefined]);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('the official jpg data-URL spelling reaches the image decoder without relaxing byte validation', async t => {
  const { inputs } = worker(t, '{"x":40,"y":50}');
  const jpg = { scene: challenge.scene.replace('/png;', '/jpg;'), tip: challenge.tip.replace('/png;', '/jpg;') };
  assert.deepEqual(await locateJdIcon(jpg, new AbortController().signal, 1000), { x: 40, y: 50 });
  assert.deepEqual(inputs, [jpg]);
});

test('malformed, uncertain and out-of-bounds worker replies cannot become clicks', async t => {
  for (const reply of ['null', '{', '{"x":275,"y":30}', '{"x":30,"y":170}', '{"x":-1,"y":30}', '{"x":"30","y":40}']) {
    await t.test(reply, async t => {
      worker(t, reply);
      assert.equal(await locateJdIcon(challenge, new AbortController().signal, 1000), null);
    });
  }
});

test('capacity, caller cancellation and timeout bound worker lifetime', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { children } = worker(t, '', true), first = new AbortController(), second = new AbortController(), outcomes = [];
  const a = locateJdIcon(challenge, first.signal, 10000, x => outcomes.push(x));
  const b = locateJdIcon(challenge, second.signal, 10000, x => outcomes.push(x));
  assert.equal(await locateJdIcon(challenge, new AbortController().signal, 1000, x => outcomes.push(x)), null);
  assert.equal(children.length, 2);
  first.abort();
  assert.equal(await a, null);
  t.mock.timers.tick(3000);
  assert.equal(await b, null);
  assert.deepEqual(outcomes, ['capacity', 'cancelled', 'timeout']);
});

test('invalid image input and an exhausted caller budget start no worker', async t => {
  const { children } = worker(t, 'null');
  for (const [input, budget] of [[challenge, 99], [challenge, Infinity], [{ ...challenge, tip: 'https://example.test/private' }, 1000]]) {
    assert.equal(await locateJdIcon(input, new AbortController().signal, budget), null);
  }
  assert.equal(children.length, 0);
});

function page(t) {
  const scene = { complete: true, src: challenge.scene, naturalWidth: 275, naturalHeight: 170,
    getBoundingClientRect: () => ({ x: 20, y: 30, width: 550, height: 340 }) };
  const tip = { complete: true, src: challenge.tip, naturalWidth: 108, naturalHeight: 36,
    getBoundingClientRect: () => ({ width: 216, height: 72 }) };
  const old = { document: globalThis.document, location: globalThis.location, getComputedStyle: globalThis.getComputedStyle };
  globalThis.location = { origin: 'https://www.jdl.com', pathname: '/orderSearch/' };
  globalThis.document = { querySelectorAll: selector => selector === 'img.tip_pic' ? [tip] : [scene] };
  globalThis.getComputedStyle = image => ({ visibility: 'visible', opacity: image.opacity ?? '1' });
  scene.getClientRects = tip.getClientRects = () => [{}];
  t.after(() => { for (const key of ['document', 'location', 'getComputedStyle']) {
    if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key];
  } });
  return { scene, tip };
}

test('click geometry binds both images, their layout, visibility and official page', t => {
  const { scene, tip } = page(t), point = { x: 40, y: 50 };
  assert.deepEqual(jdIconGeometry({ challenge, point }), { x: 100, y: 130 });
  for (const target of [scene, tip]) {
    target.opacity = '0.5';
    assert.equal(jdIconGeometry({ challenge, point }), null);
    target.opacity = '1';
    const source = target.src;
    target.src = 'data:image/png;base64,Ag==';
    assert.equal(jdIconGeometry({ challenge, point }), null);
    target.src = source;
    target.complete = false;
    assert.equal(jdIconGeometry({ challenge, point }), null);
    target.complete = true;
  }
  tip.naturalWidth = 216;
  assert.equal(jdIconGeometry({ challenge, point }), null);
  tip.naturalWidth = 108;
  tip.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(jdIconGeometry({ challenge, point }), null);
  location.origin = 'https://example.test';
  assert.equal(jdIconGeometry({ challenge, point }), null);
});

const python = process.env.JD_ICON_PYTHON ?? '/opt/zto-ocr/bin/python';
test('the actual worker handles synthetic single icons and refuses ambiguity', { skip: !existsSync(python) }, () => {
  childProcess.execFileSync(python, ['-B', fileURLToPath(new URL('./jd-icon.test.py', import.meta.url))], { timeout: 15000 });
});
