import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyText, messageCopyText } from '../../web/src/copy.ts';

const text = '## **Plan**\n\n```ts\nconst ready = true;\n```\n';

test('copy source preserves Markdown and owner text', () => {
  for (const role of ['bot', 'user'] as const) {
    assert.equal(messageCopyText({ role, text, meta: null }), text);
  }
  assert.equal(messageCopyText({ role: 'event', text, meta: null }), null);
});

test('missing or rejected clipboard uses the textarea fallback', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('denied'); } }]) {
    let selected = '';
    let removed = false;
    const textarea = {
      value: '', style: {}, setAttribute() {}, focus() {}, select() {},
      setSelectionRange(start: number, end: number) { selected = this.value.slice(start, end); },
      remove() { removed = true; },
    };
    const document = {
      activeElement: null, body: { appendChild() {} },
      createElement: () => textarea,
      execCommand(command: string) { assert.equal(command, 'copy'); return true; },
    } as unknown as Document;
    assert.equal(await copyText(text, { clipboard, document }), true);
    assert.equal(selected, text);
    assert.equal(removed, true);
  }
});
