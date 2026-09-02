import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBridge, FakeExtension, scripted, tempDir, run, CHAT } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const chat = (args) => run(CHAT, [...args, '--bridge', bridge.base]);

test('one-shot prints the answer', async (t) => {
  const handler = scripted(['สวัสดีครับ ยินดีช่วยเหลือ']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { out, code } = await chat(['สวัสดี']);
  assert.equal(code, 0);
  assert.match(out, /ยินดีช่วยเหลือ/);
  assert.equal(handler.sent.at(-1), 'สวัสดี', 'the prompt goes through untouched');
});

test('shows tool progress and sources alongside the answer', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => {
      await e.status('[web_search] {"query":"aipass"}');
      await e.text('AiPASS is a platform.');
      await e.status('sources:\n  - Aipass https://aipass.go.th/');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const { out } = await chat(['what is aipass']);
  assert.match(out, /\[web_search\]/);
  assert.match(out, /AiPASS is a platform\./);
  assert.match(out, /aipass\.go\.th/);
});

test('honours an explicit model', async (t) => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await chat(['hi', '--model', 'claude-sonnet-5@default']);
  assert.equal(ext.chats.at(-1).modelId, 'claude-sonnet-5@default');
});

test('exits with a clear message when no extension is attached', async () => {
  const { out, code } = await chat(['hi']);
  assert.equal(code, 1);
  assert.match(out, /extension is not connected/);
});

test('exits with a clear message when the bridge is down', async () => {
  const { out, code } = await run(CHAT, ['hi', '--bridge', 'http://127.0.0.1:1']);
  assert.equal(code, 1);
  assert.match(out, /No bridge at/);
});

test('an image answer is written to a file instead of the scrollback', async (t) => {
  // 1x1 transparent PNG.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => { await e.image(png); await e.done(); },
  }).connect();
  t.after(() => ext.disconnect());

  const dir = tempDir({});
  const { out } = await run(CHAT, ['a cat', '--bridge', bridge.base, '--out', dir]);
  assert.match(out, /image saved to/);

  const written = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  assert.equal(written.length, 1, out);
  // and it is a real PNG, not the base64 text
  assert.equal(fs.readFileSync(path.join(dir, written[0])).subarray(1, 4).toString(), 'PNG');
});
