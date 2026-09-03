const $ = (id) => document.getElementById(id);
let bridge = 'http://127.0.0.1:8787';
let lastModelSignature = '';

async function bridgeStatus(refresh = false) {
  try {
    const res = await fetch(`${bridge}/status`, { cache: 'no-store' });
    if (!res.ok) return null;
    const s = await res.json();
    if (refresh) await fetch(`${bridge}/v1/models?refresh=1`, { cache: 'no-store' });
    return s;
  } catch {
    return null;
  }
}

function renderModelSelect(select, models, selected) {
  // Rebuilding on every poll would fight the user mid-selection.
  select.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    const tags = [m.free ? 'free' : null, m.thinking ? 'thinking' : null].filter(Boolean);
    opt.textContent = `${m.name || m.id}${m.provider ? ` — ${m.provider}` : ''}${tags.length ? `  [${tags.join(', ')}]` : ''}`;
    opt.selected = m.id === selected;
    select.append(opt);
  }
  if (!models.some((m) => m.id === selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    opt.selected = true;
    select.prepend(opt);
  }
}

function renderModels(models, standalone, cline) {
  const signature = `${models.map((m) => `${m.id}${m.free}`).join('|')}::${standalone}::${cline}`;
  if (signature === lastModelSignature) return;
  lastModelSignature = signature;
  renderModelSelect($('model'), models, standalone);
  renderModelSelect($('cline-model'), models, cline);
  $('count').textContent = models.length ? `(${models.length})` : '';
}

async function refresh(forceModels = false) {
  const sw = await chrome.runtime.sendMessage({ type: 'status' });
  bridge = sw.bridgeUrl;
  $('conn').innerHTML =
    `<span class="dot ${sw.connected ? 'up' : 'down'}"></span>${sw.connected ? 'connected' : 'not connected'}`;
  $('tab').textContent = sw.tab ? new URL(sw.tab.url).pathname : 'none open';
  $('jobs').textContent = String(sw.activeJobs);
  if (document.activeElement !== $('url')) $('url').value = sw.bridgeUrl;

  const status = await bridgeStatus(forceModels);
  if (status) renderModels(status.models ?? [], status.defaultModel, status.clineModel ?? status.defaultModel);

  $('err').textContent = sw.lastError || (status ? '' : 'bridge not reachable — is server.mjs running?');
}

$('model').addEventListener('change', async () => {
  await fetch(`${bridge}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultModel: $('model').value }),
  }).catch(() => {});
});

$('cline-model').addEventListener('change', async () => {
  await fetch(`${bridge}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clineModel: $('cline-model').value }),
  }).catch(() => {});
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ bridgeUrl: $('url').value.trim().replace(/\/+$/, '') });
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(() => refresh(true), 400);
});

$('refresh').addEventListener('click', () => refresh(true));

refresh(true);
setInterval(() => refresh(false), 1500);
