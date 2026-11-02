// Apart from the adapter, so the app's scan-identity policy can decode stored wording.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', reg: '\u00ae', trade: '\u2122', copy: '\u00a9',
};

/** UPS escapes its prose as HTML: "We&#39;re sorry", "UPS Standard&#174;". */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (entity, body: string) => {
    if (!body.startsWith('#')) {
      const name = body.toLocaleLowerCase('en-US');
      return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name]! : entity;
    }
    const code = /^#x/i.test(body) ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}
