/**
 * A tracker hands its adapters a wrapper around the host's fetcher that only
 * adds each lookup's signal. What is kept for a transport, such as a carrier
 * session, belongs to the fetcher under that wrapper, which the host can name.
 */
const underlying = new WeakMap<typeof fetch, typeof fetch | undefined>();

/** Records that `wrapper` sends its requests through `fetcher`; undefined is the global fetch. */
export function sendsThrough(wrapper: typeof fetch, fetcher: typeof fetch | undefined): typeof fetch {
  underlying.set(wrapper, fetcher);
  return wrapper;
}

/** The fetcher under a recorded wrapper, else the fetcher itself; undefined is the global fetch. */
export function transportOf(fetcher: typeof fetch | undefined): typeof fetch | undefined {
  return fetcher !== undefined && underlying.has(fetcher) ? underlying.get(fetcher) : fetcher;
}
