import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { solveChinaPostCharacters } from './china-post-ocr.mjs';

const challenge = { templateImage: 'data:image/png;base64,AA==', backgroundImage: 'data:image/png;base64,AA==',
  backgroundImageWidth: 200, backgroundImageHeight: 100 };
const points = [{ x: 40, y: 30 }, { x: 140, y: 60 }];

// Exercise both process boundaries without launching a model or using a real image.
function workers(t, positionReply, promptReply = '甲乙') {
  const inputs = [];
  t.mock.method(childProcess, 'spawn', (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => {};
    child.stdin.end = text => {
      const prompt = args[0].endsWith('/china-post-ocr.py');
      inputs.push({ prompt, value: JSON.parse(text) });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(prompt ? promptReply : positionReply)));
        child.emit('close', 0);
      });
    };
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return inputs;
}

test('passes the shared worker positions to China Post without its diagnostic envelope', async t => {
  const inputs = workers(t, { points, boxes: 3, confidence: 0.9, margin: 0.4 });
  const phases = [];
  const result = await solveChinaPostCharacters(challenge, new AbortController().signal, 4000, phase => phases.push(phase));
  assert.deepEqual(result, points);
  assert.deepEqual(phases, ['prompt', 'positions']);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].value.targets, '甲乙');
  assert.deepEqual(inputs[1].value.region, { x: 0, y: 0, width: 200, height: 100 });
});

test('keeps a shared worker failure unreadable instead of returning a click plan', async t => {
  workers(t, { failure: 'boxes', boxes: 1 });
  assert.equal(await solveChinaPostCharacters(challenge, new AbortController().signal, 4000), null);
});

test('only a completed unreadable prompt requests a fresh puzzle', async t => {
  for (const promptReply of [{ failure: 'unreadable' }, null, { failure: 'timeout' }, '甲', { failure: 'PRIVATE' }]) {
    await t.test(JSON.stringify(promptReply), async t => {
      const inputs = workers(t, null, promptReply), phases = [];
      const result = await solveChinaPostCharacters(challenge, new AbortController().signal, 4000, stage => phases.push(stage));
      assert.equal(result, null);
      assert.equal(inputs.length, 1);
      assert.deepEqual(phases, promptReply?.failure === 'unreadable' ? ['prompt', 'prompt-unreadable'] : ['prompt']);
    });
  }
});
