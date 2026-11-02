import { describe, expect, it, vi } from 'vitest';
import { ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../errors/index.js';
import type { LookupRecord, StepRecord, StepRecorder } from '../telemetry/index.js';
import { recoverableByDefault, runSteps, singleFlight, takeTurn } from './index.js';

function recorder(): StepRecorder & { steps: StepRecord[]; lookups: LookupRecord[] } {
  const steps: StepRecord[] = [];
  const lookups: LookupRecord[] = [];
  return { steps, lookups, step: (record) => { steps.push(record); }, lookup: (record) => { lookups.push(record); } };
}

describe('runSteps', () => {
  it('returns the first step result and records one ok step and one ok lookup', async () => {
    const sink = recorder();
    const value = await runSteps({ carrier: 'ctt', budgetMs: 1_000, recorder: sink }, [
      { id: 'direct', run: async () => 'history' },
      { id: 'trawl', run: async () => { throw new Error('must not run'); } },
    ]);
    expect(value).toBe('history');
    expect(sink.steps).toEqual([expect.objectContaining({ step: 'direct', attempt: 1, outcome: 'ok', fallbackFrom: null })]);
    expect(sink.lookups).toEqual([expect.objectContaining({ finalStep: 'direct', outcome: 'ok', attempts: 1 })]);
  });

  it('falls through to the next step after a challenge and reports the fallback', async () => {
    const sink = recorder();
    const value = await runSteps({ carrier: 'ups', budgetMs: 1_000, recorder: sink }, [
      { id: 'direct', run: async () => { throw new ChallengeError('UPS'); } },
      { id: 'trawl', run: async ({ previousError }) => (previousError instanceof ChallengeError ? 'browser history' : 'wrong') },
    ]);
    expect(value).toBe('browser history');
    expect(sink.steps.map((step) => [step.step, step.outcome, step.fallbackFrom, step.fallbackReason])).toEqual([
      ['direct', 'challenge', null, null],
      ['trawl', 'ok', 'direct', 'challenge'],
    ]);
    expect(sink.lookups[0]).toMatchObject({ finalStep: 'trawl', outcome: 'ok', attempts: 2 });
  });

  it('does not recover from a definite answer such as not found or rate limited', async () => {
    const sink = recorder();
    const trawl = vi.fn(async () => 'never');
    await expect(runSteps({ carrier: 'dhl', budgetMs: 1_000, recorder: sink }, [
      { id: 'direct', run: async () => { throw new NotFoundError('DHL'); } },
      { id: 'trawl', run: trawl },
    ])).rejects.toBeInstanceOf(NotFoundError);
    expect(trawl).not.toHaveBeenCalled();
    expect(sink.lookups[0]).toMatchObject({ finalStep: 'direct', outcome: 'not_found', attempts: 1, errorType: 'NotFoundError' });
    await expect(runSteps({ carrier: 'dhl', budgetMs: 1_000 }, [
      { id: 'direct', run: async () => { throw new RateLimitedError('DHL', 5_000); } },
      { id: 'trawl', run: trawl },
    ])).rejects.toBeInstanceOf(RateLimitedError);
    expect(trawl).not.toHaveBeenCalled();
  });

  it('lets a step opt in to recovering from a definite answer', async () => {
    const value = await runSteps({ carrier: 'ups', budgetMs: 1_000 }, [
      { id: 'api', run: async () => { throw new SchemaError('UPS'); } },
      { id: 'rendered-page', recovers: (error) => error instanceof SchemaError, run: async () => 'parsed from html' },
    ]);
    expect(value).toBe('parsed from html');
  });

  it('skips disabled steps and rethrows the last error when nothing recovers', async () => {
    const sink = recorder();
    const failure = new TransportError('DPD');
    await expect(runSteps({ carrier: 'dpd', budgetMs: 1_000, recorder: sink }, [
      { id: 'direct', run: async () => { throw failure; } },
      { id: 'trawl', enabled: false, run: async () => 'unreachable' },
    ])).rejects.toBe(failure);
    expect(sink.steps).toHaveLength(1);
    expect(sink.lookups[0]).toMatchObject({ finalStep: 'direct', outcome: 'transport', attempts: 1 });
  });

  it('enforces the budget across steps', async () => {
    let clock = 0;
    const sink = recorder();
    await expect(runSteps({ carrier: 'x', budgetMs: 100, recorder: sink, now: () => clock }, [
      { id: 'direct', run: async () => { clock = 150; throw new TransportError('X'); } },
      { id: 'trawl', run: async () => 'late' },
    ])).rejects.toMatchObject({ kind: 'budget' });
    expect(sink.lookups[0]).toMatchObject({ outcome: 'budget', finalStep: 'direct' });
  });

  it('gives each step an abort signal and the remaining budget', async () => {
    let seen: { remainingMs: number; aborted: boolean } | undefined;
    await runSteps({ carrier: 'x', budgetMs: 5_000 }, [
      { id: 'direct', run: async ({ signal, remainingMs }) => { seen = { remainingMs, aborted: signal.aborted }; return 1; } },
    ]);
    expect(seen).toEqual({ remainingMs: expect.any(Number), aborted: false });
    expect(seen!.remainingMs).toBeLessThanOrEqual(5_000);
  });

  it('never lets a broken recorder change the result', async () => {
    const broken: StepRecorder = { step: () => { throw new Error('sink down'); }, lookup: () => { throw new Error('sink down'); } };
    await expect(runSteps({ carrier: 'x', budgetMs: 1_000, recorder: broken }, [{ id: 'direct', run: async () => 'ok' }])).resolves.toBe('ok');
  });

  it('classifies recoverable errors by kind', () => {
    expect(recoverableByDefault(new ChallengeError('X'))).toBe(true);
    expect(recoverableByDefault(new Error('unclassified'))).toBe(true);
    expect(recoverableByDefault(new NotFoundError('X'))).toBe(false);
    expect(recoverableByDefault(new SchemaError('X'))).toBe(false);
  });
});

describe('runSteps cancellation and the last millisecond', () => {
  it('starts no later step once the caller has cancelled, and keeps the interrupted failure whichever step it was', async () => {
    const later = vi.fn(async () => 'never');
    for (const steps of [1, 2]) {
      const sink = recorder();
      const controller = new AbortController();
      const interrupted = new TransportError('ups', 'interrupted');
      await expect(runSteps({ carrier: 'ups', budgetMs: 1_000, recorder: sink, signal: controller.signal }, [
        { id: 'direct', run: async () => { controller.abort(new Error('caller cancelled')); throw interrupted; } },
        { id: 'trawl', run: later },
      ].slice(0, steps))).rejects.toBe(interrupted);
      expect(sink.steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'transport']]);
      expect(sink.lookups).toEqual([expect.objectContaining({ finalStep: 'direct', attempts: 1, outcome: 'transport' })]);
    }
    expect(later).not.toHaveBeenCalled();
  });

  it('runs nothing for a signal that is already aborted: the caller\'s reason, or a budget error for a deadline', async () => {
    const run = vi.fn(async () => 'never');
    const reason = new Error('caller cancelled');
    await expect(runSteps({ carrier: 'ups', budgetMs: 1_000, signal: AbortSignal.abort(reason) }, [{ id: 'direct', run }])).rejects.toBe(reason);
    const deadline = AbortSignal.abort(new DOMException('The operation timed out', 'TimeoutError'));
    await expect(runSteps({ carrier: 'ups', budgetMs: 1_000, signal: deadline }, [{ id: 'direct', run }])).rejects.toMatchObject({ kind: 'budget' });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not start a recovery with under a millisecond of budget left', async () => {
    let time = 0;
    const later = vi.fn(async () => 'never');
    await expect(runSteps({ carrier: 'ups', budgetMs: 1_000, now: () => time }, [
      { id: 'direct', run: async () => { time = 999.4; throw new ChallengeError('UPS'); } },
      { id: 'trawl', run: later },
    ])).rejects.toMatchObject({ kind: 'budget' });
    expect(later).not.toHaveBeenCalled();
  });
});

describe('singleFlight', () => {
  it('serializes operations in call order', async () => {
    const lock = singleFlight();
    const order: string[] = [];
    const first = lock(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); order.push('first'); return 1; });
    const second = lock(async () => { order.push('second'); return 2; });
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first', 'second']);
  });

  it('releases the lock after a failure', async () => {
    const lock = singleFlight();
    await expect(lock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(lock(async () => 'after')).resolves.toBe('after');
  });

  it('does not start a lookup cancelled in the tick its turn comes up', async () => {
    const lock = singleFlight();
    const controller = new AbortController();
    const cancelled = vi.fn(async () => 'never');
    // The lookup in front ends, and its caller cancels the next one as soon as it hears.
    const first = lock(async () => {});
    const waiting = lock(cancelled, controller.signal);
    await first;
    controller.abort(new Error('left as the turn came up'));
    await expect(waiting).rejects.toThrow('left as the turn came up');
    expect(cancelled).not.toHaveBeenCalled();
    await expect(lock(async () => 'next')).resolves.toBe('next');
  });

  it('lets a cancelled lookup leave the queue without starting or reordering the others', async () => {
    const lock = singleFlight();
    const order: string[] = [];
    let finish!: () => void;
    const first = lock(() => new Promise<void>((resolve) => { finish = () => { order.push('first'); resolve(); }; }));
    const controller = new AbortController();
    const cancelled = vi.fn(async () => { order.push('cancelled'); });
    const waiting = lock(cancelled, controller.signal);
    const third = lock(async () => { order.push('third'); });
    controller.abort(new Error('caller cancelled'));
    await expect(waiting).rejects.toThrow('caller cancelled');
    expect(order).toEqual([]);
    finish();
    await Promise.all([first, third]);
    expect(order).toEqual(['first', 'third']);
    expect(cancelled).not.toHaveBeenCalled();
    await expect(lock(async () => 'never', AbortSignal.abort(new Error('already cancelled')))).rejects.toThrow('already cancelled');
  });
});

describe('takeTurn', () => {
  const held = () => { let release!: () => void; const done = new Promise<void>((resolve) => { release = resolve; }); return { done, release }; };

  it('spends a budget the caller set while waiting, and hands the lookup what is left', async () => {
    const serialize = singleFlight();
    const front = held();
    const first = takeTurn(serialize, 'ups', {}, () => front.done);
    const lookup = vi.fn(async () => 'never');
    await expect(takeTurn(serialize, 'ups', { budgetMs: 30 }, lookup)).rejects.toMatchObject({ kind: 'budget', provider: 'ups' });
    expect(lookup).not.toHaveBeenCalled();
    front.release();
    await first;
    const seen = await takeTurn(serialize, 'ups', { budgetMs: 5_000 }, async (left) => left);
    expect(seen.budgetMs).toBeGreaterThan(4_000);
    expect(seen.budgetMs).toBeLessThanOrEqual(5_000);
  });

  it('leaves the default budget to the lookup and ends the wait only on cancellation', async () => {
    const serialize = singleFlight();
    const front = held();
    const first = takeTurn(serialize, 'ups', {}, () => front.done);
    const controller = new AbortController();
    const context = { signal: controller.signal };
    const waiting = takeTurn(serialize, 'ups', context, async (left) => left);
    const cancelled = takeTurn(serialize, 'ups', { signal: AbortSignal.abort(new Error('already cancelled')), budgetMs: 1_000 }, async () => 'never');
    await expect(cancelled).rejects.toThrow('already cancelled');
    front.release();
    await first;
    // The same context comes back: no budget was invented for the lookup.
    await expect(waiting).resolves.toBe(context);
    const reason = new Error('caller cancelled');
    const second = held();
    const holder = takeTurn(serialize, 'ups', {}, () => second.done);
    const leaving = new AbortController();
    const left = takeTurn(serialize, 'ups', { signal: leaving.signal, budgetMs: 60_000 }, async () => 'never');
    leaving.abort(reason);
    await expect(left).rejects.toBe(reason);
    second.release();
    await holder;
  });
});
