import { fetchBounded } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

export interface RoyalMailVisionOptions {
  apiKey: string;
  fetcher?: typeof fetch;
}

export interface RoyalMailVisionPlan {
  action: 'drag';
  /** Coordinates relative to the puzzle crop, on a 0–1000 scale. */
  points: { x: number; y: number }[];
}

const PROMPT = 'Solve this hCaptcha visual puzzle. The image contains its instructions and task. '
    + 'If two images are provided, the first is the original and the second is the same image with a coordinate guide. '
    + 'Use the original for recognizing objects and the guide only for locating them. Grid lines and labels are not task objects. '
    + 'Return click points, or the start and end points of one drag, on a 0 to 1000 coordinate scale relative to the entire image. '
    + 'Click only the requested targets inside the task image, never interface controls. '
    + 'Use action decline, confidence 0 and no points for an unclear, unsupported or ambiguous task. '
    + 'If declining, use reason uncertain, unsupported, or cannot_assist; otherwise use none. '
    + 'Do not guess. Return only the requested JSON.';
const SCHEMA = { type: 'object', properties: {
        action: { type: 'string', enum: ['click', 'drag', 'decline'] },
        confidence: { type: 'number' },
        reason: { type: 'string', enum: ['uncertain', 'unsupported', 'cannot_assist', 'none'] },
        points: { type: 'array', items: { type: 'object', properties: {
                    x: { type: 'number' }, y: { type: 'number' },
                }, required: ['x', 'y'] } },
    }, required: ['action', 'confidence', 'points', 'reason'] };
/** Only a cropped verification widget reaches Google; credentials and pixels are never returned or logged. */
export async function planRoyalMailVision(options: RoyalMailVisionOptions, png: Uint8Array,
  signal: AbortSignal, timeoutMs: number, guide?: Uint8Array): Promise<RoyalMailVisionPlan | null> {
  signal.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || png.byteLength < 8 || png.byteLength > 1_000_000
    || guide !== undefined && (guide.byteLength < 8 || guide.byteLength > 1_000_000)
    || !options.apiKey || options.apiKey.length > 512 || /\s/.test(options.apiKey)) return null;
  let bytes: Uint8Array;
  const model = 'gemini-3.5-flash-lite';
  try {
    ({ bytes } = await fetchBounded(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey },
      body: JSON.stringify({ store: false, systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: 'user', parts: [png, ...(guide ? [guide] : [])].map(image => ({
          inlineData: { mimeType: 'image/png', data: Buffer.from(image).toString('base64') },
        })) }],
        generationConfig: { temperature: 0, candidateCount: 1, maxOutputTokens: 512,
          thinkingConfig: { thinkingLevel: 'MINIMAL' },
          responseMimeType: 'application/json', responseSchema: SCHEMA } }),
    }, { provider: 'Royal Mail verification model', fetcher: options.fetcher, timeoutMs: Math.min(10_000, timeoutMs),
      maxBytes: 16_000, redirect: 'error', retryTransient: false }));
  } catch {
    // Transport errors retain request diagnostics, including credentials and the
    // image. They must not escape this private model boundary.
    signal.throwIfAborted();
    return null;
  }
  signal.throwIfAborted();
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(data) || !Array.isArray(data.candidates) || data.candidates.length !== 1) return null;
    const candidate: unknown = data.candidates[0];
    if (!isRecord(candidate) || candidate.finishReason !== 'STOP' || !isRecord(candidate.content)
      || !Array.isArray(candidate.content.parts)) return null;
    const parts = candidate.content.parts.filter(part => isRecord(part) && part.thought !== true && typeof part.text === 'string');
    if (parts.length !== 1 || !isRecord(parts[0]) || typeof parts[0].text !== 'string' || parts[0].text.length > 3000) return null;
    return parseRoyalMailVisionPlan(JSON.parse(parts[0].text));
  } catch { return null; }
}

export function parseRoyalMailVisionPlan(data: unknown): RoyalMailVisionPlan | null {
  if (!isRecord(data) || data.action !== 'drag' || data.reason !== 'none' || typeof data.confidence !== 'number'
    || !Number.isFinite(data.confidence) || data.confidence < 0.95 || data.confidence > 1 || !Array.isArray(data.points)
    || data.points.length !== 2) return null;
  const points: RoyalMailVisionPlan['points'] = [];
  for (const point of data.points) {
    if (!isRecord(point) || typeof point.x !== 'number' || typeof point.y !== 'number') return null;
    const { x, y } = point;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 1 || x > 999 || y < 1 || y > 999
      || points.some(other => Math.hypot(other.x - x, other.y - y) < 10)) return null;
    points.push({ x, y });
  }
  return { action: data.action, points };
}
