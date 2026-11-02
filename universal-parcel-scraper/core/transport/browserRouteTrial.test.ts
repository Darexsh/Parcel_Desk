import { afterEach, expect, it, vi } from 'vitest';
import type { StepRecord } from '../telemetry/index.js';
import { BrowserRouteTrial, browserContextProxy, retryShare } from './browserRouteTrial.js';

afterEach(() => vi.restoreAllMocks());
const record: StepRecord = { carrier: 'test', step: 'browser', attempt: 2, outcome: 'ok', errorType: null,
  durationMs: 10, fallbackFrom: 'direct', fallbackReason: 'challenge', fallbackErrorType: 'ChallengeError' };

it('assigns once at an eligible retry, resets observations and omits unstarted steps', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.49).mockReturnValueOnce(0.9);
  const step = vi.fn(), trial = new BrowserRouteTrial({ primary: 'normal', alternative: 'alternate', route: 'residential',
    share: 0.5, steps: ['browser'], recorder: { step, lookup() {} } });
  expect(trial.primary()).toBe('normal'); expect(random).not.toHaveBeenCalled();
  trial.result({ status: 'in_transit', last_update: null, last_status_text: 'In transit', expected_delivery: null,
    events: [{ local_time: '2026-01-01T12:00:00', description: 'In transit' }] });
  trial.recorder.step(record);
  expect(step.mock.calls[0]?.[0]).toMatchObject({ networkRoute: 'default', networkAttempt: 'initial', historyAvailable: true });
  expect(trial.retry()).toBe('alternate'); trial.recorder.step({ ...record, outcome: 'challenge' });
  expect(step.mock.calls[1]?.[0]).toMatchObject({ networkRoute: 'residential', networkAttempt: 'retry', networkFamily: 'unknown', historyAvailable: false });
  expect(trial.retry()).toBe('alternate'); expect(random).toHaveBeenCalledOnce(); trial.recorder.step(record);
  trial.recorder.step(record); expect(step.mock.calls[3]?.[0]).not.toHaveProperty('networkRoute');
});

it('keeps the default route when absent or the lottery misses, without inventing connection proof', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  for (const alternative of [null, 'alternate']) {
    const step = vi.fn(), trial = new BrowserRouteTrial({ primary: 'normal', alternative, route: 'ipv6', share: 0.5,
      steps: ['browser'], recorder: { step, lookup() {} } });
    expect(trial.retry()).toBe('normal'); expect(trial.isAlternate).toBe(false);
    trial.recorder.step(record); expect(step.mock.calls[0]?.[0]).toMatchObject({ networkFamily: 'unknown', historyAvailable: false });
  }
});

it.each([-1, 1.01, NaN, Infinity])('rejects invalid shares %s', value => expect(() => retryShare(value)).toThrow(TypeError));

it('keeps proxy credentials out of the server address and validates without echoing configuration', () => {
  expect(browserContextProxy('http://user:p%40ss@proxy.test:8080')).toEqual({ server: 'http://proxy.test:8080', username: 'user', password: 'p@ss' });
  expect(browserContextProxy('https://proxy.test')).toEqual({ server: 'https://proxy.test' });
  for (const value of ['socks5://user:secret@proxy.test', 'http://proxy.test/path?secret=value', 'http://%ZZ:secret@proxy.test', 'secret']) {
    try { browserContextProxy(value); throw new Error('Unexpected acceptance'); }
    catch (error) { expect(error).toBeInstanceOf(TypeError); expect(String(error)).not.toContain('secret'); }
  }
});
