import { describe, expect, it } from 'vitest';
import { join, writeBatch } from '../testing/blazor.js';
import { componentState, MalformedBlazorError, packMessage, readRenderBatch, RenderedPage, serverComponents, unpackMessages } from './blazor.js';

describe('Blazor Server render batches', () => {
  it('applies each kind of edit as the browser renderer does', () => {
    const page = new RenderedPage();
    page.apply(readRenderBatch(writeBatch({
      frames: [
        { type: 'element', name: 'UL', length: 8 }, { type: 'attribute', name: 'class', value: 'list' },
        { type: 'attribute', name: 'data-x', value: 'old' }, { type: 'attribute', name: 'onclick', value: null },
        { type: 'element', name: 'li', length: 2 }, { type: 'text', text: 'one' },
        { type: 'element', name: 'li', length: 2 }, { type: 'text', text: 'two' },
        { type: 'markup', markup: '<b>m</b>' }, { type: 'element', name: 'br', length: 1 }, { type: 'text', text: 'tail' },
        { type: 'component', length: 1, id: 7 },
      ],
      diffs: [{ componentId: 0, edits: [0, 11, 9, 10, 8].map((reference, sibling) => ({ type: 1, sibling, reference })) },
        { componentId: 7, edits: [{ type: 1, sibling: 0, reference: 5 }] }],
    })));
    expect(page.html(0)).toBe('<ul class="list" data-x="old"><li>one</li><li>two</li></ul>one<br>tail<b>m</b>');
    page.apply(readRenderBatch(writeBatch({
      frames: [{ type: 'text', text: 'uno & <dos>' }, { type: 'attribute', name: 'class', value: 'changed "x"' }, { type: 'markup', markup: '<i>n</i>' }],
      diffs: [{ componentId: 0, edits: [
        { type: 3, sibling: 0, reference: 1 }, { type: 4, sibling: 0, removed: 'data-x' },
        { type: 6, sibling: 0 }, { type: 6, sibling: 0 }, { type: 5, sibling: 0, reference: 0 }, { type: 7 },
        { type: 9, sibling: 0, reference: 1 }, { type: 9, sibling: 1, reference: 0 }, { type: 10 }, { type: 7 },
        { type: 8, sibling: 4, reference: 2 }, { type: 2, sibling: 3 }, { type: 2, sibling: 1 },
      ] }],
      disposed: [7],
    })));
    expect(page.html(0)).toBe('<ul class="changed &quot;x&quot;"><li>two</li><li>uno &amp; &lt;dos&gt;</li></ul><br><i>n</i>');
    expect(page.html(7)).toBe('');
  });

  it('reads ASP.NET Core 8’s render mode and named event frames as frames without a node', () => {
    const page = new RenderedPage();
    page.apply(readRenderBatch(writeBatch({
      frames: [{ type: 'element', name: 'form', length: 3 }, { type: 'raw', code: 10 }, { type: 'text', text: 'x' },
        { type: 'component', length: 2, id: 4 }, { type: 'raw', code: 9 }],
      diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }, { type: 1, sibling: 1, reference: 3 }] }],
    })));
    expect(page.html(0)).toBe('<form>x</form>');
  });

  it('rejects batches that do not fit their own layout', () => {
    expect(() => readRenderBatch(new Uint8Array(12))).toThrow(MalformedBlazorError);
    const batch = writeBatch({ frames: [{ type: 'text', text: 'x' }], diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] }] });
    const broken = batch.slice();
    new DataView(broken.buffer).setInt32(broken.length - 16, broken.length, true);
    expect(() => readRenderBatch(broken)).toThrow(/malformed render batch/);
    const page = new RenderedPage();
    // An edit for a node the component does not have.
    expect(() => page.apply(readRenderBatch(writeBatch({ frames: [{ type: 'text', text: 'x' }],
      diffs: [{ componentId: 0, edits: [{ type: 5, sibling: 3, reference: 0 }] }] })))).toThrow(/malformed render batch/);
    // A component inside itself.
    page.apply(readRenderBatch(writeBatch({ frames: [{ type: 'component', length: 1, id: 0 }],
      diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] }] })));
    expect(() => page.html(0)).toThrow(/malformed render batch/);
  });
});

describe('Blazor Server hub messages', () => {
  it('reads the shell’s components and state', () => {
    const shell = '<body><!--Blazor:{"type":"server","key":{"locationHash":"SyntheticHash:1","formattedComponentKey":""},"sequence":0,'
      + '"descriptor":"U3ludGhldGljRGVzY3JpcHRvcg+AA=="}--><!--Blazor:{"type":"webassembly","sequence":1,"descriptor":"x"}-->'
      + '<!--Blazor:{"sequence":2,"type":"server","descriptor":"U3ludGhldGljSGVhZA/BB=="}-->'
      + '<!--Blazor-Server-Component-State:U3ludGhldGljU3RhdGU=--></body>';
    expect(serverComponents(shell)).toEqual([{ type: 'server', sequence: 0, descriptor: 'U3ludGhldGljRGVzY3JpcHRvcg+AA==' },
      { type: 'server', sequence: 2, descriptor: 'U3ludGhldGljSGVhZA/BB==' }]);
    expect(componentState(shell)).toBe('U3ludGhldGljU3RhdGU=');
    expect(componentState('<html></html>')).toBe('');
  });

  it('writes the hub messages the official client writes', () => {
    const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
    expect(base64(packMessage([1, {}, null, 'OnRenderCompleted', [2, null]]))).toBe('GZUBgMCxT25SZW5kZXJDb21wbGV0ZWSSAsA=');
    expect(base64(packMessage([1, {}, null, 'EndInvokeJSFromDotNet', [2, true, '[2,true,false]']])))
      .toBe('LJUBgMC1RW5kSW52b2tlSlNGcm9tRG90TmV0kwLDrlsyLHRydWUsZmFsc2Vd');
    const long = 'x'.repeat(300);
    const bytes = new Uint8Array(70_000).fill(7);
    expect(unpackMessages(join(packMessage([long, bytes, 65_536, { key: [false] }]), packMessage(6)))).toEqual([[long, bytes, 65_536, { key: [false] }], 6]);
    expect(() => unpackMessages(new Uint8Array([0x02, 0x91]))).toThrow(MalformedBlazorError);
    expect(() => unpackMessages(new Uint8Array([0x02, 0x91]))).toThrow(/malformed message/);
  });
});
