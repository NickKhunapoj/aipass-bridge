import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, FakeExtension, scripted, waitFor } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const post = (body) => fetch(`${bridge.base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function readStream(res) {
  const text = await res.text();
  const frames = text.split('\n\n')
    .map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter((d) => d && d !== '[DONE]')
    .map((d) => JSON.parse(d));
  return {
    content: frames.map((f) => f.choices?.[0]?.delta?.content ?? '').join(''),
    reasoning: frames.map((f) => f.choices?.[0]?.delta?.reasoning_content ?? '').join(''),
    finish: frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean).at(-1),
    error: frames.find((f) => f.error)?.error,
    done: text.includes('data: [DONE]'),
  };
}

test('refuses a request with no extension attached', async () => {
  const res = await post({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error.message, /no extension connected/);
});

test('streams text, tool status and a finish reason', async () => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      await e.status('[web_search] {"query":"x"}');
      await e.text('hello ');
      await e.text('world');
      await e.status('sources:\n  - X https://example.com');
      await e.done();
    },
  }).connect();

  const out = await readStream(await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(out.content, 'hello world');
  assert.match(out.reasoning, /web_search/);
  assert.match(out.reasoning, /sources:/);
  assert.equal(out.finish, 'stop');
  assert.ok(out.done);
  await ext.disconnect();
});

test('forwards only the newest user message, never an assistant turn', async () => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();

  await post({
    messages: [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'the newest question' },
    ],
  });

  assert.equal(handler.sent.at(-1), 'the newest question');
  assert.doesNotMatch(handler.sent.at(-1), /SYSTEM PROMPT|earlier answer|first question/);
  await ext.disconnect();
});

test('non-streaming returns a complete message with usage', async () => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => { await e.text('the answer'); await e.done(); },
  }).connect();

  const body = await (await post({ messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(body.choices[0].message.content, 'the answer');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.ok(body.usage.total_tokens > 0);
  await ext.disconnect();
});

test('rejects a request carrying no user message', async () => {
  const ext = await new FakeExtension(bridge.base).connect();
  const res = await post({ messages: [{ role: 'system', content: 'only a system turn' }] });
  assert.equal(res.status, 400);
  await ext.disconnect();
});

test('discovers models, marks free credit, and drops media generators', async () => {
  const ext = await new FakeExtension(bridge.base).connect();
  await waitFor(async () => (await (await fetch(`${bridge.base}/v1/models?refresh=1`)).json()).data.length > 1);

  const { data } = await (await fetch(`${bridge.base}/v1/models`)).json();
  const ids = data.map((m) => m.id);
  assert.ok(ids.includes('gemini-3.1-flash-lite'));
  assert.ok(ids.includes('claude-sonnet-5@default'));
  assert.ok(!ids.includes('veo-3.1-fast-generate-001'), 'video model should be filtered out');
  assert.equal(data.find((m) => m.id === 'gemini-3.1-flash-lite').free_credit, true);
  await ext.disconnect();
});

test('picks the most recent conversation and rotates past one that is locked', async () => {
  const seen = [];
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      seen.push(job.conversationId);
      if (job.conversationId === 'aaaa1111aaaa1111') return void e.error('aipass returned 409 — {"detail":"Conversation is busy"}');
      await e.text('ok');
      await e.done();
    },
  }).connect();

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversation: null }),
  });

  const body = await (await post({ messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(body.choices[0].message.content, 'ok');
  assert.deepEqual(seen, ['aaaa1111aaaa1111', 'bbbb2222bbbb2222'], 'should try newest first, then the next');
  await ext.disconnect();
});

test('a job survives the extension disconnecting mid-stream', async () => {
  let resume;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      await e.text('part one ');
      await ext.disconnect();                       // the worker gets evicted
      resume = async () => {
        const back = await new FakeExtension(bridge.base).connect();
        await e.text('part two');             // delivery resumes on the same job
        await e.done();
        return back;
      };
    },
  }).connect();

  const pending = post({ stream: true, messages: [{ role: 'user', content: 'hi' }] });
  await waitFor(() => typeof resume === 'function');
  const back = await resume();

  const out = await readStream(await pending);
  assert.equal(out.content, 'part one part two');
  assert.equal(out.finish, 'stop');
  await back.disconnect();
});

test('config sets the default model and reports it', async () => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultModel: 'claude-sonnet-5@default' }),
  });
  await post({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(ext.chats.at(-1).modelId, 'claude-sonnet-5@default');
  const status = await (await fetch(`${bridge.base}/status`)).json();
  assert.equal(status.defaultModel, 'claude-sonnet-5@default');
  await ext.disconnect();
});

test('surfaces an upstream error inside the stream', async () => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => e.error('aipass returned 403 — 403 Forbidden'),
  }).connect();

  const out = await readStream(await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  assert.match(out.error.message, /403/);
  assert.ok(out.done, 'the stream must still terminate cleanly');
  await ext.disconnect();
});

test('passes an assistant id and field through to the create call', async (t) => {
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const made = await (await fetch(`${bridge.base}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi', assistant: 'asst_xyz' }),
  })).json();

  assert.match(made.id, /^[0-9a-f]{16}$/);
  assert.equal(ext.created.at(-1).assistant, 'asst_xyz');
  assert.equal(ext.created.at(-1).assistantField, 'aiAssistantId', 'default field name until a capture confirms it');
});

test('creates a conversation and adopts it', async (t) => {
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const made = await (await fetch(`${bridge.base}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'สวัสดี', model: 'gemini-3.1-flash-lite' }),
  })).json();

  assert.match(made.id, /^[0-9a-f]{16}$/);
  assert.equal(ext.created.length, 1);
  assert.equal(ext.created[0].message, 'สวัสดี');
  assert.equal(ext.created[0].modelId, 'gemini-3.1-flash-lite');
  // the server derives the id from the request id it was handed
  assert.equal(made.id, ext.created[0].requestId.replace(/-/g, '').slice(0, 16));

  const status = await (await fetch(`${bridge.base}/status`)).json();
  assert.equal(status.conversation, made.id, 'the new conversation becomes the current one');

  await post({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(ext.chats.at(-1).conversationId, made.id, 'chats go to the new conversation');
});

/* ------------------------------------------------------------- hardening */

import http from 'node:http';

// fetch() will not let us forge a Host header, so use the raw client.
function rawRequest(port, { path = '/status', method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: host ? { Host: host } : {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('rejects an unexpected Host header (DNS-rebinding guard)', async () => {
  const evil = await rawRequest(bridge.port, { host: 'attacker.example.com' });
  assert.equal(evil.status, 403, 'a foreign Host must be refused');
  assert.match(evil.body, /unexpected Host/);

  for (const host of [`127.0.0.1:${bridge.port}`, `localhost:${bridge.port}`]) {
    const ok = await rawRequest(bridge.port, { host });
    assert.equal(ok.status, 200, `${host} must be allowed`);
  }
});

test('sends no CORS header by default, so no web page can call the bridge', async () => {
  const res = await fetch(`${bridge.base}/status`);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-private-network'), null);

  const pre = await fetch(`${bridge.base}/v1/chat/completions`, { method: 'OPTIONS' });
  assert.equal(pre.headers.get('access-control-allow-origin'), null, 'preflight must not grant an origin');
});

test('sends CORS only when AIPASS_CORS_ORIGIN is set', async (t) => {
  const cors = await startBridge({ AIPASS_CORS_ORIGIN: 'https://example.com' });
  t.after(() => cors.stop());
  const res = await fetch(`${cors.base}/status`);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.com');
});

test('admin routes are off unless AIPASS_ADMIN=1', async () => {
  for (const [path, method] of [['/logs', 'GET'], ['/tab/reload', 'POST'], ['/browser/restart', 'POST'], ['/restart', 'POST']]) {
    const res = await fetch(`${bridge.base}${path}`, { method });
    assert.equal(res.status, 404, `${path} must not exist without AIPASS_ADMIN`);
  }
});

test('with AIPASS_ADMIN=1 the admin routes work and /logs refuses a traversal name', async (t) => {
  const admin = await startBridge({ AIPASS_ADMIN: '1' });
  t.after(() => admin.stop());

  const ok = await fetch(`${admin.base}/tab/reload`, { method: 'POST' });
  assert.equal(ok.status, 200, 'admin route should be reachable');

  for (const bad of ['../../etc/passwd', 'a/b', '..', 'x.y']) {
    const res = await fetch(`${admin.base}/logs?file=${encodeURIComponent(bad)}`);
    const body = await res.json();
    assert.equal(res.status, 400, `"${bad}" must be rejected`);
    assert.match(body.error, /invalid log name/);
  }
});

test('an image URL pointing at a private address is dropped, not fetched', async (t) => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await post({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'http://127.0.0.1:1/secret.png' } },
        { type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data' } },
      ],
    }],
  });

  const job = ext.chats.at(-1);
  const images = (job.parts ?? []).filter((p) => p.type === 'image');
  assert.equal(images.length, 0, 'private-network images must never reach the extension');
  assert.match(job.text, /describe this/, 'the text part still goes through');
});
