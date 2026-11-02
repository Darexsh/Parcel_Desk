import { TransportError } from '../errors/index.js';
export async function loadChromium(provider: string) {
  try { return (await import('playwright-core')).chromium; }
  catch (cause) { throw new TransportError(provider, 'Install playwright-core to enable browser tracking', { cause }); }
}
export async function loadSharp(provider: string) {
  try { return (await import('sharp')).default; }
  catch (cause) { throw new TransportError(provider, 'Install sharp to enable image challenges', { cause }); }
}
