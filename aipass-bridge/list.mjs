#!/usr/bin/env node
// Small printers for the npm scripts. These used to be `node -e "…"` one
// liners in package.json, which is a code-execution shape that upstream
// filters reject when the agent reads its own package.json back.
const BRIDGE = (process.env.AIPASS_BRIDGE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const what = process.argv[2] ?? 'models';

if (['--help', '-h', 'help'].includes(what)) {
  console.log(`usage: node aipass-bridge/list.mjs <models|conversations|credits>

  models         list models, marking the free-credit ones
  conversations  list conversations, marking the one in use
  credits        how much of the credit pool is left

  AIPASS_BRIDGE  bridge base URL (default: http://127.0.0.1:8787)`);
  process.exit(0);
}

const get = async (p) => {
  const res = await fetch(`${BRIDGE}${p}`);
  if (!res.ok) throw new Error(`bridge returned ${res.status}`);
  return res.json();
};

try {
  if (what === 'models') {
    const { data } = await get('/v1/models');
    for (const m of data) {
      console.log(`${m.id.padEnd(38)} ${m.name ?? ''}${m.free_credit ? '  [free]' : ''}`);
    }
  } else if (what === 'conversations') {
    const { current, conversations } = await get('/conversations');
    for (const c of conversations) {
      console.log(`${c.id === current ? '*' : ' '} ${c.id}  ${c.updatedAt?.slice(0, 16) ?? ''}  ${c.title ?? ''}`);
    }
    if (!conversations.length) console.log('none — start a chat at https://de.aipass.net/chat');
  } else if (what === 'credits') {
    const q = await get('/quota');
    const n = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 2 : 0 });
    const pct = q.limit ? Math.round((q.available / q.limit) * 100) : 0;
    console.log(`${n(q.available)} of ${n(q.limit)} credits left  (${pct}%)`);
    console.log(`used ${n(q.used)}${q.periodEndsAt ? `  ·  resets ${q.periodEndsAt.slice(0, 10)}` : ''}`);
    if (q.video) console.log(`video ${q.video.remaining} of ${q.video.limit} left this ${q.video.period}`);
  } else {
    console.error(`unknown: ${what}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`${err.message} — is the bridge running? npm run dev`);
  process.exit(1);
}
