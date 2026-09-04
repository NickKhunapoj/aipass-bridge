// Service worker: holds the long-lived connection to the local bridge and
// routes each job into a de.aipass.net tab.
//
// The connection lives here rather than in the content script because an
// https:// page talking to http://127.0.0.1 runs into mixed-content and
// Private Network Access checks; an extension request with host_permissions
// does not.
const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const CYCLE_MS = 4 * 60 * 1000; // reconnect before Chrome's long-request ceiling
const SSE_STALE_MS = 45_000;
const POST_TIMEOUT_MS = 8_000;
const SITE_PROBE_MS = 60_000;
const SITE_PROBE_TIMEOUT_MS = 12_000;
const CONTENT_VERSION = 2;

let controller = null;
let connected = false;
let lastError = '';
let bridgeClientId = null;
let workerReady = false;
let readinessSetup = null;
let reconnectTimer = null;
let reconnectFailures = 0;
let siteFailures = 0;
let lastSiteProbeAt = 0;
const siteProbes = new Map();
const deliverySession = crypto.randomUUID();
let deliverySequence = 0;
const deliveryTails = new Map();
// jobId -> { tabId }. Every request runs against the signed-in chat tab.
const jobTabs = new Map();

// The content script's keepalive port only exists while a de.aipass.net tab is
// open. With no tab the worker is evicted, the SSE stream dies with it, and the
// bridge reports the extension as gone until the one-minute alarm revives it —
// so an offscreen document holds a port of its own, which is a context Chrome
// does not discard.
//
// One in-flight creation at a time: hasDocument() then createDocument() is
// check-then-act, and this is called from the alarm, from connect(), and on a
// port dropping. Same shape as connect() and the model refresh below.
let offscreenSetup = null;

function ensureOffscreenDocument() {
  if (typeof chrome.offscreen === 'undefined') return Promise.resolve();
  if (offscreenSetup) return offscreenSetup;
  offscreenSetup = (async () => {
    try {
      if (await chrome.offscreen.hasDocument?.()) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        // The enum has no value for "keep the worker alive", which is the only
        // thing this document does. BLOBS is a stand-in; nothing here handles a
        // blob, and the justification says what is really going on.
        reasons: ['BLOBS'],
        justification: 'Holds a port open so the service worker survives while no aipass tab is open',
      });
    } catch (err) {
      // Losing a creation race is the outcome we wanted anyway.
      if (!/single offscreen document/i.test(String(err?.message ?? err))) {
        console.warn('[aipass-bg] offscreen document:', err);
      }
    } finally {
      offscreenSetup = null;
    }
  })();
  return offscreenSetup;
}

const bridgeUrl = async () => {
  try {
    const res = await chrome.storage.local.get('bridgeUrl');
    return res?.bridgeUrl || DEFAULT_BRIDGE;
  } catch {
    return DEFAULT_BRIDGE;
  }
};

async function post(path, body, { attempts = 1, acceptUnknownJob = false } = {}) {
  const url = `${await bridgeUrl()}${path}`;
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: timeout.signal,
      });
      if (!res.ok) throw new Error(`bridge responded ${res.status}`);
      const reply = await res.json().catch(() => null);
      // A bridge restart cannot recover an old in-memory job. Drop that stale
      // callback immediately so it does not head-of-line block newer work.
      if (acceptUnknownJob && reply?.reason === 'unknown job') return true;
      if (reply?.ok === false) throw new Error(reply.reason || 'bridge rejected callback');
      return true;
    } catch (err) {
      lastError = String(err?.message ?? err);
      if (attempt + 1 < attempts) {
        const delay = Math.min(4_000, 200 * (2 ** attempt)) + Math.floor(Math.random() * 150);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.warn('[aipass-bg] POST error:', path, lastError);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

// Page events must reach the bridge in their original order. A stable delivery
// id makes retries safe when Docker drops the response after accepting a POST.
function deliver(path, body) {
  const payload = { ...body, deliveryId: `${deliverySession}:${++deliverySequence}` };
  const key = body.jobId;
  const run = () => post(path, payload, { attempts: 8, acceptUnknownJob: true });
  const previous = deliveryTails.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  deliveryTails.set(key, current);
  current.finally(() => {
    if (deliveryTails.get(key) === current) deliveryTails.delete(key);
  });
  return current;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * (2 ** reconnectFailures));
  const delay = Math.floor(Math.random() * Math.max(RECONNECT_MIN_MS, ceiling));
  reconnectFailures = Math.min(reconnectFailures + 1, 8);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function findChatTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.aipass.net/*', 'https://aipass.net/*'] });
  if (!tabs.length) return null;
  const live = tabs.filter((t) => !t.discarded && t.status !== 'unloaded');
  const pool = live.length ? live : tabs;
  // Prefer a tab already sitting on a chat route.
  return pool.find((t) => t.url?.includes('/chat')) ?? pool[0];
}

function waitForComplete(tabId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('tab did not finish loading')), timeoutMs);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      finish(resolve);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish(resolve);
    }).catch(() => {});
  });
}

async function releaseJobTab(jobId) {
  const record = jobTabs.get(jobId);
  jobTabs.delete(jobId);
  return record;
}

async function ensureContentScript(tab) {
  const ping = () => chrome.tabs.sendMessage(tab.id, { type: 'ping' });
  let ok = false;
  try {
    const response = await ping();
    ok = response?.ok === true && response?.version === CONTENT_VERSION;
  } catch { /* not there yet */ }

  if (!ok && (tab.discarded || tab.status === 'unloaded')) {
    await chrome.tabs.reload(tab.id);
    await waitForComplete(tab.id);
  }

  // Resolving this injection is the readiness check. Silently ignoring a
  // failure makes the SSE worker look healthy while every API job disappears.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['page.js'] });
  if (!ok) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['content.js'] });
    const response = await ping();
    if (response?.version !== CONTENT_VERSION) throw new Error('content relay version did not update');
  }
}

function probeAiPass(tab) {
  return new Promise((resolve) => {
    const probeId = crypto.randomUUID();
    const timer = setTimeout(() => {
      siteProbes.delete(probeId);
      resolve({ ok: false, message: 'AiPASS tab health check timed out' });
    }, SITE_PROBE_TIMEOUT_MS);
    siteProbes.set(probeId, (status) => {
      clearTimeout(timer);
      resolve(status);
    });
    chrome.tabs.sendMessage(tab.id, { type: 'probe', probeId }).catch((err) => {
      const settle = siteProbes.get(probeId);
      siteProbes.delete(probeId);
      if (settle) settle({ ok: false, message: `could not probe AiPASS tab: ${err?.message ?? err}` });
    });
  });
}

async function announceReady(clientId = bridgeClientId, { probe = false } = {}) {
  if (!connected || !clientId || (workerReady && !probe)) return;
  if (readinessSetup) return readinessSetup;
  readinessSetup = (async () => {
    const tab = await findChatTab();
    if (!tab) throw new Error('no de.aipass.net tab is open');
    await ensureContentScript(tab);
    lastSiteProbeAt = Date.now();
    const site = await probeAiPass(tab);
    if (!site.ok) throw new Error(site.message || 'AiPASS website is unavailable');
    if (!connected || bridgeClientId !== clientId) return;
    if (await post('/ext/ready', { clientId }, { attempts: 3 })) {
      workerReady = true;
      reconnectFailures = 0;
      siteFailures = 0;
      lastError = '';
    } else {
      controller?.abort();
    }
  })().catch((err) => {
    workerReady = false;
    lastError = `AiPASS tab is not ready: ${err?.message ?? err}`;
    console.warn('[aipass-bg] readiness:', lastError);
    siteFailures++;
    if (connected && clientId === bridgeClientId) post('/ext/unready', { clientId }, { attempts: 2 });
    // Chrome's network error page will not recover by itself. Reload only when
    // no API job owns the tab, and rate it behind three failed probes.
    if (siteFailures >= 3 && jobTabs.size === 0) {
      siteFailures = 0;
      findChatTab().then((tab) => tab && chrome.tabs.reload(tab.id)).catch(() => {});
    }
  }).finally(() => {
    readinessSetup = null;
  });
  return readinessSetup;
}

async function handleJob(job) {
  const tab = await findChatTab();
  if (!tab) {
    await deliver('/ext/error', { jobId: job.jobId, message: 'no de.aipass.net tab is open' });
    return;
  }
  jobTabs.set(job.jobId, { tabId: tab.id });
  try {
    await ensureContentScript(tab);
    await chrome.tabs.sendMessage(tab.id, { type: 'run', job });
  } catch (err) {
    await releaseJobTab(job.jobId);
    await deliver('/ext/error', {
      jobId: job.jobId,
      message: `could not reach the de.aipass.net tab (${tab.url ?? tab.id}): ${err?.message ?? err}`,
    });
  }
}

function handleEvent(name, data) {
  if (name === 'ready') {
    bridgeClientId = data?.clientId ?? null;
    workerReady = false;
    if (bridgeClientId) announceReady(bridgeClientId);
  } else if (name === 'job') handleJob(data);
  else if (name === 'abort') {
    const record = jobTabs.get(data.jobId);
    if (record) chrome.tabs.sendMessage(record.tabId, { type: 'abort', jobId: data.jobId }).catch(() => {});
    releaseJobTab(data.jobId);
  } else if (name === 'reload_extension') {
    try { chrome.runtime.reload(); } catch { /* ignore */ }
  } else if (name === 'reload_tab') {
    (async () => {
      const tab = await findChatTab();
      if (tab) chrome.tabs.reload(tab.id).catch(() => {});
    })();
  }
}

async function connect() {
  if (controller) return;
  controller = new AbortController();
  const signal = controller.signal;
  const cycle = setTimeout(() => controller?.abort(), CYCLE_MS);
  let lastEventAt = Date.now();
  const staleCheck = setInterval(() => {
    if (Date.now() - lastEventAt > SSE_STALE_MS) controller?.abort();
  }, 10_000);

  ensureOffscreenDocument();

  try {
    const res = await fetch(`${await bridgeUrl()}/ext/events`, {
      headers: { accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`bridge responded ${res.status}`);

    connected = true;
    bridgeClientId = null;
    workerReady = false;
    lastError = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lastEventAt = Date.now();
      pending += decoder.decode(value, { stream: true });

      let cut;
      while ((cut = pending.search(/\r?\n\r?\n/)) !== -1) {
        const frame = pending.slice(0, cut);
        pending = pending.slice(cut + pending.slice(cut).match(/^\r?\n\r?\n/)[0].length);

        let name = 'message';
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue; // comment / keepalive
        try { handleEvent(name, JSON.parse(dataLines.join('\n'))); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') lastError = String(err?.message ?? err);
  } finally {
    clearTimeout(cycle);
    clearInterval(staleCheck);
    connected = false;
    bridgeClientId = null;
    workerReady = false;
    controller = null;
    scheduleReconnect();
  }
}

// An SSE socket can linger after its worker has become unusable. The heartbeat
// lets the bridge exclude that stale connection from its worker pool instead
// of round-robining API requests into it until they time out.
setInterval(async () => {
  if (!connected || !bridgeClientId) return;
  if (workerReady) {
    const ok = await post('/ext/heartbeat', { clientId: bridgeClientId }, { attempts: 2 });
    if (!ok) controller?.abort();
    else if (Date.now() - lastSiteProbeAt >= SITE_PROBE_MS) announceReady(bridgeClientId, { probe: true });
  }
  else announceReady(bridgeClientId);
}, 20_000);

// A tab opened or reloaded after the worker connected should become usable
// without waiting for the next heartbeat retry.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && /^https:\/\/(?:[^/]+\.)?aipass\.net\//i.test(tab.url ?? '')) {
    announceReady();
  }
});

// A content script and the offscreen document each hold one of these open, which
// is what stops Chrome evicting the worker.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive' && port.name !== 'offscreen-keepalive') return;
  connect(); // a tab just appeared, or the worker just woke
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    // The content port cycles by design every four minutes; the offscreen one
    // dropping means the document itself went away.
    if (port.name === 'offscreen-keepalive') ensureOffscreenDocument();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'from-page') {
    const p = msg.payload;
    if (p.kind === 'page-status') {
      const settle = siteProbes.get(p.probeId);
      siteProbes.delete(p.probeId);
      settle?.({ ok: p.ok === true, message: p.message });
    }
    else if (p.kind === 'chunk') deliver('/ext/chunk', { jobId: p.jobId, parts: p.parts });
    else if (p.kind === 'done') { releaseJobTab(p.jobId); deliver('/ext/done', { jobId: p.jobId, finishReason: p.finishReason }); }
    else if (p.kind === 'error') { releaseJobTab(p.jobId); deliver('/ext/error', { jobId: p.jobId, message: p.message }); }
    else if (p.kind === 'loader') { releaseJobTab(p.jobId); deliver('/ext/loader', { jobId: p.jobId, raw: p.raw, message: p.message }); }
    return;
  }
  if (msg?.type === 'status') {
    (async () => {
      const tab = await findChatTab();
      sendResponse({
        connected,
        ready: workerReady,
        lastError,
        bridgeUrl: await bridgeUrl(),
        tab: tab ? { id: tab.id, url: tab.url } : null,
        activeJobs: jobTabs.size,
      });
    })();
    return true;
  }
  if (msg?.type === 'reconnect') { controller?.abort(); connect(); sendResponse({ ok: true }); return true; }
});

// The worker can still be evicted; the alarm brings it back, and the connect()
// guard makes a duplicate call harmless.
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  ensureOffscreenDocument();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
  connect();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
  connect();
});

// Initialize immediately
ensureOffscreenDocument();
connect();
