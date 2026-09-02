<div align="center">

<img width="420" alt="aipass bridge" src="https://github.com/user-attachments/assets/e79fbcbb-0a47-494a-af70-b315586fe3a7" />

# aipass bridge

**Make AiPASS great again — now with a terminal.**

[AiPASS](https://aipass.go.th/) gives every Thai citizen free access to 30+ pro AI models.
It only speaks one language though: a chat box. This puts it in your terminal, your
editor, and any OpenAI-compatible tool — and lets it read and write your local files.

[![test](https://github.com/niawjunior/aipass-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/niawjunior/aipass-bridge/actions/workflows/test.yml)

</div>

---

## What it does

```
your terminal ──▶ OpenAI-compatible API on localhost:8787 ──▶ a real logged-in AiPASS tab
```

- **Chat from the terminal**, streaming, with web search and sources.
- **Edit local files** — an agent that reads, searches, and edits a project you point it at.
- **Drop-in OpenAI endpoint** — point the `openai` SDK, or any tool that takes a base URL, at it.
- **Run it headless** on a server so it stays up without your laptop.

**No credential ever leaves your browser.** The real request runs as ordinary page
JavaScript inside your own logged-in tab, so Chrome attaches the session cookie
itself. The bridge never sees it, and nothing is written to disk.

## Quick start

```bash
npm run dev
```

Then load the extension — `chrome://extensions` → Developer mode → **Load unpacked**
→ select `aipass-bridge/extension` — and open a [de.aipass.net/chat](https://de.aipass.net/chat)
tab. The extension popup should read **Connected**.

```bash
npm run chat -- "ช่วยสรุปข่าว AI วันนี้"        # chat, streaming
npm run agent -- "add a /health route" --root .   # edit local files (dry run)
```

Use it from code like any OpenAI endpoint:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-dummy")
```

## Docs

**→ [Full documentation](aipass-bridge/README.md)** — setup, the coding assistant, the
agent's action set, conversations, configuration, and tests.

**→ [Headless deployment](aipass-bridge/deploy/README.md)** — Docker + noVNC, for
running it 24/7 on a server.

## Notes

This drives **your own** AiPASS account through a browser you are already signed in
to. It does not bypass authentication, scrape, or share anything — it gives a great
free service the developer interface it was missing. Be reasonable with it, and keep
your bridge on localhost.

Built on Node with no runtime dependencies, plus an MV3 Chrome extension.
`npm run dev:next` still starts the Next.js app that this repo was scaffolded from.
