# aipass bridge

Use [de.aipass.net](https://de.aipass.net/chat) from your terminal, API clients, and AI agents, with streaming support.

<img width="2048" height="1055" alt="image" src="https://github.com/user-attachments/assets/fa865ce3-7cf1-41f9-b98e-1f5a489a7619" />

<img width="2048" height="1332" alt="image" src="https://github.com/user-attachments/assets/101dcb7c-8e20-47f1-8858-de43aa06bc8f" />

<img width="2048" height="1332" alt="image" src="https://github.com/user-attachments/assets/d9115273-2585-4eeb-808e-3c6368b985a7" />

<img width="2904" height="1444" alt="image" src="https://github.com/user-attachments/assets/0715f177-0ac0-476a-a175-46661e99cf89" />

<img width="2048" height="1067" alt="image" src="https://github.com/user-attachments/assets/1a288db9-bd0a-42cc-9651-bc66958d5fc9" />

```
terminal / API ──HTTP──▶ bridge (node, port :8787)
                          │  SSE: jobs out, POST: deltas back
                          ▼
                       extension service worker
                          │  chrome.runtime
                          ▼
                       de.aipass.net tab (Chromium in Docker / Desktop)
                          │
                          ▼
                       /actions/send-message/<id>
```

**No credential ever leaves the browser.** The real request runs as ordinary
page JavaScript inside a `de.aipass.net` tab, so Chromium/Chrome attaches the session
cookie itself. The bridge never sees it and nothing sensitive is stored on disk.

---

## 🚀 Linux Server Deployment (Docker + Headless Chromium + noVNC Web UI)

The easiest and most reliable way to run `aipass-bridge` 24/7 on a headless Linux VPS or server (Ubuntu/Debian) is using Docker Compose with built-in **Xvfb**, **Fluxbox**, **Chromium**, **x11vnc**, and **noVNC**.

### 📋 Prerequisites
- Docker Engine & Docker Compose (`docker compose` or `docker-compose`)
- `curl` (for diagnostic scripts)

```bash
# Install Docker on Ubuntu/Debian (if not already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

---

### 🛠️ Quick Start in 5 Steps

#### 1. Clone the repository
```bash
git clone https://github.com/astrathezero/aipass-bridge.git
cd aipass-bridge/aipass-bridge
```

#### 2. Configure Environment & noVNC Password
Copy `.env.example` to `.env` and set your desired password to protect the noVNC web interface:
```bash
cp .env.example .env
nano .env
```
Inside `.env`:
```env
# Password protection for noVNC web interface (http://<SERVER-IP>:6080)
# Leave blank to disable password protection
noVNC_PASSWORD=MySecurePassword123
```

#### 3. Build & Start the Container
Run the automated initialization script:
```bash
chmod +x reset.sh test.sh start-browser.sh start-vnc.sh
./reset.sh
```
*(Or use `docker compose up -d --build`)*

This starts:
- **Xvfb + Fluxbox**: Virtual display `:99` (1280x800) with Thai fonts & emojis.
- **Chromium**: Headless browser pre-loading the bridge extension automatically.
- **x11vnc + noVNC**: Web-based VNC interface accessible via browser on port `6080`.
- **Bridge Server**: Local OpenAI-compatible API listening on `127.0.0.1:8787`.

#### 4. Open noVNC & Log in to aipass
1. Open your browser and navigate to:
   ```
   http://<YOUR-SERVER-IP>:6080
   ```
2. Enter your `noVNC_PASSWORD` when prompted.
3. You will see Chromium opened to **`https://de.aipass.net/chat`**.
4. Log in to your **aipass.net** account.
5. **Keep this chat tab open** in Chromium (the extension runs silently in the background).

#### 5. Verify the Connection
Back on your server terminal, test the bridge connection:
```bash
./test.sh
```
When successful, you will see:
```text
🟢 ✅ Extension connected! (extensions = 1)
📋 2. Testing Models Endpoint (/v1/models)...
💬 3. Testing Chat Completion (gemini-3.1-flash-lite)...
"สวัสดี! ระบบเชื่อมต่อและพร้อมทำงานแล้วครับ"
```

---

## 🔒 Security & Port Isolation

| Service / Port | Default Binding | Purpose |
|---|---|---|
| **noVNC Web UI** (`6080`) | `0.0.0.0:6080` | Browser GUI for initial account login & inspection (Protected with `noVNC_PASSWORD`) |
| **Bridge API** (`8787`) | `127.0.0.1:8787` | OpenAI-compatible API (Confined to localhost for security) |
| **Remote Debugging** (`9222`) | `127.0.0.1:9222` | Chromium DevTools protocol (Local only) |

> 💡 **Tip:** For maximum security in production, you can tunnel port `6080` via SSH (`ssh -L 6080:localhost:6080 user@server`) or put it behind Nginx/Caddy with TLS and basic authentication.

---

## 🌐 API Reference & Integration Guide

The bridge serves an **OpenAI-Compatible (`/v1`)** API on `http://127.0.0.1:8787`.

### 1. Check Bridge Status
```bash
curl -s http://127.0.0.1:8787/status
```

### 2. List Available Models
```bash
curl -s http://127.0.0.1:8787/v1/models
```
* **Free Credit Model:** `gemini-3.1-flash-lite`
* **Paid Credit Models:** `claude-sonnet-5@default`, `gpt-4o`, etc.

### 3. Chat Completion (cURL)

**Standard Request:**
```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-lite",
    "messages": [
      {"role": "user", "content": "Explain quantum computing in 2 sentences."}
    ]
  }'
```

**Real-time Streaming (`stream: true`):**
```bash
curl -N -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-lite",
    "messages": [
      {"role": "user", "content": "Write a short poem about code."}
    ],
    "stream": true
  }'
```

---

### 4. Python Integration (`openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="sk-dummy"  # Dummy key (authentication handled via browser session)
)

# Streaming example
stream = client.chat.completions.create(
    model="gemini-3.1-flash-lite",
    messages=[{"role": "user", "content": "Hello! What can you do?"}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

---

### 5. Node.js / TypeScript Integration

```typescript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "sk-dummy"
});

async function main() {
  const stream = await openai.chat.completions.create({
    model: "gemini-3.1-flash-lite",
    messages: [{ role: "user", content: "Tell me a fun fact." }],
    stream: true,
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || "");
  }
  console.log();
}

main();
```

---

### 6. Hermes AI Agent / Telegram Bot Integration

To connect an AI agent framework (such as [Hermes Agent](https://hermes-agent.nousresearch.com)) or a Telegram Bot to `aipass-bridge`:

**`config.yaml`:**
```yaml
model:
  default: gemini-3.1-flash-lite
  provider: aipass

providers:
  aipass:
    type: openai_compatible
    base_url: http://127.0.0.1:8787/v1
    api_key: sk-dummy
```

---

## 💻 Local Desktop Setup (Without Docker)

If you prefer running directly on macOS, Windows, or Linux desktop:

```bash
npm run dev
```

1. Open Chrome / Chromium: `chrome://extensions`
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** $\rightarrow$ select the `extension` folder inside this repository.
4. Open [https://de.aipass.net/chat](https://de.aipass.net/chat) and keep the tab open.
5. The extension popup should read **connected**.

---

## 🤖 Set up the coding assistant (one time)

The file-editing agent works best when aipass itself carries the tool protocol,
rather than the agent resending it every run. Create a custom assistant once at
[`/ai-assistant/new`](https://de.aipass.net/ai-assistant/new) and fill it in:

| Field | Value |
|---|---|
| **ชื่อ AI** (name) | `Local File Coder` |
| **รูปแบบ** (format) | `สนทนา` (conversational) |
| **AI โมเดลตั้งต้น** (model) | `Claude Sonnet 5` — best at holding the protocol |
| **แท็ก** (tags) | `coding`, `local-files` |
| **รายละเอียด** (description, display only) | `แก้ไขไฟล์ในเครื่องผ่าน bridge ด้วยคำสั่ง NEED / SEARCH / EDIT / CREATE / DONE` |
| **เพิ่มชุดความรู้** (knowledge files) | leave empty |

Paste this verbatim into **รูปแบบการดำเนินการของ AI** (the behaviour field, max 1000 characters — this is 958):

```
You help the user work on a code project on their computer. You cannot open the files; the user runs each action you write and pastes the result back. Never say you lack tools or ask them to paste files — just write actions.

Write actions on their own lines, exactly like this:

NEED dir .
NEED file src/app.ts
SEARCH text to find anywhere in the project
EDIT src/app.ts
FIND
the exact current lines
NEW
the replacement
END
CREATE notes.md
file contents
END
DONE one sentence summary when finished

Rules. Write prose in the user's language; keep action lines exactly as shown. Every reply needs an action or DONE. Never ask questions — pick a reasonable reading and begin. SEARCH to find where something is instead of reading every file; read a file before you EDIT it. Line numbers on the left are display only — never put them in FIND, copy the code exactly. Keep shortened hostnames like LCLHST as written. Write DONE only at the end, never with a NEED.
```

Save it, then start one chat with it in the UI and copy the conversation id from
the URL. Run the agent against that conversation with `--slim` (see below), or
wire the bridge to create bound conversations automatically.

---

## 🛠️ CLI Usage

```bash
npm run chat                          # interactive chat client
npm run chat -- "ช่วยสรุปข่าว AI วันนี้"   # one-shot query
```

In interactive mode: `/models` lists what's available, `/model <id>` switches,
Ctrl+C quits.

| script | |
|---|---|
| `npm run dev` | start the bridge on :8787 |
| `npm run chat` | terminal client |
| `npm run agent -- "task" --root .` | local file tools, in a fresh conversation |
| `npm run agent -- "task" --root . --watch` | stay open for follow-up tasks on the same conversation |
| `npm run models` | list models, marking free-credit ones |
| `npm run conversations` | list conversations and which is in use |
| `npm test` | run the test suite |

---

## ⚡ Actions the agent understands

| Action | What it does |
|---|---|
| `NEED dir <path>` | list a directory (`.` for the project root) |
| `NEED file <path>` | read a file, with line numbers; add a range like `NEED file src/app.ts 200-320` for a slice of a long one |
| `SEARCH <text>` | grep the whole project, returning `file:line: excerpt` matches |
| `EDIT <path>` → `FIND` … `NEW` … `END` | replace an exact snippet; the `FIND` text must match **one** place or the edit is refused |
| `CREATE <path>` … `END` | create a new file or overwrite an existing one |
| `RUN` … `END` | run a shell command — **off unless you pass `--allow-run`** |
| `DONE <summary>` | finish, with a one-line summary |

---

## 🗂️ Conversations Management

```bash
# Create a fresh conversation
curl -s localhost:8787/conversations/new -H 'content-type: application/json' -d '{"message":"hello"}'

# List active conversations
npm run conversations
```

---

## ⚙️ Configuration & Environment Variables

| env | default | Description |
|---|---|---|
| `noVNC_PASSWORD` | *(empty)* | Password protection for noVNC web interface |
| `AIPASS_PORT` | `8787` | Bridge API port |
| `AIPASS_HOST` | `0.0.0.0` (in Docker) / `127.0.0.1` | Host binding for Bridge API |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | Default model when none is specified |
| `AIPASS_MODELS` | two known ids | Fallback list when no extension is attached |
| `AIPASS_MODEL_FILTER` | `chat` | `all` keeps image/video/audio models |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `text` or `off` |
| `AIPASS_CONVERSATION_ID` | *(unset)* | Pin one conversation |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | Fail a job after this long with no delta |

---

## 🧪 Tests

```bash
npm test
```

37 tests, no dependencies, ~2 seconds execution time.

---

## 🔧 Maintenance & Troubleshooting

### 1. Resetting Stale Locks & Rebuilding
If Chromium fails to open due to container restarts or unexpected stops:
```bash
./reset.sh
```
Or for a complete clean reset of the Chrome data directory:
```bash
./reset.sh --clean
```

### 2. Extension Loading Compatibility
- **Chromium vs Google Chrome**: Starting with Chrome 137+, the `--load-extension` flag is restricted on Google Chrome official branding. This project uses **Chromium** in the Docker image, which fully supports command-line extension loading.
- **SingletonLock**: The startup scripts automatically clean up stale locks in `chrome-data/` across container restarts.

---

## ⚠️ Known Limits

- A `de.aipass.net` tab must stay open in Chromium/Chrome.
- Every message appears in the account's chat history on `aipass.net`.
- Only `gemini-3.1-flash-lite` is free credit; other models consume account quota.
