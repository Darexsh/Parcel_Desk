import { describe, expect, it, vi } from 'vitest';
import { parseRoyalMailVisionPlan, planRoyalMailVision } from './vision-model.js';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PLAN = { action: 'drag', confidence: 0.99, reason: 'none', points: [{ x: 250, y: 650 }, { x: 750, y: 450 }] };
const reply = (data: unknown = PLAN, finishReason = 'STOP') => new Response(JSON.stringify({ candidates: [
  { finishReason, content: { parts: [{ text: JSON.stringify(data) }] } },
] }));

describe('Royal Mail optional verification model', () => {
  it('sends only the widget image to the fixed API with bounded output and low thinking', async () => {
    const fetcher = vi.fn(async () => reply());
    await expect(planRoyalMailVision({ apiKey: 'synthetic-key', fetcher }, PNG, new AbortController().signal, 6000))
      .resolves.toEqual({ action: 'drag', points: PLAN.points });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(request.redirect).toBe('error');
    expect(new Headers(request.headers).get('x-goog-api-key')).toBe('synthetic-key');
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') } }] }]);
    expect(body.generationConfig).toMatchObject({ candidateCount: 1, maxOutputTokens: 512, thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('can supply the original and its derived coordinate guide without changing either image', async () => {
    const fetcher = vi.fn(async () => reply());
    const guide = Uint8Array.from([...PNG, 0]);
    await planRoyalMailVision({ apiKey: 'synthetic-key', fetcher }, PNG, new AbortController().signal, 6000, guide);
    const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(request.body as string) as { contents: { parts: { inlineData: { data: string } }[] }[] };
    expect(body.contents[0]?.parts.map(part => part.inlineData.data)).toEqual([Buffer.from(PNG).toString('base64'), Buffer.from(guide).toString('base64')]);
    expect(PNG).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('does not leak credentials, puzzle bytes or diagnostics when the model refuses or fails', async () => {
    for (const fetcher of [vi.fn(async () => { throw new Error('PRIVATE credentials and image'); }),
      vi.fn(async () => new Response('PRIVATE rejection body', { status: 403 })),
      vi.fn(async () => new Response('PRIVATE', { status: 429 })),
      vi.fn(async () => new Response('x'.repeat(16_001))),
      vi.fn(async () => new Response('PRIVATE invalid JSON'))]) {
      await expect(planRoyalMailVision({ apiKey: 'synthetic-key', fetcher }, PNG, new AbortController().signal, 6000)).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it.each(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER'])('does not click an unfinished or refused answer: %s', async reason => {
    await expect(planRoyalMailVision({ apiKey: 'synthetic-key', fetcher: async () => reply(PLAN, reason) }, PNG,
      new AbortController().signal, 6000)).resolves.toBeNull();
  });

  it('honors cancellation before sending any credential or image', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    controller.abort(cancelled);
    const fetcher = vi.fn(async () => reply());
    await expect(planRoyalMailVision({ apiKey: 'synthetic-key', fetcher }, PNG, controller.signal, 6000)).rejects.toBe(cancelled);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('declines insufficient time, excessive images and invalid configuration before making a call', async () => {
    const fetcher = vi.fn(async () => reply());
    for (const [options, image, timeout] of [
      [{ apiKey: '' }, PNG, 6000], [{ apiKey: 'two words' }, PNG, 6000],
      [{ apiKey: 'synthetic-key' }, PNG, 100], [{ apiKey: 'synthetic-key' }, new Uint8Array(1_000_001), 6000],
      [{ apiKey: 'line\nbreak' }, PNG, 6000],
    ] as const) {
      await expect(planRoyalMailVision({ ...options, fetcher }, image, new AbortController().signal, timeout)).resolves.toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Royal Mail vision plan refusal boundaries', () => {
  it.each([
    { ...PLAN, confidence: 0.949 }, { ...PLAN, confidence: 1.1 }, { ...PLAN, confidence: NaN },
    { ...PLAN, action: 'decline' }, { ...PLAN, action: 'execute' },
    { ...PLAN, reason: 'uncertain' }, { ...PLAN, reason: 'unsupported' },
    { ...PLAN, reason: 'cannot_assist' }, { ...PLAN, reason: undefined },
    { ...PLAN, points: [] }, { ...PLAN, points: [{ x: -1, y: 400 }] },
    { ...PLAN, points: [{ x: 400, y: 1000 }] }, { ...PLAN, points: [{ x: Infinity, y: 400 }] },
    { ...PLAN, points: [{ x: '400', y: 400 }] },
    { ...PLAN, points: [{ x: 400, y: 400 }, { x: 401, y: 401 }] },
    { ...PLAN, action: 'click' }, { ...PLAN, points: [{ x: 300, y: 600 }] },
  ])('declines uncertainty, invalid coordinates and ambiguous repeated actions: %j', plan => {
    expect(parseRoyalMailVisionPlan(plan)).toBeNull();
  });

  it('accepts a bounded drag with two distinct points', () => {
    expect(parseRoyalMailVisionPlan({ action: 'drag', confidence: 0.99, reason: 'none', points: [{ x: 100, y: 700 }, { x: 800, y: 500 }] }))
      .toEqual({ action: 'drag', points: [{ x: 100, y: 700 }, { x: 800, y: 500 }] });
  });
});
