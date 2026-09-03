// Test harness: runs the real bridge and a scriptable stand-in for the Chrome
// extension, so tests exercise the actual HTTP surface and the real CLIs.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// URL.pathname leaves a leading slash before the drive letter on Windows,
// which makes spawned test processes look for /C:/... rather than C:/....
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(HERE, '..', 'bridge', 'server.mjs');
export const AGENT = path.join(HERE, '..', 'agent.mjs');
export const CHAT = path.join(HERE, '..', 'chat.mjs');

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function waitFor(check, { timeout = 5000, every = 25 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, every));
  }
}

export async function startBridge(env = {}) {
  const port = await freePort();
  const sessionStore = path.join(os.tmpdir(), `aipass-sessions-${port}.json`);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, AIPASS_PORT: String(port), AIPASS_CLINE_SESSION_STORE: sessionStore, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${base}/status`).then((r) => r.ok).catch(() => false));
  return {
    base,
    port,
    sessionStore,
    log,
    logText: () => log.join(''),
    stop({ preserveSessionStore = false } = {}) { child.kill('SIGKILL'); if (!preserveSessionStore) fs.rmSync(sessionStore, { force: true }); },
  };
}

// Turbo-stream encoder, so loader fixtures are built the way the real app
// encodes them rather than hand-written.
export function encodeTurboStream(value) {
  const flat = [];
  const prims = new Map();
  const put = (v) => { flat.push(v); return flat.length - 1; };
  const prim = (v) => {
    const k = `${typeof v}:${String(v)}`;
    if (prims.has(k)) return prims.get(k);
    const i = put(v); prims.set(k, i); return i;
  };
  const enc = (v) => {
    if (v === null || v === undefined) return -5;
    if (Array.isArray(v)) { const slot = put(null); flat[slot] = v.map(enc); return slot; }
    if (typeof v === 'object') {
      const slot = put(null);
      const o = {};
      for (const [k, val] of Object.entries(v)) o[`_${prim(k)}`] = enc(val);
      flat[slot] = o;
      return slot;
    }
    return prim(v);
  };
  enc(value);
  return JSON.stringify(flat);
}

export const modelsFixture = (models) => encodeTurboStream({
  'routes/loaders/list-models': { data: { models, gatewayFlash: null } },
});

export const conversationsFixture = (conversations) => encodeTurboStream({
  'routes/loaders/list-converstaions': { data: { conversations, gatewayFlash: null } },
});

// The real response derives the id from the first 16 hex characters of the
// clientCreateRequestId, so the fake does the same.
export const createFixture = (requestId, initialMessage) => encodeTurboStream({
  data: {
    conversationId: requestId.replace(/-/g, '').slice(0, 16),
    initialMessage,
    error: null,
    clientCreateRequestId: requestId,
  },
});

const DEFAULT_MODELS = [
  { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', providerName: 'Google', isFreeCredit: true, ready: true },
  { id: 'claude-sonnet-5@default', displayName: 'Claude Sonnet 5', providerName: 'Anthropic', ready: true },
  { id: 'veo-3.1-fast-generate-001', displayName: 'Veo 3.1 Fast', providerName: 'Google', ready: true },
];
const DEFAULT_CONVERSATIONS = [
  { id: 'aaaa1111aaaa1111', title: 'newest', updatedAt: '2026-09-01T10:00:00.000Z' },
  { id: 'bbbb2222bbbb2222', title: 'older', updatedAt: '2026-09-01T09:00:00.000Z' },
];

// Stands in for the extension. `onChat` receives the job plus an emitter and
// decides what the upstream would have streamed back.
export class FakeExtension {
  constructor(base, { onChat, models = DEFAULT_MODELS, conversations = DEFAULT_CONVERSATIONS } = {}) {
    this.base = base;
    this.onChat = onChat ?? (async (_job, e) => { await e.text('ok'); await e.done(); });
    this.models = models;
    this.conversations = conversations;
    this.chats = [];       // every chat job received
    this.created = [];     // every create-conversation job received
    this.loaders = [];     // every loader url received
  }

  post(p, body) {
    return fetch(`${this.base}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {});
  }

  async count() {
    const r = await fetch(`${this.base}/status`).then((x) => x.json()).catch(() => null);
    return r?.extensions ?? -1;
  }

  // Connect and disconnect have to be observed on the bridge, not just issued.
  // Otherwise a test can start while a previous one's client is still
  // registered, and round-robin hands it the wrong scripted reply.
  async connect() {
    const before = await this.count();
    this.controller = new AbortController();
    const res = await fetch(`${this.base}/ext/events`, { signal: this.controller.signal });
    this.reading = this.#read(res.body.getReader());
    await waitFor(async () => (await this.count()) > before);
    return this;
  }

  async disconnect() {
    if (this.gone) return;   // t.after also calls this after an explicit disconnect
    this.gone = true;
    const before = await this.count();
    this.controller?.abort();
    await waitFor(async () => (await this.count()) < before, { timeout: 2000 }).catch(() => {});
  }

  async #read(reader) {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.search(/\n\n/)) !== -1) {
          const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
          let name = 'message'; const data = [];
          for (const l of frame.split('\n')) {
            if (l.startsWith('event:')) name = l.slice(6).trim();
            else if (l.startsWith('data:')) data.push(l.slice(5).trim());
          }
          if (!data.length || name !== 'job') continue;
          this.#handle(JSON.parse(data.join('\n')));
        }
      }
    } catch { /* aborted */ }
  }

  async #handle(job) {
    if (job.kind === 'create') {
      this.created.push(job);
      return void this.post('/ext/loader', { jobId: job.jobId, raw: createFixture(job.requestId, job.message) });
    }
    if (job.kind === 'loader') {
      this.loaders.push(job.url);
      const raw = job.url.includes('list-conversations')
        ? conversationsFixture(this.conversations)
        : modelsFixture(this.models);
      return void this.post('/ext/loader', { jobId: job.jobId, raw });
    }
    this.chats.push(job);
    const emit = {
      text: (t) => this.post('/ext/chunk', { jobId: job.jobId, parts: [{ kind: 'text', text: t }] }),
      reasoning: (t) => this.post('/ext/chunk', { jobId: job.jobId, parts: [{ kind: 'reasoning', text: t }] }),
      status: (t) => this.post('/ext/chunk', { jobId: job.jobId, parts: [{ kind: 'status', text: t }] }),
      done: (finishReason = 'stop') => this.post('/ext/done', { jobId: job.jobId, finishReason }),
      error: (message) => this.post('/ext/error', { jobId: job.jobId, message }),
    };
    await this.onChat(job, emit);
  }
}

// Replies the scripted list in order, and records the text of every turn.
// `sent` holds what the upstream actually accepted; a rejected attempt goes to
// `rejected` instead, so a test can assert that blocked content never got
// through without tripping over the attempt that was refused.
export function scripted(replies, { reject } = {}) {
  let turn = 0;
  const sent = [];
  const rejected = [];
  const handler = async (job, e) => {
    if (reject && reject(job.text)) {
      rejected.push(job.text);
      return void e.error('aipass returned 403 — 403 Forbidden');
    }
    sent.push(job.text);
    await e.text(replies[Math.min(turn++, replies.length - 1)]);
    await e.done();
  };
  handler.sent = sent;
  handler.rejected = rejected;
  return handler;
}

export function tempDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-test-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

// `stdin` may be a string (sent at once) or an array of [delayMs, line] pairs,
// which models a user typing after the process is already running — necessary
// for watch-mode tests, where a line sent before the prompt appears is lost.
export function run(script, args, { cwd, stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd, stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    if (typeof stdin === 'string') { child.stdin.write(stdin); child.stdin.end(); }
    else if (Array.isArray(stdin)) {
      let total = 0;
      for (const [delay, line] of stdin) {
        total += delay;
        setTimeout(() => { try { child.stdin.write(line); } catch {} }, total);
      }
      setTimeout(() => { try { child.stdin.end(); } catch {} }, total + 200);
    }
    child.on('close', (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }));
  });
}
