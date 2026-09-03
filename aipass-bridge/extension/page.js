// MAIN world. Runs as ordinary page JavaScript, so the fetch below is a real
// first-party request and the browser attaches the session cookie itself —
// nothing here ever reads or forwards a credential.
(() => {
  // Reloading the extension leaves this script running with stale code, and a
  // plain "already loaded" guard would block the replacement forever. Each
  // injection claims a higher generation; older copies stand down.
  const GEN = (window.__aipassBridgeGen ?? 0) + 1;
  window.__aipassBridgeGen = GEN;
  window.__aipassBridgeVersion = '0.2.2-folder-dialog';

  const TAG = '__aipass_bridge';
  const inflight = new Map();
  // Above this, an image goes back as a link rather than as bytes: the bridge
  // caps a POST body at 8 MB and base64 costs a third on top.
  // How many bytes of generated media may be carried back inline as a data URI.
  // Video and music are much larger than an image and the base64 costs another
  // third, but a same-origin link is useless outside this browser — so they get
  // a bigger allowance rather than a link by default.
  const INLINE_CAP = {
    image: 5 * 1024 * 1024,
    audio: 25 * 1024 * 1024,
    video: 50 * 1024 * 1024,
    file: 10 * 1024 * 1024,
  };

  // image/png -> image, video/mp4 -> video, audio/wav -> audio. Anything else
  // is a file, which the bridge renders as a link rather than an image tag.
  const mediaKind = (mediaType) => {
    const t = String(mediaType || '').toLowerCase();
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('audio/')) return 'audio';
    return '';
  };
  // Frames that legitimately carry nothing we need.
  const QUIET_FRAMES = new Set([
    'start', 'start-step', 'finish-step', 'text-start', 'text-end',
    'reasoning-start', 'reasoning-end', 'tool-input-delta', 'message-metadata',
  ]);

  const reply = (msg) => window.postMessage({ [TAG]: 'res', ...msg }, window.location.origin);

  // The extension is deliberately the only component that talks to AiPASS:
  // this request runs in the already-open, first-party tab and lets the
  // browser attach its own cookie. On an authorization response, check that
  // same tab instead of asking the local bridge (which never has a cookie) to
  // guess whether the account is signed in.
  async function authorizedChatPage() {
    try {
      const page = await fetch('/chat', {
        credentials: 'include',
        redirect: 'follow',
        headers: { accept: 'text/html' },
      });
      const target = new URL(page.url, window.location.origin);
      return page.ok && target.origin === window.location.origin && /^\/chat(?:\/|$)/.test(target.pathname);
    } catch {
      return false;
    }
  }

  async function responseError(res, { bytes = 0, detail = true } = {}) {
    let responseBody = '';
    if (detail) responseBody = (await res.text().catch(() => '')).slice(0, 500);
    const forensics = ['server', 'via', 'cf-ray', 'retry-after']
      .map((header) => [header, res.headers.get(header)])
      .filter(([, value]) => value)
      .map(([header, value]) => `${header}=${value}`)
      .join(' ');
    const upstream = `aipass returned ${res.status} ${res.statusText}` +
      `${bytes ? ` [${bytes} bytes]` : ''}${forensics ? ` {${forensics}}` : ''}` +
      `${responseBody ? ` — ${responseBody}` : ''}`;

    if (res.status !== 401 && res.status !== 403) return upstream;
    const signedIn = await authorizedChatPage();
    return `AIPASS_AUTH_REQUIRED: ${signedIn
      ? 'the open AiPASS chat page is signed in, but AiPASS denied this action'
      : 'the open AiPASS chat page is not signed in or its session expired'}. ` +
      `Open https://de.aipass.net/chat in the browser, sign in there, and retry. ${upstream}`;
  }

  // Read-only GET against one of the app's own loaders. Confined to /loaders/
  // so a compromised bridge cannot turn this into a general request forwarder.
  async function runLoader(job) {
    try {
      if (!/^\/loaders\/[A-Za-z0-9._~-]+(\.data)?(\?|$)/.test(job.url)) {
        throw new Error(`refusing non-loader path: ${job.url}`);
      }
      const res = await fetch(job.url, { credentials: 'include', headers: { accept: '*/*' } });
      if (!res.ok) throw new Error(await responseError(res));
      reply({ jobId: job.jobId, kind: 'loader', raw: await res.text() });
    } catch (err) {
      reply({ jobId: job.jobId, kind: 'loader', message: String(err?.message ?? err) });
    }
  }

  // Creating a conversation is a form post to the route the chat page itself
  // uses. The server derives the id from clientCreateRequestId, taking its
  // first sixteen hex characters.
  async function runCreate(job) {
    try {
      // A temporary chat is a different intent and takes no first message: the
      // server mints the conversation itself and marks it isTemporary, so it
      // never lands in the account's history and expires on its own.
      const params = job.temporary
        ? new URLSearchParams({ intent: 'create-temporary-chat' })
        : new URLSearchParams({
            message: job.message,
            folderId: job.folderId || '',
            modelId: job.modelId,
            intent: 'create-conversation',
            clientCreateRequestId: job.requestId,
          });
      // Bind to a custom assistant when one is configured. The field name comes
      // from the bridge so it can be corrected without touching the extension.
      if (job.assistant && job.assistantField) params.set(job.assistantField, job.assistant);
      const res = await fetch('/chat.data', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', accept: '*/*' },
        body: params.toString(),
      });
      if (!res.ok) throw new Error(await responseError(res));
      reply({ jobId: job.jobId, kind: 'loader', raw: await res.text() });
    } catch (err) {
      reply({ jobId: job.jobId, kind: 'loader', message: String(err?.message ?? err) });
    }
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitUntil(check, { timeout = 12_000, every = 80 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error('timed out waiting for the AiPASS folder UI');
      await delay(every);
    }
  }

  const visible = (element) => Boolean(element?.getClientRects().length);
  const controls = () => [...document.querySelectorAll('button, a')].filter(visible);
  const exactControl = (text) => controls().find((element) => element.textContent.trim() === text);
  const folderIdInLocation = () => window.location.pathname.match(/^\/folder\/([0-9a-f-]{36})\/?$/i)?.[1] ?? '';

  function folderNavigation() {
    return controls().find((element) => element.getAttribute('href') === '/folder')
      ?? controls().find((element) => /^(folders?|โฟลเดอร์)$/i.test(element.textContent.trim()));
  }

  function createFolderControl() {
    return controls().find((element) => /^(create folder|สร้างโฟลเดอร์)$/i.test(element.textContent.trim()));
  }

  function folderNameInput() {
    return [...document.querySelectorAll('input')].find((element) => visible(element) && /^(name|ชื่อ)$/i.test(element.getAttribute('placeholder') ?? ''));
  }

  function confirmFolderControl() {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(visible);
    if (!dialog) return null;
    return [...dialog.querySelectorAll('button')].find((element) =>
      visible(element) && !element.disabled && /^(confirm|create|ยืนยัน|สร้าง)$/i.test(element.textContent.trim()));
  }

  function setInputValue(input, value) {
    // React tracks the native property setter; assigning input.value alone
    // does not enable the form's submit action in its controlled component.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Folder management goes through the visible first-party UI, not a guessed
  // data endpoint. That lets the site create its own folder and gives us the
  // id from the same /folder/<id> route a user sees after selecting it.
  async function runFolder(job) {
    try {
      if (!await authorizedChatPage()) {
        throw new Error('AIPASS_AUTH_REQUIRED: the open AiPASS chat page is not signed in or its session expired. Open https://de.aipass.net/chat in the browser, sign in there, and retry.');
      }

      let folder = exactControl(job.name);
      if (!folder) {
        folderNavigation()?.click();
        await waitUntil(() => exactControl(job.name) || createFolderControl() || folderNameInput());
        folder = exactControl(job.name);
      }
      if (!folder) {
        createFolderControl()?.click();
        const input = await waitUntil(folderNameInput);
        setInputValue(input, job.name);
        // AiPASS now opens a confirmation dialog whose submit button is not
        // necessarily associated with the input's form. Click the visible
        // enabled control explicitly instead of relying on Enter/requestSubmit.
        (await waitUntil(confirmFolderControl)).click();

        // A successful create can navigate directly to /folder/<id> without
        // first rendering a selectable folder label. Accept either outcome.
        const created = await waitUntil(() => {
          const folderId = folderIdInLocation();
          if (folderId) return { folderId };
          const control = exactControl(job.name);
          return control ? { control } : null;
        });
        if (created.folderId) {
          reply({ jobId: job.jobId, kind: 'loader', raw: JSON.stringify({ folderId: created.folderId, name: job.name }) });
          return;
        }
        folder = created.control;
      }
      folder.click();
      const folderId = await waitUntil(folderIdInLocation);
      reply({ jobId: job.jobId, kind: 'loader', raw: JSON.stringify({ folderId, name: job.name }) });
    } catch (err) {
      reply({ jobId: job.jobId, kind: 'loader', message: String(err?.message ?? err) });
    }
  }

  function dataUrlToBlob(dataUrl) {
    const arr = dataUrl.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  }

  async function uploadFileHelper(blob, filename, contentType, conversationId, modelId, signal) {
    const initRes = await fetch('/actions/upload-file/initiate', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        filename,
        contentFilename: filename,
        contentType,
        sizeBytes: blob.size,
        ...(modelId ? { modelId } : {})
      }),
      signal
    });
    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => '');
      throw new Error(`upload initiate failed: ${initRes.status} ${errText}`);
    }
    const initData = await initRes.json();
    if (initData.error) throw new Error(initData.error);
    if (!initData.uploadUrl || !initData.uploadToken || !initData.storageKey) {
      throw new Error('invalid upload initiate response');
    }

    const putHeaders = { 'Content-Type': contentType };
    if (initData.sizeBytes != null) {
      putHeaders['x-goog-content-length-range'] = `${initData.sizeBytes},${initData.sizeBytes}`;
      putHeaders['x-goog-if-generation-match'] = '0';
    }
    const putRes = await fetch(initData.uploadUrl, {
      method: 'PUT',
      headers: putHeaders,
      body: blob,
      signal
    });
    if (!putRes.ok && putRes.status !== 412) {
      throw new Error(`direct upload PUT failed: ${putRes.status}`);
    }

    const confirmRes = await fetch('/actions/upload-file/confirm', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadToken: initData.uploadToken
      }),
      signal
    });
    if (!confirmRes.ok) {
      const errText = await confirmRes.text().catch(() => '');
      throw new Error(`upload confirm failed: ${confirmRes.status} ${errText}`);
    }
    const confirmData = await confirmRes.json();
    if (confirmData.error) throw new Error(confirmData.error);

    return {
      storageKey: confirmData.storageKey || initData.storageKey,
      downloadUrl: confirmData.downloadUrl || confirmData.url || initData.downloadUrl || initData.url || ''
    };
  }

  async function run(job) {
    const controller = new AbortController();
    inflight.set(job.jobId, controller);

    // Deltas arrive in tiny pieces; batching keeps the hop back to the bridge
    // from turning into hundreds of POSTs per response.
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      reply({ jobId: job.jobId, kind: 'chunk', parts: buffer });
      buffer = [];
    };
    const ticker = setInterval(flush, 40);
    const push = (kind, text) => { if (text) buffer.push({ kind, text }); };

    try {
      // Process parts: upload any image blobs and get their storageKey
      const processedParts = [];
      if (Array.isArray(job.parts) && job.parts.length > 0) {
        for (const p of job.parts) {
          if (p.type === 'image' || p.type === 'file') {
            const rawUrl = p.image || p.url || p.data || '';
            // Images default to jpeg because that is what a bare data: URI
            // usually is; anything else must declare what it is.
            let mediaType = p.mediaType || (p.type === 'image' ? 'image/jpeg' : 'application/octet-stream');
            let blob = null;
            // Only data: URIs are accepted here. The bridge resolves remote
            // image URLs to data URIs server-side (behind an SSRF guard), so the
            // extension is never asked to fetch an arbitrary URL with the user's
            // cookies.
            if (rawUrl.startsWith('data:')) {
              blob = dataUrlToBlob(rawUrl);
              mediaType = blob.type || mediaType;
            }
            if (blob) {
              const ext = (mediaType.split('/')[1] || 'jpeg').replace(/^jpeg$/, 'jpg');
              const filename = p.filename || `${p.type === 'image' ? 'image' : 'attachment'}.${ext}`;
              push('status', `[upload] uploading ${filename} (${(blob.size / 1024).toFixed(1)} KB)...`);
              const uploadRes = await uploadFileHelper(
                blob,
                filename,
                mediaType,
                job.conversationId,
                job.modelId,
                controller.signal
              );
              processedParts.push({
                type: 'file',
                mediaType,
                filename,
                url: uploadRes.storageKey,
                storageKey: uploadRes.storageKey,
              });
            }
          } else {
            processedParts.push({
              type: 'text',
              text: typeof p.text === 'string' ? p.text : String(p),
            });
          }
        }
      } else {
        processedParts.push({ type: 'text', text: job.text });
      }

      const body = JSON.stringify({
        modelId: job.modelId,
        // The image models take this; the chat models ignore it. The web UI
        // offers 1:1, 3:4 and 4:3.
        imageAspectRatio: job.aspectRatio || '1:1',
        // A temporary conversation has to be told so on every turn, not just at
        // creation — the web client sends this same flag with each message.
        ...(job.temporary ? { isTemporary: true } : {}),
        // The levels a model advertises in thinkingConfig.supportedLevels —
        // low | medium | high, and max on Claude Opus. The bridge validates.
        ...(job.thinkingLevel ? { thinkingLevel: job.thinkingLevel } : {}),
        messages: [{
          id: crypto.randomUUID(),
          role: 'user',
          metadata: { modelId: job.modelId },
          parts: processedParts,
        }],
      });

      const res = await fetch(`/actions/send-message/${encodeURIComponent(job.conversationId)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: '*/*' },
        body,
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(await responseError(res, { bytes: body.length }));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let finishReason = 'stop';
      const toolNames = new Map();
      const sources = [];
      const seenUnknown = new Set();

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let cut;
        while ((cut = pending.search(/\r?\n\r?\n/)) !== -1) {
          const frame = pending.slice(0, cut);
          pending = pending.slice(cut + pending.slice(cut).match(/^\r?\n\r?\n/)[0].length);

          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (!data || data === '[DONE]') continue;

          let evt;
          try { evt = JSON.parse(data); } catch { continue; }

          // Server-side tools (web_search, media generation) run upstream and
          // stream their progress here. Dropping these frames silently makes a
          // long search look like a hang.
          switch (evt.type) {
            case 'text-delta':
              push('text', evt.delta);
              break;
            case 'reasoning-delta':
              push('reasoning', evt.delta ?? evt.text);
              break;
            case 'tool-input-start':
              toolNames.set(evt.toolCallId, evt.toolName);
              break;
            case 'tool-input-available':
              toolNames.set(evt.toolCallId, evt.toolName);
              push('status', `[${evt.toolName}] ${JSON.stringify(evt.input ?? {})}`);
              break;
            case 'tool-output-available': {
              const name = toolNames.get(evt.toolCallId) ?? 'tool';
              const size = typeof evt.output === 'string' ? evt.output.length : JSON.stringify(evt.output ?? '').length;
              push('status', `[${name}] returned ${size} chars`);
              break;
            }
            // Generated media — an image, a video, a music clip — all arrive as
            // a file part. Its URL is usually same-origin and needs the session
            // cookie, which only this page has, so it is fetched here and handed
            // back as a data URI. Anything already absolute, or too big to
            // carry, goes back as a plain URL instead.
            case 'file': {
              const url = evt.url ?? evt.data?.url ?? '';
              if (!url) break;
              const mediaType = evt.mediaType ?? evt.data?.mediaType ?? '';
              // The kind decides how the client renders it: an mp4 in an image
              // tag is a broken image, not a video.
              const kind = mediaKind(mediaType) || (/^data:/i.test(url) ? mediaKind(url.slice(5)) : '') || 'file';
              if (/^data:/i.test(url)) { push(kind, url); break; }
              let carried = '';
              if (!/^https?:\/\//i.test(url) || url.startsWith(location.origin)) {
                try {
                  const r = await fetch(url, { credentials: 'include', signal: controller.signal });
                  const blob = await r.blob();
                  const cap = INLINE_CAP[kind] ?? INLINE_CAP.file;
                  push('status', `[${kind}] ${mediaType || blob.type || 'unknown type'}, ${(blob.size / 1048576).toFixed(2)} MB`);
                  if (blob.size <= cap) {
                    carried = await new Promise((resolve, reject) => {
                      const fr = new FileReader();
                      fr.onload = () => resolve(String(fr.result));
                      fr.onerror = () => reject(fr.error);
                      fr.readAsDataURL(blob);
                    });
                  } else {
                    // A link is only useful to the caller if it can be fetched
                    // without this page's cookie, so say which case this is.
                    push('status', `[${kind}] over the ${(cap / 1048576).toFixed(0)} MB inline limit — sending the link, which may need a logged-in browser`);
                  }
                } catch (err) {
                  push('status', `[${kind}] could not read it here (${err?.message ?? err}), sending the link`);
                }
              }
              push(kind, carried || new URL(url, location.origin).href);
              break;
            }
            case 'source-url':
              if (evt.url && !sources.some((x) => x.url === evt.url)) sources.push({ url: evt.url, title: evt.title });
              break;
            case 'error':
              throw new Error(evt.errorText ?? evt.message ?? 'stream error');
            case 'finish':
              finishReason = evt.finishReason ?? finishReason;
              break;
            default:
              // Known-boring frames carry no content. Anything else is either a
              // protocol change or a shape we have never seen — say so once,
              // rather than returning an empty answer and no clue why.
              if (!QUIET_FRAMES.has(evt.type) && !seenUnknown.has(evt.type)) {
                seenUnknown.add(evt.type);
                push('status', `[frame] unhandled "${evt.type}" — ${JSON.stringify(evt).slice(0, 300)}`);
              }
              break;
          }
        }
      }

      if (sources.length) {
        push('status', `sources:\n${sources.map((x) => `  - ${x.title ?? ''} ${x.url}`).join('\n')}`);
      }
      flush();
      reply({ jobId: job.jobId, kind: 'done', finishReason });
    } catch (err) {
      flush();
      if (err?.name === 'AbortError') reply({ jobId: job.jobId, kind: 'done', finishReason: 'stop' });
      else reply({ jobId: job.jobId, kind: 'error', message: String(err?.message ?? err) });
    } finally {
      clearInterval(ticker);
      inflight.delete(job.jobId);
    }
  }

  window.addEventListener('message', (event) => {
    if (window.__aipassBridgeGen !== GEN) return; // superseded by a newer injection
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg[TAG] === 'req') {
      const fn = msg.job.kind === 'loader' ? runLoader : msg.job.kind === 'create' ? runCreate : msg.job.kind === 'folder' ? runFolder : run;
      fn(msg.job);
    }
    else if (msg[TAG] === 'abort') inflight.get(msg.jobId)?.abort();
  });

  reply({ kind: 'page-ready' });
})();
