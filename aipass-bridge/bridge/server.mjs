// Local bridge to de.aipass.net's chat.
//
// The bridge never sees a session cookie. It hands work to the Chrome
// extension over SSE; the extension performs the real request from inside a
// de.aipass.net page, where the browser attaches credentials itself.
//
// Scope is deliberately narrow: send the user's message, stream the reply
// back. The server owns the conversation and its history, exactly as it does
// for the web UI, so there is nothing to reconstruct on this side.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ClineSessions, commitDelivery, createCheckpoint, initialContext, needsCheckpoint, planSemantics } from './cline-session.mjs';
import { digest, normaliseMessages, textContent, toolsFromRequest } from './openai-messages.mjs';
import { unsupportedUploadMessage } from './attachments.mjs';
import { parseToolProtocol, validateCalls } from './tool-protocol.mjs';

const PORT = Number(process.env.AIPASS_PORT ?? 8787);
const HOST = process.env.AIPASS_HOST ?? '127.0.0.1';
const MODELS_FALLBACK = (process.env.AIPASS_MODELS ?? 'gemini-3.1-flash-lite,claude-sonnet-5@default')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Where upstream tool activity (web_search progress, sources) goes:
// 'reasoning' -> delta.reasoning_content, 'text' -> inline, 'off' -> dropped.
const TOOL_VISIBILITY = process.env.AIPASS_TOOL_VISIBILITY ?? 'reasoning';
const PINNED_CONVERSATION = process.env.AIPASS_CONVERSATION_ID ?? '';
const IDLE_TIMEOUT_MS = Number(process.env.AIPASS_IDLE_TIMEOUT_MS ?? 180_000);
const MAX_BODY = 8 * 1024 * 1024;
const BRIDGE_API_KEY = process.env.AIPASS_BRIDGE_API_KEY ?? '';
const DEBUG = process.env.AIPASS_DEBUG === '1';
const LOG_LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const requestedLogLevel = String(process.env.AIPASS_LOG_LEVEL ?? (DEBUG ? 'DEBUG' : 'INFO')).toUpperCase();
const LOG_LEVEL = Object.hasOwn(LOG_LEVELS, requestedLogLevel) ? requestedLogLevel : 'INFO';
const LOG_COLOURS = { DEBUG: '\x1b[90m', INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', reset: '\x1b[0m' };
const COLOUR_LOGS = process.stdout.isTTY && !process.env.NO_COLOR;

let defaultModel = process.env.AIPASS_MODEL ?? 'gemini-3.1-flash-lite';
// This is deliberately separate from the extension popup's standalone API
// default. Cline normally supplies its own Model ID; this is only its fallback
// when that client leaves model out of a request.
let clineDefaultModel = process.env.AIPASS_CLINE_MODEL ?? defaultModel;
// Binding a custom assistant needs a first-party UI capture. Never guess a
// form field: basic operation works without it, and an attempted binding fails
// clearly until the site-specific field is explicitly configured.
let assistantId = process.env.AIPASS_ASSISTANT_ID ?? '';
const ASSISTANT_FIELD = process.env.AIPASS_ASSISTANT_FIELD ?? '';

const shortId = (value) => String(value ?? '-').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || '-';
function writeLog(level, scope, message) {
  if (LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return;
  const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const label = level.padEnd(5);
  const renderedLevel = COLOUR_LOGS ? `${LOG_COLOURS[level]}${label}${LOG_COLOURS.reset}` : label;
  // Keep one event per line so logs stay useful in terminals and log collectors.
  const safeMessage = String(message ?? '').replace(/[\r\n]+/g, ' ').trim();
  console.log(`${timestamp} ${renderedLevel} ${scope.padEnd(16)} ${safeMessage}`);
}
const debug = (scope, message) => writeLog('DEBUG', scope, message);
const info = (scope, message) => writeLog('INFO', scope, message);
const warn = (scope, message) => writeLog('WARN', scope, message);
const error = (scope, message) => writeLog('ERROR', scope, message);
const clineLog = (session, event, detail = '') => info(`cline/${shortId(session?.id)}`, `${event}${detail ? ` · ${detail}` : ''}`);
const clineSessions = new ClineSessions();

/* ------------------------------------------------- react-router turbo-stream */

// The app's .data loaders return a flat pool of values where objects address
// their keys and values by index.
function decodeTurboStream(text) {
  const flat = JSON.parse(text);
  const seen = new Map();
  const resolve = (ref) => {
    if (typeof ref !== 'number') return ref;
    if (ref < 0) return null; // undefined / null sentinels
    if (seen.has(ref)) return seen.get(ref);
    const v = flat[ref];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(ref, out);
      for (const e of v) out.push(resolve(e));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      seen.set(ref, out);
      for (const [k, valueRef] of Object.entries(v)) out[resolve(Number(k.slice(1)))] = resolve(valueRef);
      return out;
    }
    seen.set(ref, v);
    return v;
  };
  return resolve(0);
}

const LOADERS = {
  models: '/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models',
  conversations: '/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions',
};

// list-models carries no field separating chat models from image/video/audio
// generators, so exclude those by id. AIPASS_MODEL_FILTER=all keeps them.
const MEDIA_ID = /(seedream|seedance|veo-|lyria|gpt-image|-image$|image-preview)/i;
const MODEL_FILTER = process.env.AIPASS_MODEL_FILTER ?? 'chat';

function extractModels(decoded) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const id = v.id ?? v.modelId;
    if (typeof id === 'string' && id && !out.some((m) => m.id === id)) {
      out.push({
        id,
        name: v.displayName ?? v.name ?? id,
        provider: v.providerName ?? v.provider ?? null,
        free: v.isFreeCredit === true,
        ready: v.ready !== false,
        thinking: Array.isArray(v.thinkingConfig?.supportedLevels) ? v.thinkingConfig.supportedLevels : null,
        media: MEDIA_ID.test(id),
      });
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  return MODEL_FILTER === 'all' ? out : out.filter((m) => !m.media && m.ready);
}

/* ---------------------------------------------------------------- job hub */

const jobs = new Map();
const extClients = new Set();
let rr = 0;

const pickClient = () => {
  const list = [...extClients];
  return list.length ? list[rr++ % list.length] : null;
};

const sendToClient = (client, event, data) =>
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

class Job {
  constructor({ kind = 'chat', modelId, text, conversationId, url, message, requestId, assistant, assistantField, timeoutMs, onDelta, onDone, onError }) {
    this.id = randomUUID();
    this.kind = kind;
    this.url = url;
    this.message = message;
    this.requestId = requestId;
    this.assistant = assistant;
    this.assistantField = assistantField;
    this.timeoutMs = timeoutMs ?? IDLE_TIMEOUT_MS;
    this.modelId = modelId;
    this.text = text;
    this.conversationId = conversationId;
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onError = onError;
    this.settled = false;
    this.touch();
    jobs.set(this.id, this);
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('timed out waiting for the extension'), this.timeoutMs);
  }
  dispatch() {
    const client = pickClient();
    if (!client) return this.fail('no extension connected — open a de.aipass.net tab and check the popup');
    this.client = client;
    debug(`upstream/${shortId(this.id)}`, `dispatch · kind=${this.kind}${this.modelId ? ` model=${this.modelId}` : ''}${this.conversationId ? ` conversation=${shortId(this.conversationId)}` : ''}`);
    sendToClient(client, 'job', this.kind === 'loader'
      ? { jobId: this.id, kind: 'loader', url: this.url }
      : this.kind === 'create'
      ? { jobId: this.id, kind: 'create', modelId: this.modelId, message: this.message, requestId: this.requestId, assistant: this.assistant, assistantField: this.assistantField }
      : { jobId: this.id, kind: 'chat', conversationId: this.conversationId, modelId: this.modelId, text: this.text });
  }
  delta(part) { if (!this.settled) { this.touch(); this.onDelta(part); } }
  done(value) { if (this.settled) return; debug(`upstream/${shortId(this.id)}`, `done · ${value ?? 'stop'}`); this.cleanup(); this.onDone(value ?? 'stop'); }
  fail(message) { if (this.settled) return; error(`upstream/${shortId(this.id)}`, String(message).slice(0, 160)); this.cleanup(); this.onError(message); }
  abort() {
    if (this.settled) return;
    if (this.client) sendToClient(this.client, 'abort', { jobId: this.id });
    this.cleanup();
  }
  cleanup() { this.settled = true; clearTimeout(this.timer); jobs.delete(this.id); }
}

const fetchLoader = (url, timeoutMs = 20_000) =>
  new Promise((resolve, reject) => {
    const job = new Job({ kind: 'loader', url, timeoutMs, onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)) });
    job.dispatch();
  });

/* ------------------------------------------------------------------ models */

let modelCache = { at: 0, models: [] };
let modelRefresh = null;
const MODEL_TTL_MS = 60_000;

const cachedModels = () =>
  modelCache.models.length
    ? modelCache.models
    : MODELS_FALLBACK.map((id) => ({ id, name: id, provider: null, free: false, ready: true, thinking: null }));

async function listModels({ force = false } = {}) {
  if (!force && modelCache.models.length && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.models;
  if (!extClients.size) return cachedModels();
  if (modelRefresh) return modelRefresh; // several callers can race; only one should hit the API
  modelRefresh = (async () => {
    try {
      const models = extractModels(decodeTurboStream(await fetchLoader(LOADERS.models)));
      if (models.length) {
        modelCache = { at: Date.now(), models };
        const free = models.filter((m) => m.free).map((m) => m.id);
        info('models', `refresh complete · count=${models.length}${free.length ? ` free=${free.join(', ')}` : ''}`);
      }
    } catch (err) {
      warn('models', `refresh failed · ${String(err?.message ?? err).slice(0, 160)}`);
    } finally {
      modelRefresh = null;
    }
    return cachedModels();
  })();
  return modelRefresh;
}

/* ----------------------------------------------------------- conversations */

// Conversations are created by the server; posting to an invented id is
// rejected. Reuse the most recent, and move on if one stops accepting messages.
let conversationCache = null;
let conversationList = [];
let conversationIndex = 0;

async function loadConversations() {
  if (!extClients.size) throw new Error('no extension connected — cannot look up a conversation');
  const decoded = decodeTurboStream(await fetchLoader(LOADERS.conversations));
  const list = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string' && typeof v.updatedAt === 'string') list.push(v);
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  conversationList = list;
  return list;
}

function findValue(node, key) {
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findValue(v, key); if (hit != null) return hit; }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (typeof node[key] === 'string') return node[key];
  for (const v of Object.values(node)) { const hit = findValue(v, key); if (hit != null) return hit; }
  return null;
}

// The chat page creates a conversation by posting its first message to
// /chat.data; the server derives the id from clientCreateRequestId.
async function createConversation({ modelId = defaultModel, message = 'Hello', assistant, adopt = true } = {}) {
  if (assistant && !ASSISTANT_FIELD) throw new Error('custom assistant binding is unavailable: set AIPASS_ASSISTANT_FIELD only after verifying the AiPASS Web new-chat form field');
  const requestId = randomUUID();
  const raw = await new Promise((resolve, reject) => {
    const job = new Job({
      kind: 'create', modelId, message, requestId,
      assistant: assistant ?? assistantId, assistantField: ASSISTANT_FIELD,
      timeoutMs: 30_000,
      onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
    });
    job.dispatch();
  });
  const id = findValue(decodeTurboStream(raw), 'conversationId');
  if (!id) throw new Error(`could not read a conversation id from the response: ${raw.slice(0, 200)}`);
  if (adopt) {
    conversationCache = id;
    conversationIndex = 0;
    conversationList = [];
  }
  info('conversation', `created · id=${shortId(id)} model=${modelId}`);
  return id;
}

async function resolveConversation() {
  if (PINNED_CONVERSATION) return PINNED_CONVERSATION;
  if (conversationCache) return conversationCache;
  if (!conversationList.length) await loadConversations();
  const pick = conversationList[conversationIndex];
  if (!pick) {
    throw new Error('no usable conversation — open https://de.aipass.net/chat, start one, then POST /config {"conversation":null}');
  }
  conversationCache = pick.id;
  info('conversation', `selected · id=${shortId(conversationCache)} title=${String(pick.title ?? 'untitled').slice(0, 80)}`);
  return conversationCache;
}

/* --------------------------------------------------------------- chat flow */

// A 404 means the conversation was deleted; a 409 means the server still
// believes a generation is running there. Neither recovers on its own.
function startChat({ modelId, text, conversationId: suppliedConversationId, onDelta, onDone, onError }) {
  let attempts = 0;
  let delivered = 0;
  let current = null;

  const attempt = async () => {
    attempts++;
    let conversationId = suppliedConversationId;
    try { conversationId ??= await resolveConversation(); }
    catch (err) { return onError(err.message); }

    current = new Job({
      modelId, text, conversationId,
      onDelta: (part) => { delivered++; onDelta(part); },
      onDone,
      onError: (message) => {
        const rejected = /conversation not found|returned 404|returned 409/i.test(message);
        if (rejected && attempts <= 3 && delivered === 0 && !suppliedConversationId && !PINNED_CONVERSATION) {
          warn('conversation', `rejected · id=${shortId(conversationId)}; trying next`);
          conversationIndex++;
          conversationCache = null;
          attempt();
          return;
        }
        onError(message);
      },
    });
    current.dispatch();
  };

  attempt();
  return { abort: () => current?.abort() };
}

// Only the newest user message is sent. The server holds the history, and a
// messages array containing an assistant turn is rejected upstream.
function lastUserText(messages) {
  const texts = (messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => textContent(m.content, 'user message content'));
  return texts.at(-1)?.trim() ?? '';
}

/* ------------------------------------------------------------ http plumbing */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const oaiError = (res, status, message, type = 'invalid_request_error') =>
  json(res, status, { error: { message, type } });

function authorized(req) {
  if (!BRIDGE_API_KEY) return true;
  const value = req.headers.authorization;
  return typeof value === 'string' && value === `Bearer ${BRIDGE_API_KEY}`;
}

/* ---------------------------------------------------------- chat completions */

async function plainChatCompletions(req, res, payload) {
  const hasRequestedModel = typeof payload.model === 'string' && payload.model.trim();
  const model = String(hasRequestedModel ? payload.model : defaultModel).replace(/^aipass\//, '');
  const text = lastUserText(payload.messages);
  if (!text) return oaiError(res, 400, 'no user message');

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  info('chat', `model selected · value=${model} source=${hasRequestedModel ? 'request' : 'standalone-default'}`);
  info('chat', `request · input=${Buffer.byteLength(text)}B stream=${Boolean(payload.stream)}`);

  if (payload.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    const emit = (delta, finish = null) => {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    emit({ role: 'assistant', content: '' });

    const job = startChat({
      modelId: model, text,
      onDelta: (part) => {
        if (part.kind === 'status') {
          if (TOOL_VISIBILITY === 'off') return;
          if (TOOL_VISIBILITY === 'text') emit({ content: `\n${part.text}\n` });
          else emit({ reasoning_content: `${part.text}\n` });
          return;
        }
        if (part.kind === 'reasoning') emit({ reasoning_content: part.text });
        else emit({ content: part.text });
      },
      onDone: (finishReason) => {
        emit({}, finishReason === 'length' ? 'length' : 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
      },
      onError: (message) => {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });
    res.on('close', () => job.abort());
    return;
  }

  let out = '';
  let reasoning = '';
  await new Promise((resolve) => {
    const job = startChat({
      modelId: model, text,
      onDelta: (p) => {
        if (p.kind === 'status') { if (TOOL_VISIBILITY !== 'off') reasoning += `${p.text}\n`; return; }
        if (p.kind === 'reasoning') reasoning += p.text;
        else out += p.text;
      },
      onDone: (finishReason) => {
        json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: out, ...(reasoning ? { reasoning_content: reasoning } : {}) },
            finish_reason: finishReason === 'length' ? 'length' : 'stop',
          }],
          // Estimates: the upstream stream reports no token counts, but some
          // clients refuse a response without a usage block.
          usage: {
            prompt_tokens: Math.ceil(text.length / 4),
            completion_tokens: Math.ceil(out.length / 4),
            total_tokens: Math.ceil((text.length + out.length) / 4),
          },
        });
        resolve();
      },
      onError: (message) => { oaiError(res, 502, message, 'upstream_error'); resolve(); },
    });
    res.on('close', () => { job.abort(); resolve(); });
  });
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
    'x-accel-buffering': 'no', 'access-control-allow-origin': '*',
  });
}

function streamChunk(res, id, created, model, delta, finish = null) {
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

function toolCallId(session, requestSignature, index) {
  return `call_${digest([session.id, requestSignature, index]).slice(0, 24)}`;
}

function responseForCalls({ id, created, model, session, requestSignature, calls }) {
  const toolCalls = calls.map((call, index) => {
    const callId = toolCallId(session, requestSignature, index);
    session.calls.set(callId, { name: call.name, arguments: call.arguments });
    session.pendingToolCallIds.add(callId);
    return { id: callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
  });
  return { id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

function cacheKey(payload) {
  // The full OpenAI transcript is safe to use as an idempotency key, unlike as
  // a session identifier. It makes retries return the same tool-call ids.
  return digest({ messages: payload.messages, tools: payload.tools, tool_choice: payload.tool_choice, model: payload.model });
}

function sendCachedClineResponse(res, response, model, stream) {
  if (!stream) return json(res, 200, response);
  sseHeaders(res);
  streamChunk(res, response.id, response.created, model, { role: 'assistant' });
  if (response.choices[0].finish_reason === 'tool_calls') {
    const calls = response.choices[0].message.tool_calls;
    streamChunk(res, response.id, response.created, model, { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: call.function })) });
  } else if (response.choices[0].message.content) streamChunk(res, response.id, response.created, model, { content: response.choices[0].message.content });
  streamChunk(res, response.id, response.created, model, {}, response.choices[0].finish_reason);
  return res.end('data: [DONE]\n\n');
}

async function clineChatCompletions(req, res, payload) {
  const requestedModel = typeof payload.model === 'string' && payload.model.trim()
    ? payload.model.trim().replace(/^aipass\//, '')
    : null;
  const messages = normaliseMessages(payload.messages);
  const attachments = messages.flatMap((message) => message.attachments ?? []);
  if (attachments.length) return oaiError(res, 400, unsupportedUploadMessage(attachments));
  const requestedTools = toolsFromRequest(payload.tools);
  let tools = requestedTools;
  if (payload.tool_choice === 'none') tools = [];
  else if (payload.tool_choice?.type === 'function') {
    const name = payload.tool_choice.function?.name;
    const selected = requestedTools.filter((tool) => tool.name === name);
    if (!selected.length) throw new Error(`tool_choice names an unavailable tool: ${name ?? 'unknown'}`);
    tools = selected;
  } else if (payload.tool_choice != null && !['auto', 'required'].includes(payload.tool_choice)) {
    throw new Error('unsupported tool_choice');
  }
  const session = clineSessions.get(req, payload, messages);
  // Cline's own Model ID remains independent from the standalone API default.
  // It wins when present; the separate Cline fallback is used otherwise.
  const modelSource = requestedModel ? 'cline-request' : 'cline-default';
  const model = requestedModel ?? clineDefaultModel;
  const previousModel = session.selectedModel;
  session.selectedModel = model;
  if (previousModel && previousModel !== model) clineLog(session, 'model changed', `${previousModel} → ${model} source=${modelSource}`);
  else clineLog(session, 'model selected', `value=${model} source=${modelSource}`);
  clineLog(session, 'request', `actions=${tools.length} stream=${Boolean(payload.stream)} state=${session.initialized ? 'continue' : 'new'} key=${session.source}`);
  const requestSignature = cacheKey(payload);
  const cached = session.responseCache.get(requestSignature);
  if (cached) {
    clineLog(session, 'replay', 'cached response');
    return sendCachedClineResponse(res, cached, model, payload.stream);
  }

  let upstreamText;
  let targetConversationId = session.conversationId;
  let delivery;
  try {
    if (!session.initialized) {
      const setup = initialContext(messages, tools);
      // AiPASS's creation route allocates the conversation but does not
      // reliably make its `message` part of the model-visible history. The
      // first real send must therefore carry the entire task contract.
      targetConversationId = await createConversation({ modelId: model, message: 'New Cline working session.', adopt: false });
      upstreamText = setup;
      delivery = { type: 'initial', conversationId: targetConversationId, messages, toolSetHash: digest(tools), bytes: Buffer.byteLength(upstreamText) };
      clineLog(session, 'session-created', `conversation=${shortId(targetConversationId)} model=${model}`);
    } else {
      const plan = planSemantics(session, messages, tools);
      // Cline can resend an otherwise identical transcript after appending its
      // own assistant acknowledgement. Replay the last bridge response rather
      // than rejecting the harmless retry.
      if (!plan.additions.length && session.lastResponse) {
        clineLog(session, 'replay', 'acknowledgement-only retry');
        return sendCachedClineResponse(res, session.lastResponse, model, payload.stream);
      }
      if (!plan.additions.length) return oaiError(res, 400, 'no new Cline message or tool result for this session');
      upstreamText = `${plan.additions.join('\n\n')}\n\nContinue the task. Request another available tool if necessary; otherwise return the final answer.`;
      if (needsCheckpoint(session, Buffer.byteLength(upstreamText))) {
        const checkpoint = createCheckpoint(messages, tools);
        targetConversationId = await createConversation({ modelId: model, message: 'New Cline working session.', adopt: false });
        upstreamText = initialContext(messages, tools, { checkpoint });
        delivery = { type: 'checkpoint', conversationId: targetConversationId, messages, deliveryKeys: plan.deliveryKeys, toolSetHash: plan.toolSetHash, checkpoint, bytes: Buffer.byteLength(upstreamText) };
        clineLog(session, 'checkpoint', `conversation=${shortId(targetConversationId)} bytes=${Buffer.byteLength(upstreamText)}`);
      } else {
        delivery = { type: 'continue', deliveryKeys: plan.deliveryKeys, toolSetHash: plan.toolSetHash, bytes: Buffer.byteLength(upstreamText) };
        clineLog(session, 'continue', `updates=${plan.additions.length} conversation=${shortId(targetConversationId)}`);
      }
    }
  } catch (err) {
    return oaiError(res, 502, String(err?.message ?? err), 'upstream_error');
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffered = '';
  let rawText = '';
  let protocolCandidate = true;
  let emittedText = false;
  let reasoning = '';
  let currentJob;
  let holdInitialText = false;
  let responseSent = false;
  let sideActionBuffer = '';
  let deliveredCommitted = false;
  const commitDelivered = () => {
    if (deliveredCommitted) return;
    deliveredCommitted = true;
    if (delivery.type === 'initial' || delivery.type === 'checkpoint') {
      session.conversationId = delivery.conversationId;
      session.initialized = true;
    }
    commitDelivery(session, {
      messages: (delivery.type === 'initial' || delivery.type === 'checkpoint') ? delivery.messages : messages,
      deliveryKeys: delivery.deliveryKeys ?? [], toolSetHash: delivery.toolSetHash, bytes: delivery.bytes, checkpoint: delivery.checkpoint,
    });
  };
  const flushTextWhenSafe = () => {
    // Hold a small lead-in: several models write “I'll inspect …” immediately
    // before a valid ACTION block. This avoids leaking that prose as assistant
    // content before emitting OpenAI tool_calls. Long ordinary answers still
    // stream normally after the bounded look-ahead.
    const marker = 'ACTION';
    if (buffered.length <= 500 && !/\n\s*ACTION\s+/.test(buffered)) return;
    if (marker.startsWith(buffered) || buffered.startsWith(marker)) return;
    protocolCandidate = false;
    if (payload.stream && !holdInitialText && buffered) { streamChunk(res, id, created, model, { content: buffered }); emittedText = true; buffered = ''; }
  };
  const complete = (finishReason) => {
    if (responseSent) return;
    const restoredText = rawText;
    // Parse the whole model response at completion. This also catches a short
    // natural-language lead-in followed by a complete ACTION envelope.
    const parsed = parseToolProtocol(rawText);
    if (parsed.kind === 'invalid') {
      commitDelivered();
      const message = `AiPASS returned an invalid tool request: ${parsed.message}`;
      if (payload.stream) {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      return oaiError(res, 502, message, 'upstream_error');
    }
    if (parsed.kind === 'calls') {
      const checked = validateCalls(parsed.calls, tools);
      if (checked.error) {
        commitDelivered();
        if (payload.stream) {
          res.write(`data: ${JSON.stringify({ error: { message: checked.error, type: 'upstream_error' } })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        return oaiError(res, 502, checked.error, 'upstream_error');
      }
      const response = responseForCalls({ id, created, model, session, requestSignature, calls: checked.calls });
      commitDelivered();
      responseSent = true;
      session.responseCache.set(requestSignature, response);
      session.lastResponse = response;
      clineLog(session, 'action-ready', checked.calls.map((call) => call.name).join(','));
      if (!payload.stream) return json(res, 200, response);
      if (!res.headersSent) sseHeaders(res);
      streamChunk(res, id, created, model, { role: 'assistant' });
      streamChunk(res, id, created, model, { tool_calls: response.choices[0].message.tool_calls.map((call, index) => ({ index, id: call.id, type: call.type, function: call.function })) });
      streamChunk(res, id, created, model, {}, 'tool_calls');
      return res.end('data: [DONE]\n\n');
    }
    const text = restoredText || '';
    commitDelivered();
    responseSent = true;
    const response = { id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finishReason === 'length' ? 'length' : 'stop' }],
      usage: { prompt_tokens: Math.ceil(upstreamText.length / 4), completion_tokens: Math.ceil((text + reasoning).length / 4), total_tokens: Math.ceil((upstreamText.length + text + reasoning.length) / 4) } };
    session.responseCache.set(requestSignature, response);
    session.lastResponse = response;
    clineLog(session, 'finish', response.choices[0].finish_reason);
    if (!payload.stream) return json(res, 200, response);
    if (!res.headersSent) sseHeaders(res);
    if (!emittedText && text) streamChunk(res, id, created, model, { content: text });
    streamChunk(res, id, created, model, {}, response.choices[0].finish_reason);
    return res.end('data: [DONE]\n\n');
  };

  if (payload.stream) { sseHeaders(res); streamChunk(res, id, created, model, { role: 'assistant', content: '' }); }
  const onDelta = (part) => {
    if (part.kind === 'text') {
      rawText += part.text;
      if (protocolCandidate) {
        buffered += part.text;
        flushTextWhenSafe();
      } else if (payload.stream && !holdInitialText) { streamChunk(res, id, created, model, { content: part.text }); emittedText = true; }
    }
    else if (part.kind === 'reasoning') {
      reasoning += part.text;
      // Some AiPASS providers place an otherwise normal response in a
      // reasoning delta. Detect an ACTION there too instead of waiting for a
      // finish event that may never arrive.
      const candidate = sideActionBuffer || /^\s*ACTION(?:\s|$)/.test(part.text) || 'ACTION'.startsWith(part.text.trim());
      if (candidate) {
        sideActionBuffer += part.text;
        const ready = parseToolProtocol(sideActionBuffer);
        if (ready.kind === 'calls') { rawText = sideActionBuffer; buffered = sideActionBuffer; protocolCandidate = true; }
      }
      if (payload.stream) streamChunk(res, id, created, model, { reasoning_content: part.text });
    }
    else if (TOOL_VISIBILITY !== 'off' && payload.stream) streamChunk(res, id, created, model, { reasoning_content: `${part.text}\n` });
  };
  const onError = (message) => {
    if (payload.stream) { res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`); return res.end('data: [DONE]\n\n'); }
    oaiError(res, 502, message, 'upstream_error');
  };
  let launch = (text) => {
    clineLog(session, 'upstream-send', `conversation=${shortId(targetConversationId)} category=${delivery.type} bytes=${Buffer.byteLength(text)} attachments=0 model=${model}`);
    currentJob = startChat({ modelId: model, text, conversationId: targetConversationId,
    onDelta: (part) => {
      onDelta(part);
    },
    onDone: complete,
    onError: (message) => { clineLog(session, 'upstream-error', String(message).slice(0, 120)); onError(message); },
  });
  };
  launch(upstreamText);
  req.on('aborted', () => { currentJob?.abort(); clineSessions.remove(session); clineLog(session, 'cancelled'); });
}

async function chatCompletions(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return oaiError(res, 400, 'invalid JSON body'); }
  try {
    // Tools and tool history opt into the isolated Cline protocol. Plain
    // OpenAI-compatible chat retains the bridge's established behaviour.
    const usesCline = Array.isArray(payload.tools) || (payload.messages ?? []).some((m) => m?.role === 'tool' || Array.isArray(m?.tool_calls));
    return usesCline ? await clineChatCompletions(req, res, payload) : await plainChatCompletions(req, res, payload);
  } catch (err) {
    return oaiError(res, 400, String(err?.message ?? err));
  }
}

/* -------------------------------------------------------- extension channel */

function extEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true',
  });
  const client = { id: randomUUID(), res };
  extClients.add(client);
  info('extension', `connected · total=${extClients.size}`);
  sendToClient(client, 'ready', { clientId: client.id });
  setTimeout(() => listModels({ force: true }).catch(() => {}), 500);

  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    extClients.delete(client);
    info('extension', `disconnected · remaining=${extClients.size}`);
    // Do NOT fail in-flight jobs. The upstream fetch lives in the page and
    // survives the worker being evicted, which is exactly what happens during
    // a long web_search when no deltas flow to reset the worker's idle timer.
    for (const job of jobs.values()) if (job.client === client) job.client = null;
  });
}

async function extPost(req, res, kind) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { ok: false }); }
  const job = jobs.get(body.jobId);
  if (!job) return json(res, 200, { ok: false, reason: 'unknown job' });
  if (kind === 'chunk') for (const part of body.parts ?? []) job.delta(part);
  else if (kind === 'done') job.done(body.finishReason);
  else if (kind === 'loader') {
    if (typeof body.raw === 'string') job.done(body.raw);
    else job.fail(body.message ?? 'loader fetch failed');
  } else job.fail(body.message ?? 'extension reported an error');
  return json(res, 200, { ok: true });
}

/* --------------------------------------------------------------- the server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  try {
    if (path.startsWith('/v1/') && !authorized(req)) return oaiError(res, 401, 'invalid API key', 'authentication_error');
    if (path === '/v1/chat/completions' && req.method === 'POST') return await chatCompletions(req, res);

    if (path === '/v1/models') {
      const models = await listModels({ force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id, object: 'model', created: 0, owned_by: m.provider ?? 'aipass',
          name: m.name, free_credit: m.free, thinking: m.thinking,
        })),
      });
    }

    if (path === '/conversations/new' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = await createConversation({ modelId: body.model, message: body.message, assistant: body.assistant });
      return json(res, 200, { id });
    }
    if (path === '/conversations') {
      await loadConversations().catch(() => {});
      return json(res, 200, {
        current: PINNED_CONVERSATION || conversationCache,
        conversations: conversationList.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      });
    }

    if (path === '/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.defaultModel === 'string' && body.defaultModel.trim()) {
        const previous = defaultModel;
        defaultModel = body.defaultModel.trim();
        info('config', `standalone model changed · ${previous} → ${defaultModel}`);
      }
      if (typeof body.clineModel === 'string' && body.clineModel.trim()) {
        const previous = clineDefaultModel;
        clineDefaultModel = body.clineModel.trim();
        info('config', `Cline fallback model changed · ${previous} → ${clineDefaultModel}`);
      }
      if (typeof body.assistant === 'string') { assistantId = body.assistant.trim(); info('config', assistantId ? 'assistant updated' : 'assistant cleared'); }
      if (body.conversation === null || typeof body.conversation === 'string') {
        conversationCache = body.conversation || null;
        conversationIndex = 0;
        if (!conversationCache) conversationList = [];
        info('config', conversationCache ? `conversation · id=${shortId(conversationCache)}` : 'conversation cleared');
      }
      return json(res, 200, { ok: true, defaultModel, clineModel: clineDefaultModel, assistant: assistantId || null, conversation: PINNED_CONVERSATION || conversationCache });
    }

    if (path === '/ext/events' && req.method === 'GET') return extEvents(req, res);
    if (path === '/ext/chunk' && req.method === 'POST') return await extPost(req, res, 'chunk');
    if (path === '/ext/done' && req.method === 'POST') return await extPost(req, res, 'done');
    if (path === '/ext/error' && req.method === 'POST') return await extPost(req, res, 'error');
    if (path === '/ext/loader' && req.method === 'POST') return await extPost(req, res, 'loader');

    if (path === '/status' || path === '/health') {
      return json(res, 200, {
        ok: true,
        extensions: extClients.size,
        activeJobs: jobs.size,
        defaultModel,
        clineModel: clineDefaultModel,
        conversation: PINNED_CONVERSATION || conversationCache,
        assistant: assistantId || null,
        clineSessions: clineSessions.status(),
        models: cachedModels(),
      });
    }

    return oaiError(res, 404, `no route for ${req.method} ${path}`, 'not_found');
  } catch (err) {
    error('http', `unhandled · ${String(err?.message ?? err).slice(0, 200)}`);
    if (!res.headersSent) oaiError(res, 500, String(err?.message ?? err), 'server_error');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  info('bridge', `listening · http://${HOST}:${PORT}`);
  info('bridge', `default model · ${defaultModel}`);
  info('bridge', `Cline fallback model · ${clineDefaultModel}`);
  info('bridge', `conversation · ${PINNED_CONVERSATION ? `pinned=${shortId(PINNED_CONVERSATION)}` : 'most recent on account'}`);
  info('bridge', `log level · ${LOG_LEVEL}`);
  info('bridge', 'waiting for Chrome extension');
});
