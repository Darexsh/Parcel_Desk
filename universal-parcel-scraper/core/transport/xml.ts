/**
 * A bounded element tree for a provider's XML reply. Namespaces are resolved,
 * attributes are not kept, and a document type declaration is refused.
 */
import { SaxesParser } from 'saxes';

export interface XmlNode { name: string; uri: string; text: string; children: XmlNode[] }

const MAX_NODES = 20_000;
const MAX_DEPTH = 24;

/** The root element, or null when `xml` is not one well-formed document within the limits. */
export function xmlDocument(xml: string, maxBytes: number): XmlNode | null {
  if (new TextEncoder().encode(xml).byteLength > maxBytes) return null;
  const invalid = (): never => { throw new SyntaxError('invalid XML'); };
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let count = 0;
  parser.on('error', invalid);
  parser.on('doctype', invalid);
  parser.on('opentag', tag => {
    if (++count > MAX_NODES || stack.length > MAX_DEPTH) invalid();
    const node = { name: tag.local, uri: tag.uri, text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) invalid();
    else root = node;
    stack.push(node);
  });
  const text = (value: string) => { if (stack.length) stack.at(-1)!.text += value; };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  try { parser.write(xml).close(); }
  catch { return null; }
  return root && !stack.length ? root : null;
}
