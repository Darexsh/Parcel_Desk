import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachRoyalMailHistoryCapture } from './royal-mail-history.mjs';
import { attachTrackingCapture } from './tracking-capture.mjs';

const number = 'SG999999999GB';
const pageUrl = `https://www.royalmail.com/track-your-item#/tracking-results/${number}`;
const summaryUrl = `https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/${number}`;
const eventsUrl = `https://api-web.royalmail.com/mailpieces/v3/${number}/events`;
const summary = (mailPieceId = number) => JSON.stringify({ mailPieces: { mailPieceId, summary: { statusCategory: 'Delivered' } } });
const history = JSON.stringify({ mailPieces: { mailPieceId: number,
  events: [{ eventCode: 'EVKOP', eventName: '**Delivered by**', eventDateTime: '2026-01-03T09:00:00Z' }] } });

async function fixture({ onSubmit, onDetails } = {}) {
  const handlers = {};
  const clicks = [];
  const cookies = [];
  const detached = [];
  let value = '';
  const request = (url, method = 'GET', errorText = 'net::ERR_HTTP2_PROTOCOL_ERROR') => ({
    url: () => url, method: () => method, failure: () => ({ errorText }),
  });
  const respond = (url, body, { status = 200, method = 'GET', headers = {}, read } = {}) => handlers.response({
    url: () => url, status: () => status, request: () => request(url, method),
    headers: () => ({ 'content-type': 'application/json', ...headers }),
    body: read ?? (async () => Buffer.from(body)),
  });
  const page = {
    context: () => ({ addCookies: async values => cookies.push(...values) }),
    on: (event, fn) => { handlers[event] = fn; },
    off: event => detached.push(event),
    getByText: () => ({ waitFor: async () => {}, isVisible: async () => false }),
    locator: selector => ({
      waitFor: async () => {}, press: async key => { if (key === 'Backspace') value = ''; },
      pressSequentially: async text => { value = text; },
      evaluate: async (fn, expected) => fn({
        disabled: false, ownerDocument: { querySelector: () => ({ value }) },
        click() {
          clicks.push(selector);
          if (selector === '#submit:not(:disabled)') onSubmit?.({ request, respond, handlers, clicks });
          else onDetails?.({ request, respond, handlers, clicks });
        },
      }, expected),
    }),
  };
  const capture = await attachTrackingCapture(page, pageUrl, { captureResponses: [summaryUrl, eventsUrl], settleTimeout: 20 });
  return { page, capture, respond, handlers, request, clicks, cookies, detached };
}

test('full history requires exactly the identity-bound public route and both API URLs', async () => {
  for (const url of [pageUrl.replace('www.royalmail.com', 'other.test'), pageUrl.replace('/track-your-item', '/other'),
    pageUrl.replace('#/', '?x=1#/'), pageUrl + '?x=1', pageUrl.replace(number, 'NOT-A-NUMBER')]) {
    assert.equal(await attachRoyalMailHistoryCapture({}, url, { captureResponses: [summaryUrl, eventsUrl] }), undefined);
  }
  for (const urls of [[summaryUrl], [eventsUrl], [summaryUrl, eventsUrl.replace(number, 'SG999999998GB')],
    [summaryUrl, eventsUrl, 'https://other.test/'], [summaryUrl, summaryUrl]]) {
    assert.equal(await attachRoyalMailHistoryCapture({}, pageUrl, { captureResponses: urls }), undefined);
  }
});

test('summary success waits for Get more details and captures only exact browser GET replies', async () => {
  const f = await fixture({ onDetails: ({ respond, handlers, request }) => {
    handlers.request(request(eventsUrl)); void respond(eventsUrl, history);
  } });
  await f.respond(summaryUrl, summary(), { method: 'OPTIONS', status: 401 });
  await f.respond(eventsUrl.replace(number, 'SG999999998GB'), history);
  await f.respond(summaryUrl, summary(), { headers: { 'set-cookie': 'PRIVATE_SESSION' } });
  f.handlers.request(f.request(summaryUrl));
  assert.equal(f.capture.hasResponse(), false);
  assert.equal(f.capture.hasTrackingRequest(), true);
  await f.capture.prepare(500);
  assert.equal(f.capture.hasResponse(), true);
  assert.deepEqual(f.clicks, ['#btn-more-details']);
  const rows = (await f.capture.drain()).capturedResponses;
  assert.deepEqual(rows.map(row => row.url), [summaryUrl, eventsUrl]);
  assert.ok(rows.every(row => !Object.keys(row.headers).length));
  assert.equal(f.cookies.length, 4);
});

test('wrong summary identity is terminal and never requests another parcel history', async () => {
  const f = await fixture();
  await f.respond(summaryUrl, summary('SG999999998GB'));
  await f.capture.prepare(100);
  assert.equal(f.capture.hasResponse(), true);
  assert.deepEqual(f.clicks, []);
  assert.equal((await f.capture.drain()).capturedResponses.length, 1);
});

test('one failed summary transport can retry the ordinary form and then request events', async () => {
  const f = await fixture({ onSubmit: ({ handlers, request, respond }) => {
    handlers.request(request(summaryUrl)); void respond(summaryUrl, summary());
  }, onDetails: ({ handlers, request, respond }) => {
    handlers.request(request(eventsUrl)); void respond(eventsUrl, history);
  } });
  f.handlers.request(f.request(summaryUrl));
  f.handlers.requestfailed(f.request(summaryUrl));
  await f.capture.prepare(500);
  assert.deepEqual(f.clicks, ['#submit:not(:disabled)', '#btn-more-details']);
  assert.equal((await f.capture.drain()).capturedResponses.length, 2);
});

test('a repeated transport failure does not submit a third form or expose arbitrary failure text', async () => {
  const f = await fixture({ onSubmit: ({ handlers, request }) => {
    handlers.request(request(summaryUrl)); handlers.requestfailed(request(summaryUrl));
  } });
  f.handlers.request(f.request(summaryUrl));
  f.handlers.requestfailed(f.request(summaryUrl));
  await f.capture.prepare(500);
  await f.capture.prepare(10);
  assert.deepEqual(f.clicks, ['#submit:not(:disabled)']);
  await assert.rejects(f.capture.drain(), { message: 'Royal Mail tracking request failed: network failure' });
  assert.deepEqual(f.detached, ['response', 'request', 'requestfailed']);
});

test('unknown network errors and events failures receive no form retry', async () => {
  for (const url of [summaryUrl, eventsUrl]) {
    const f = await fixture();
    f.handlers.request(f.request(url));
    f.handlers.requestfailed(f.request(url, 'GET', 'PRIVATE_SESSION at https://private.test/'));
    await f.capture.prepare(50);
    assert.deepEqual(f.clicks, []);
    await assert.rejects(f.capture.drain(), { message: 'Royal Mail tracking request failed: network failure' });
  }
});

test('each API allows one page-managed E0015 refresh and ends on repeated denial', async () => {
  for (const url of [summaryUrl, eventsUrl]) {
    const f = await fixture();
    const denial = JSON.stringify({ errors: [{ errorCode: 'E0015' }] });
    await f.respond(url, denial, { status: 401 });
    assert.equal(f.capture.hasResponse(), false);
    await f.respond(url, denial, { status: 401 });
    assert.equal(f.capture.hasResponse(), true);
    await f.capture.settle(500);
    assert.deepEqual((await f.capture.drain()).capturedResponses.map(row => row.status), [401, 401]);
  }
});

test('decoded malformed and oversized envelopes terminate with sanitized capture errors', async () => {
  for (const [body, headers] of [['not JSON', {}], [summary(), { 'content-length': '2000001' }]]) {
    const f = await fixture();
    await f.respond(summaryUrl, body, { headers });
    assert.equal(f.capture.hasResponse(), true);
    assert.ok((await f.capture.drain()).capturedResponses[0].error);
  }
});

test('zero budgets submit nothing, detach observers, and quarantine late decoded bodies', async () => {
  const f = await fixture();
  await assert.rejects(f.capture.prepare(0), /timed out/);
  assert.deepEqual(f.clicks, []);
  let release;
  const pending = f.respond(summaryUrl, summary(), { read: () => new Promise(resolve => { release = resolve; }) });
  const waiting = f.capture.settle(10_000);
  const snapshot = await f.capture.drain();
  await waiting;
  release(Buffer.from(summary()));
  await pending;
  assert.equal(snapshot.capturedResponses[0].body, null);
  assert.deepEqual(f.detached, ['response', 'request', 'requestfailed']);
});
