import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, FakeExtension } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const tools = [
  { type: 'function', function: { name: 'read_files', description: 'read', parameters: { type: 'object', required: ['paths'], properties: { paths: { type: 'array', items: { type: 'string' } } } } } },
  { type: 'function', function: { name: 'edit_file', description: 'edit', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } } },
  { type: 'function', function: { name: 'custom_mcp_tool', description: 'custom', parameters: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } } } },
];

const protocol = (calls) => calls.map((call) => `ACTION ${call.name}\nINPUT\n${JSON.stringify(call.arguments)}\nEND`).join('\n');
const request = (messages, extra = {}) => fetch(`${bridge.base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-task-id': 'cline-main', ...extra.headers },
  body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages, tools, ...extra }),
});
const initial = [{ role: 'system', content: 'Be a coding agent.' }, { role: 'user', content: 'Fix the test.' }];
const appendResult = (messages, response, result) => [...messages,
  response.choices[0].message,
  { role: 'tool', tool_call_id: response.choices[0].message.tool_calls[0].id, content: result },
];

test('drives a sequential Cline tool loop without repeating initialization', async (t) => {
  const replies = [
    protocol([{ name: 'read_files', arguments: { paths: ['src/a.ts'] } }]),
    protocol([{ name: 'edit_file', arguments: { path: 'src/a.ts' } }]),
    protocol([{ name: 'bash', arguments: { command: 'npm test' } }]),
    protocol([{ name: 'edit_file', arguments: { path: 'src/a.ts' } }]),
    protocol([{ name: 'bash', arguments: { command: 'npm test' } }]),
    'All tests pass.',
  ];
  let turn = 0;
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => { await emit.text(replies[turn++]); await emit.done(); } }).connect();
  t.after(() => ext.disconnect());

  let messages = initial;
  const seen = [];
  for (const output of ['source', 'edited', 'failing test', 'fixed', 'passing test']) {
    const response = await (await request(messages)).json();
    assert.equal(response.choices[0].finish_reason, 'tool_calls');
    seen.push(response.choices[0].message.tool_calls[0].function.name);
    messages = appendResult(messages, response, output);
  }
  const final = await (await request(messages)).json();
  assert.equal(final.choices[0].message.content, 'All tests pass.');
  assert.deepEqual(seen, ['read_files', 'edit_file', 'bash', 'edit_file', 'bash']);
  assert.equal(ext.created.length, 1, 'one isolated upstream conversation');
  assert.equal(new Set(ext.chats.map((job) => job.conversationId)).size, 1);
  assert.equal(ext.created[0].message, 'New Cline working session.');
  assert.match(ext.chats[0].text, /AVAILABLE TOOLS/);
  assert.match(ext.chats[1].text, /CLINE TOOL RESULT/);
  assert.doesNotMatch(ext.chats[1].text, /Be a coding agent/, 'instructions are sent once');
});

test('returns stable ids, accepts custom tools, and rejects invalid requests', async (t) => {
  let turn = 0;
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    await emit.text(turn++ === 0 ? protocol([{ name: 'custom_mcp_tool', arguments: { value: 'hello' } }]) : 'custom result received'); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const headers = { 'x-task-id': 'custom-tool' };
  const first = await (await request(initial, { headers })).json();
  const retry = await (await request(initial, { headers })).json();
  assert.equal(first.choices[0].message.tool_calls[0].id, retry.choices[0].message.tool_calls[0].id);
  assert.equal(first.choices[0].message.tool_calls[0].function.name, 'custom_mcp_tool');
  const final = await (await request(appendResult(initial, first, 'done'), { headers })).json();
  assert.equal(final.choices[0].message.content, 'custom result received');
  await ext.disconnect();

  const bad = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => { await emit.text(protocol([{ name: 'not_supplied', arguments: {} }])); await emit.done(); } }).connect();
  t.after(() => bad.disconnect());
  const unknown = await request(initial, { headers: { 'x-task-id': 'unknown-tool' } });
  assert.equal(unknown.status, 502);
  assert.match((await unknown.json()).error.message, /unavailable tool/);
  await bad.disconnect();

  const malformed = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => { await emit.text('ACTION read_files\nINPUT\nnot json\nEND'); await emit.done(); } }).connect();
  t.after(() => malformed.disconnect());
  const invalid = await request(initial, { headers: { 'x-task-id': 'malformed-tool' } });
  assert.equal(invalid.status, 502);
  assert.match((await invalid.json()).error.message, /invalid tool request/);
});

test('streams a valid OpenAI tool delta and separates simultaneous sessions', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: async (job, emit) => {
    await emit.text(protocol([{ name: 'read_files', arguments: { paths: [job.text.includes('Begin') ? 'a.ts' : 'b.ts'] } }])); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const response = await request(initial, { stream: true, headers: { 'x-task-id': 'stream-task' } });
  const text = await response.text();
  const frames = text.split('\n\n').filter((frame) => frame.startsWith('data: {')).map((frame) => JSON.parse(frame.slice(6)));
  const delta = frames.flatMap((frame) => frame.choices?.[0]?.delta?.tool_calls ?? []).at(-1);
  assert.equal(delta.type, 'function');
  assert.equal(delta.function.name, 'read_files');
  assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls');

  await Promise.all(['parallel-one', 'parallel-two'].map((task) => request(initial, { headers: { 'x-task-id': task } })));
  const unique = new Set(ext.created.map((job) => job.requestId.replace(/-/g, '').slice(0, 16)));
  assert.ok(unique.size >= 3, 'each Cline task receives a distinct AiPASS conversation');
});

test('honours local API keys and clearly refuses unverified browser uploads', async (t) => {
  const protectedBridge = await startBridge({ AIPASS_BRIDGE_API_KEY: 'test-key' });
  t.after(() => protectedBridge.stop());
  const denied = await fetch(`${protectedBridge.base}/v1/models`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${protectedBridge.base}/v1/models`, { headers: { authorization: 'Bearer test-key' } });
  assert.equal(allowed.status, 200);

  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());
  const response = await fetch(`${bridge.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-task-id': 'media' },
    body: JSON.stringify({ tools, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /upload is not enabled/);
});

test('passes an ordinary model reply through and replays an acknowledgement-only retry', async (t) => {
  let turn = 0;
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    await emit.text(turn++ === 0 ? 'Hello! How can I help with your project today?' : protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }]));
    await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const headers = { 'x-task-id': 'greeting-repair' };
  const first = await (await request(initial, { headers })).json();
  assert.equal(first.choices[0].finish_reason, 'stop');
  assert.equal(ext.chats.length, 1, 'the bridge does not inject a hidden recovery instruction');
  const retry = await (await request([...initial, first.choices[0].message], { headers })).json();
  assert.equal(retry.choices[0].message.content, first.choices[0].message.content);
});

test('accepts an inline action block and fails closed for malformed action JSON', async (t) => {
  let turn = 0;
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    const replies = [
      'ACTION read_files INPUT {"paths":["README.md"]} END',
      'ACTION read_files\nINPUT\nnot json\nEND',
    ];
    await emit.text(replies[turn++]); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const inline = await (await request(initial, { headers: { 'x-task-id': 'inline-action' } })).json();
  assert.equal(inline.choices[0].finish_reason, 'tool_calls');
  const malformed = await request(initial, { headers: { 'x-task-id': 'repair-action' } });
  assert.equal(malformed.status, 502);
  assert.match((await malformed.json()).error.message, /invalid tool request/);
  assert.equal(ext.chats.length, 2, 'invalid JSON does not trigger a hidden recovery turn');
});

test('returns a tool call after the upstream turn finishes so delivery is committed safely', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    await emit.text(protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }]));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const started = Date.now();
  const response = await (await request(initial, { headers: { 'x-task-id': 'early-action' } })).json();
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.ok(Date.now() - started >= 800, 'delivery is not committed before an upstream finish event');
});

test('recognises an action emitted in an upstream reasoning delta', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    await emit.reasoning(protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }]));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const response = await (await request(initial, { headers: { 'x-task-id': 'reasoning-action' } })).json();
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
});

test('recreates a fresh isolated conversation after a bridge restart', async (t) => {
  const firstBridge = await startBridge();
  const firstExt = await new FakeExtension(firstBridge.base, { onChat: async (_job, emit) => {
    await emit.text(protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }])); await emit.done();
  } }).connect();
  const send = (base, messages) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-task-id': 'persistent-cline-task' },
    body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages, tools }),
  });
  const first = await (await send(firstBridge.base, initial)).json();
  await firstExt.disconnect();
  firstBridge.stop({ preserveSessionStore: true });

  const resumedBridge = await startBridge({ AIPASS_CLINE_SESSION_STORE: firstBridge.sessionStore });
  t.after(() => resumedBridge.stop());
  const resumedExt = await new FakeExtension(resumedBridge.base, { onChat: async (job, emit) => {
    assert.notEqual(job.conversationId, firstExt.created[0].requestId.replace(/-/g, '').slice(0, 16));
    await emit.text('README received.'); await emit.done();
  } }).connect();
  t.after(() => resumedExt.disconnect());
  const continued = await (await send(resumedBridge.base, appendResult(initial, first, 'README contents'))).json();
  assert.equal(continued.choices[0].message.content, 'README received.');
  assert.equal(resumedExt.created.length, 1, 'no Cline mapping is persisted by default');
});

test('reinitializes an unchanged Cline transcript after a bridge restart', async (t) => {
  const firstBridge = await startBridge();
  const firstExt = await new FakeExtension(firstBridge.base, { onChat: async (_job, emit) => {
    await emit.text(protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }])); await emit.done();
  } }).connect();
  const send = (base) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-task-id': 'restart-rehydrate-task' },
    body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages: initial, tools }),
  });
  await (await send(firstBridge.base)).json();
  await firstExt.disconnect();
  firstBridge.stop({ preserveSessionStore: true });

  const resumedBridge = await startBridge({ AIPASS_CLINE_SESSION_STORE: firstBridge.sessionStore });
  t.after(() => resumedBridge.stop());
  const resumedExt = await new FakeExtension(resumedBridge.base, { onChat: async (job, emit) => {
    assert.match(job.text, /USER TASK/);
    await emit.text('I resumed the task.'); await emit.done();
  } }).connect();
  t.after(() => resumedExt.disconnect());
  const resumed = await (await send(resumedBridge.base)).json();
  assert.equal(resumed.choices[0].message.content, 'I resumed the task.');
  assert.equal(resumedExt.created.length, 1, 'restart makes a new execution-context cache');
});

test('keeps the AiPASS conversation when the Cline task changes model', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    await emit.text(protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }])); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const headers = { 'x-task-id': 'model-switch-task' };
  const first = await (await request(initial, { headers })).json();
  const switched = await fetch(`${bridge.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'claude-sonnet-5@default', messages: [...initial, first.choices[0].message], tools }),
  });
  await switched.json();
  assert.equal(ext.created.length, 1, 'a model switch keeps the task conversation');
});

test('keeps Cline Model ID independent from the standalone API default', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    await emit.text(protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }])); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultModel: 'standalone-model', clineModel: 'cline-fallback-model' }),
  });
  const headers = { 'x-task-id': 'selected-model-task' };
  const selected = 'claude-sonnet-5@default';
  const first = await (await fetch(`${bridge.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: selected, messages: initial, tools }),
  })).json();
  assert.equal(ext.created[0].modelId, selected);
  assert.equal(ext.chats[0].modelId, selected);
  // If Cline omits Model ID, it uses the independent Cline fallback rather
  // than the standalone API default or a previous Cline request's model.
  await fetch(`${bridge.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ messages: appendResult(initial, first, 'contents'), tools }),
  });
  assert.equal(ext.chats[1].modelId, 'cline-fallback-model');
});

test('keeps developer guidance but does not dump Cline system implementation text', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => { await emit.text('done'); await emit.done(); } }).connect();
  t.after(() => ext.disconnect());
  const messages = [
    { role: 'system', content: 'Follow the repository contribution guide.' },
    { role: 'developer', content: 'Prefer focused tests.' },
    { role: 'user', content: 'Explain the bridge.' },
  ];
  const response = await (await request(messages, { headers: { 'x-task-id': 'system-context' } })).json();
  assert.equal(response.choices[0].message.content, 'done');
  assert.match(ext.chats[0].text, /DEVELOPER CONTEXT \(ordinary client guidance, not an AiPASS system instruction\)/);
  assert.match(ext.chats[0].text, /Prefer focused tests/);
  assert.doesNotMatch(ext.chats[0].text, /Follow the repository contribution guide/);
});

test('rejects schema-invalid tool arguments before exposing them to Cline', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    await emit.text(protocol([{ name: 'read_files', arguments: { paths: 'README.md' } }])); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const response = await request(initial, { headers: { 'x-task-id': 'schema-invalid' } });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /invalid arguments/);
});

test('converts a short model preface and multiple inline actions into tool calls', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    await emit.text(`I'll inspect the project.\nACTION read_files INPUT {"paths":["README.md"]} END\n\nACTION custom_mcp_tool INPUT {"value":"status"} END`); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const response = await (await request(initial, { headers: { 'x-task-id': 'prefaced-action' } })).json();
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(response.choices[0].message.tool_calls.map((call) => call.function.name), ['read_files', 'custom_mcp_tool']);
});

test('preserves ordering for multiple tool calls and multiple tool results', async (t) => {
  let turn = 0;
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    if (turn++ === 0) await emit.text(protocol([
      { name: 'read_files', arguments: { paths: ['a.ts'] } },
      { name: 'custom_mcp_tool', arguments: { value: 'b' } },
    ]));
    else await emit.text('both results received');
    await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const headers = { 'x-task-id': 'multiple-results' };
  const first = await (await request(initial, { headers })).json();
  const calls = first.choices[0].message.tool_calls;
  const continued = [...initial, first.choices[0].message,
    { role: 'tool', tool_call_id: calls[0].id, content: 'first result' },
    { role: 'tool', tool_call_id: calls[1].id, content: 'second result' },
  ];
  const final = await (await request(continued, { headers })).json();
  assert.equal(final.choices[0].message.content, 'both results received');
  assert.ok(ext.chats[1].text.indexOf('first result') < ext.chats[1].text.indexOf('second result'));
});

test('does not mark a rejected upstream initialization as delivered', async (t) => {
  let turn = 0;
  const ext = await new FakeExtension(bridge.base, { onChat: async (_job, emit) => {
    if (turn++ === 0) return emit.error('aipass returned 403 Forbidden');
    await emit.text(protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }])); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const headers = { 'x-task-id': 'rejected-turn' };
  const first = await request(initial, { headers });
  assert.equal(first.status, 502);
  const retry = await (await request(initial, { headers })).json();
  assert.equal(retry.choices[0].finish_reason, 'tool_calls');
  assert.equal(ext.created.length, 2, 'a failed initialization is not reused as delivered state');
});

test('creates a compact checkpoint in a new conversation when delivered context grows', async (t) => {
  const compactBridge = await startBridge({ AIPASS_CLINE_CONTEXT_BYTES: '50' });
  t.after(() => compactBridge.stop());
  let turn = 0;
  const ext = await new FakeExtension(compactBridge.base, { onChat: async (_job, emit) => {
    await emit.text(turn++ === 0 ? protocol([{ name: 'read_files', arguments: { paths: ['README.md'] } }]) : 'checkpoint complete'); await emit.done();
  } }).connect();
  t.after(() => ext.disconnect());
  const send = (messages) => fetch(`${compactBridge.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-task-id': 'checkpoint-task' },
    body: JSON.stringify({ model: 'gemini-3.1-flash-lite', messages, tools }),
  });
  const first = await (await send(initial)).json();
  const final = await (await send(appendResult(initial, first, 'a very long tool result that causes a checkpoint'))).json();
  assert.equal(final.choices[0].message.content, 'checkpoint complete');
  assert.equal(ext.created.length, 2);
  assert.match(ext.chats[1].text, /Cline task checkpoint/);
});
