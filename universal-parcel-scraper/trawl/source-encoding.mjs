// Z85 keeps the compressed source below Coolify's outer base64 SSH argument limit.
export const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
export function encodeSource(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let value = 0;
    for (let index = 0; index < 4; index++) value = value * 256 + (bytes[offset + index] ?? 0);
    let block = '';
    for (let index = 0; index < 5; index++) { block = alphabet[value % 85] + block; value = Math.floor(value / 85); }
    result += block;
  }
  return result;
}
// Self-contained so the renderer can install these exact decoding instructions.
export function decodeSource(text, length, alphabet) {
  if (text.length % 5 || length < 0 || length > text.length / 5 * 4) throw new Error('Invalid source archive');
  const bytes = Buffer.alloc(text.length / 5 * 4);
  for (let offset = 0; offset < text.length; offset += 5) {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const digit = alphabet.indexOf(text[offset + index]);
      if (digit < 0) throw new Error('Invalid source archive');
      value = value * 85 + digit;
    }
    if (value > 0xffffffff) throw new Error('Invalid source archive');
    bytes.writeUInt32BE(value, offset / 5 * 4);
  }
  return bytes.subarray(0, length);
}
