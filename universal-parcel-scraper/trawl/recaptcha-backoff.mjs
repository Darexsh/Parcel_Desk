// Google judges the service's address, shared by all browser contexts and
// solver copies. Store no challenges or responses, only the next audio time.
const BLOCK_MS = 6 * 60 * 60 * 1000;
const KEY = 'trawl:recaptcha:audio-until:v1';
const BLOCK = `
local current = tonumber(redis.call('GET', KEYS[1]))
local now = tonumber(ARGV[1])
if current and current > now and current <= now + tonumber(ARGV[3]) then return current end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[2]) - now)
return tonumber(ARGV[2])`;

/** Use the existing session Redis, with no cookies, challenge data or response bodies. */
export function createRedisAudioBackoffStore({ createClient, key = KEY, timeoutMs = 250 }) {
  const command = async (name, args) => {
    let client, timer, expired = false;
    try {
      return await Promise.race([
        (async () => {
          client = await createClient();
          if (expired) { client.close(); throw new Error('Audio backoff store deadline'); }
          await client.connect();
          if (expired) { client.close(); throw new Error('Audio backoff store deadline'); }
          return await client.send(name, args);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          expired = true;
          client?.close();
          reject(new Error('Audio backoff store deadline'));
        }, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      client?.close();
    }
  };
  return {
    load: () => command('GET', [key]),
    block: (now, until) => command('EVAL', [BLOCK, '1', key, String(now), String(until), String(BLOCK_MS)]),
  };
}

export function createRecaptchaAudioBackoff(now = Date.now, store, unavailable = () => {}) {
  let until = 0;
  const memory = {
    remainingMs: () => Math.max(0, until - now()),
    block: () => {
      const time = now();
      // A concurrent observation or skipped lookup must not prolong the wait.
      if (until <= time) until = time + BLOCK_MS;
    },
  };
  if (!store) return memory;
  const adopt = raw => {
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : 0;
    const time = now();
    if (Number.isSafeInteger(value) && value > time && value <= time + BLOCK_MS) until = value;
  };
  return {
    async remainingMs() {
      try { adopt(await store.load()); } catch { unavailable(); }
      return memory.remainingMs();
    },
    async block() {
      memory.block();
      try { adopt(await store.block(now(), until)); } catch { unavailable(); }
    },
  };
}

const redisUrl = process.env.REDIS_URL?.trim();
const store = process.versions.bun && redisUrl ? createRedisAudioBackoffStore({
  createClient: async () => {
    const { RedisClient } = await import('bun');
    return new RedisClient(redisUrl, { connectionTimeout: 250, autoReconnect: false, enableOfflineQueue: false });
  },
}) : undefined;
let warned = false;
export const recaptchaAudioBackoff = createRecaptchaAudioBackoff(Date.now, store, () => {
  if (!warned) console.warn(JSON.stringify({ event: 'recaptcha.backoff-store', outcome: 'unavailable' }));
  warned = true;
});
