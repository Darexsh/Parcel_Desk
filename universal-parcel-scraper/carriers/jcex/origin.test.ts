import { describe, expect, it, vi, beforeEach } from 'vitest';
import { withJcexOrigin } from './origin.js';

type Configuration = { autoSelectFamily: boolean; connect: { timeout: number; servername: string;
  lookup: (hostname: string, options: object, callback: (error: Error | null, address: string, family: number) => void) => void } };
const state = vi.hoisted(() => ({ agents: [] as { configuration: Configuration; destroy: ReturnType<typeof vi.fn<() => Promise<void>>> }[] }));
vi.mock('undici', () => ({ Agent: class {
  destroy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  constructor(readonly configuration: Configuration) { state.agents.push(this); }
} }));
beforeEach(() => { state.agents.length = 0; });

describe('JCEX origin dispatcher', () => {
  it('changes only the address of JCEX’s own host and retains normal TLS verification', async () => {
    await expect(withJcexOrigin(new AbortController().signal, 2345, async dispatcher => {
      expect(dispatcher).toBe(state.agents[0]);
      const config = state.agents[0]!.configuration;
      expect(config).toMatchObject({ autoSelectFamily: false, connect: { servername: 'track.jcex.com', timeout: 2345 } });
      expect(config.connect).not.toHaveProperty('rejectUnauthorized');
      const answer = vi.fn();
      config.connect.lookup('track.jcex.com', {}, answer);
      expect(answer).toHaveBeenCalledWith(null, '45.113.202.100', 4);
      const foreign = vi.fn();
      config.connect.lookup('elsewhere.test', {}, foreign);
      expect(foreign).toHaveBeenCalledWith(expect.any(Error), '', 4);
      return 'history';
    })).resolves.toBe('history');
    expect(state.agents[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('releases the dispatcher on failure without replacing the original error', async () => {
    const error = new Error('failed lookup');
    await expect(withJcexOrigin(new AbortController().signal, 500, async () => {
      state.agents[0]!.destroy.mockRejectedValue(new Error('cleanup failed'));
      throw error;
    })).rejects.toBe(error);
    expect(state.agents[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('creates no dispatcher for an already cancelled lookup', async () => {
    const error = new Error('cancelled');
    const read = vi.fn();
    await expect(withJcexOrigin(AbortSignal.abort(error), 500, read)).rejects.toBe(error);
    expect(read).not.toHaveBeenCalled();
    expect(state.agents).toHaveLength(0);
  });

  it('stops waiting for stalled cleanup when the lookup is cancelled and preserves its error', async () => {
    const controller = new AbortController();
    const error = new Error('failed lookup');
    await expect(withJcexOrigin(controller.signal, 500, async () => {
      state.agents[0]!.destroy.mockImplementation(() => new Promise(() => {}));
      controller.abort(new Error('cancelled'));
      throw error;
    })).rejects.toBe(error);
    expect(state.agents[0]!.destroy).toHaveBeenCalledOnce();
  });
});
