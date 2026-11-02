import { describe, expect, it } from 'vitest';
import { CHINA_POST_CHECK_PATH, CHINA_POST_TRACE_PATH, chinaPostSignature } from './app.js';

const BODY = '{"mailNo":"LZ123456785CN"}';

describe('China Post app request signature', () => {
  it('signs the path after /ect-web and the JSON body like the app', () => {
    // Independent HMAC-SHA256 vectors for a synthetic key.
    expect(chinaPostSignature(CHINA_POST_CHECK_PATH, BODY, 'synthetic-signing-key')).toBe('rVS/qxj+OK3vgH1a16P5Q6/NXO5fxOq/YhW0e32T1+s=');
    expect(chinaPostSignature(CHINA_POST_TRACE_PATH, BODY, 'synthetic-signing-key')).toBe('xcbvtjb4/hCnteks+kJOd3glNb3qUyUgIHfGyKT1Lao=');
  });
});
