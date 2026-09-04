# aipass bridge

Use [de.aipass.net](https://de.aipass.net/chat) from your terminal, with
streaming.

<img width="1470" height="785" alt="image" src="https://github.com/user-attachments/assets/95bc87b5-6463-49f4-85b4-3134d9364998" />

<img width="2048" height="1332" alt="image" src="https://github.com/user-attachments/assets/d9115273-2585-4eeb-808e-3c6368b985a7" />

<img width="2904" height="1444" alt="image" src="https://github.com/user-attachments/assets/0715f177-0ac0-476a-a175-46661e99cf89" />

<img width="2048" height="1067" alt="image" src="https://github.com/user-attachments/assets/1a288db9-bd0a-42cc-9651-bc66958d5fc9" />


https://github.com/user-attachments/assets/56975f8d-a9ad-4562-9e00-422078cc66a2

https://github.com/user-attachments/assets/aa8ee7aa-ba2a-4f7c-ab9c-4f401cffd3b2


```
terminal ──HTTP──▶ bridge (node, no deps)
                      │  SSE: jobs out, POST: deltas back
                      ▼
                   extension service worker
                      │  chrome.runtime
                      ▼
                   de.aipass.net tab ──▶ /actions/send-message/<id>
```

**No credential ever leaves the browser.** The real request runs as ordinary
page JavaScript inside a de.aipass.net tab, so Chrome attaches the session
cookie itself. The bridge never sees it and nothing is stored on disk.

## Setup

```bash
npm run dev
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked**
→ select `aipass-bridge/extension`. Then open a `https://de.aipass.net/chat`
tab and leave it open; the popup should read **connected**.

> **Running on a server?** There's an optional headless Docker deployment in
> [`deploy/`](deploy/README.md) — the same bridge and extension in a container
> with a noVNC desktop, so it stays up 24/7 without your laptop. The core here
> is unchanged; that folder only adds container plumbing.

## Set up the coding assistant (one time)

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

Paste this verbatim into **รูปแบบการดำเนินการของ AI** (the behaviour field,
max 1000 characters — this is 958):

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
wire the bridge to create bound conversations automatically — also below.

## Use it

```bash
npm run chat                          # interactive
npm run chat -- "ช่วยสรุปข่าว AI วันนี้"   # one-shot
```

In interactive mode: `/models` lists what's available, `/model <id>` switches,
Ctrl+C quits.

**Pasting a block sends it as one message.** Readline reports one line per
newline, so a pasted thirteen-line prompt used to become thirteen requests —
each billed, with the model seeing only the first line as the question. A paste
arrives as a burst within a few milliseconds, which is how it is told apart from
someone pressing Enter; `--paste-idle MS` tunes the window if your terminal is
unusual.

| script | |
|---|---|
| `npm run dev` | start the bridge on :8787 |
| `npm run chat` | terminal client |
| `npm run agent -- "task" --root .` | local file tools, in a fresh conversation |
| `npm run agent -- "task" --root . --watch` | stay open for follow-up tasks on the same conversation |
| `npm run models` | list models, marking free-credit ones |
| `npm run conversations` | list conversations and which is in use |
| `npm run credits` | how much of the credit pool is left |
| `npm run doctor` | check every link in the chain and name what is broken |

Every script takes `--help`. Note the `--` separator: `npm run doctor --help`
prints *npm's* help, `npm run doctor -- --help` prints the script's.
| `npm test` | run the test suite |

`npm run dev:next` still starts the Next.js app in this repo.

## What you get

Whatever the web UI gives you for the same message — including its server-side
tools. A `web_search` shows up live and its sources are listed at the end:

```
[web_search] {"query":"aipass.go.th"}
[web_search] returned 4821 chars
AiPASS เป็นแพลตฟอร์มภายใต้โครงการ TH-AI Passport …
sources:
  - Aipass https://aipass.go.th/
```

Tool activity is sent as `reasoning_content`, so an OpenAI client that only
reads `content` sees a clean answer. `AIPASS_TOOL_VISIBILITY=text` inlines it,
`off` drops it.

## Logging

Bridge operational logs use a shared timestamp, severity, component, and
message format. `INFO` is the default minimum severity; set
`AIPASS_LOG_LEVEL=debug` to include dispatch-level `DEBUG` records. In an
interactive terminal, levels and components are colour-coded. Set
`AIPASS_LOG_COLOR=always` or `never` to override automatic colour detection.

## From code

The endpoint is OpenAI-compatible, so any SDK works — point it at
`http://127.0.0.1:8787/v1`. When `AIPASS_API_KEY` is configured, use that
value as the SDK key; otherwise a dummy key is accepted for local development.

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=os.environ["AIPASS_API_KEY"])
stream = client.chat.completions.create(
    model="gemini-3.1-flash-lite",
    messages=[{"role": "user", "content": "Hello! What can you do?"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

```typescript
import OpenAI from "openai";

const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: process.env.AIPASS_API_KEY });
const stream = await openai.chat.completions.create({
  model: "gemini-3.1-flash-lite",
  messages: [{ role: "user", content: "Tell me a fun fact." }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || "");
```

### Attachments

Send an `image_url` content part and the bridge uploads the image to aipass and
attaches it — vision works on models that support it. A `file` part does the
same for a document:

```python
client.chat.completions.create(model="claude-sonnet-5@default", messages=[{
    "role": "user",
    "content": [
        {"type": "text", "text": "What does this report conclude?"},
        {"type": "file", "file": {"filename": "report.pdf", "file_data": data_uri}},
    ],
}])
```

`file_data` is a `data:` URI; a plain `https://` URL works too and is fetched by
the bridge behind the SSRF guard, so the extension is never asked to fetch a URL
with your cookies. PDF, Word, Excel, PowerPoint, `.txt`, `.md`, `.csv` and
`.json` are accepted, up to 20 MB. Anything else is refused here rather than
uploaded and rejected upstream, where the error is vaguer. An image sent as a
`file` part is treated as an image, not a document.

From the terminal:

```bash
npm run chat -- "summarise this" --file report.pdf
npm run chat -- "compare these" --file q1.pdf --file q2.pdf
```

The file is read before the bridge is contacted, so a mistyped path is reported
on its own. Attachments ride on the first message only — they stay in the
conversation afterwards, and re-uploading them each turn would just spend
credits.

### Fields beyond the OpenAI schema

Both are ignored by clients that do not know them:

| field | values | effect |
| --- | --- | --- |
| `thinking_level` | `low`, `medium`, `high`, and `max` on Claude Opus | how long a reasoning model thinks before answering. The levels are per model — `GET /v1/models` reports each model's `thinking` — and a level the model does not advertise is dropped rather than sent. `npm run chat -- --thinking high`. |
| `aspect_ratio` | `1:1`, `3:4`, `4:3` | the shape of a generated image (see [Generating an image](#generating-an-image)). |

## Scope, and why

Only the user's message is sent. Not a system prompt, not a transcript.

That is not a limitation of the bridge, it is what the endpoint accepts. A
`messages` array containing an **assistant** turn is rejected upstream with a
bare `403` from Google Frontend, before the model sees it — the web UI never
sends one, because the server owns the conversation and its history. Attempts
to supply an agent-style system prompt were also rejected, at sizes and shapes
that plain text of the same size passed, which points at request scoring
rather than any single rule.

So this does the one thing that works reliably: send a message, stream the
answer. Multi-turn works because the server remembers the conversation, the
same way the web UI does.

## Local file tools

```bash
npm run agent -- "add a health route that returns ok" --root .
```

Nothing is written until you say so. Edits go to an in-memory overlay, so the
model can read back its own pending work; at the end you get a unified diff and
then the question:

```
apply 2 change(s)? [y/N]
```

Answer `y` and the overlay is written as shown — one run, one cost, and what you
approved is exactly what lands. Answer anything else and the disk is untouched.
`--apply` skips the question for scripted runs, and a non-interactive run with
no answer available falls back to writing nothing. Paths are confined to
`--root`; shell access needs `--allow-run`.

### Actions the agent understands

The model replies with these on their own lines; the agent runs each one locally
and pastes the result back. This is the whole tool set:

| Action | What it does |
|---|---|
| `NEED dir <path>` | list a directory (`.` for the project root) |
| `NEED file <path>` | read a file, with line numbers; add a range like `NEED file src/app.ts 200-320` for a slice of a long one |
| `SEARCH <text>` | grep the whole project, returning `file:line: excerpt` matches — find a symbol without reading every file |
| `EDIT <path>` → `FIND` … `NEW` … `END` | replace an exact snippet; the `FIND` text must match **one** place or the edit is refused |
| `CREATE <path>` … `END` | create a new file or overwrite an existing one |
| `RUN` … `END` | run a shell command — **off unless you pass `--allow-run`** |
| `DONE <summary>` | finish, with a one-line summary |

A few guarantees worth knowing: reads carry a line-number gutter but the model
never has to keep those (they are stripped from `FIND` automatically); an `EDIT`
whose `FIND` text is not unique is refused rather than applied to the wrong
occurrence; and long files page a screen at a time with a hint for the next
range.

**Watch mode** (`--watch`) keeps the agent open and takes follow-up tasks on the
same conversation, so the model keeps everything it has already read in context
— and because the server holds that history, each new task is still just one
small message. Run it in your editor's integrated terminal for a live edit loop.

**Binding to the custom assistant** (created above). Either point at a
conversation started under it — `--conversation <id> --slim` — or let the bridge
create bound conversations with `--assistant <id>` (which implies `--slim`). The
form field that carries the assistant id is set by `AIPASS_ASSISTANT_FIELD` on
the bridge (default `aiAssistantId`); confirm it once from a capture of the UI's
"new chat" request and every run binds automatically.

This works within the constraints above rather than against them:

- **Instructions are sent once**, as the first message of the conversation. The
  server remembers them, so later turns carry only the tool results — typically
  a couple of hundred bytes instead of resending a prompt every step.
- **No system prompt.** The preamble is just the first user message, which is
  the only channel this endpoint has.
- **The format is prose-shaped**: `NEED file some_file.ts`, no angle brackets, no
  `key=value` pairs, no absolute paths, no banner rules. Every one of those drew
  a 403 in earlier attempts, and none of them was load-bearing.
- **It never claims the model has tools.** The model's own system prompt says
  its tool is `web_search`, so a preamble written like a tool protocol makes it
  search for the syntax and then refuse, correctly, on the grounds that it has
  no file access. The preamble instead states the division of labour plainly:
  you have the files, the model writes lines, you run them and paste results
  back. It also says outright not to explain a lack of file access, which is the
  failure mode this replaces.
- **The first message includes the top-level listing**, so the model is grounded
  in the real directory instead of guessing a first path.

- **A rejected turn is split and resent.** File contents are arbitrary: a
  README carries shell commands, URLs and code fences, and any of those can push
  a request past an upstream filter. On a 403 the agent halves the message and
  sends the halves in sequence, recursively, down to ~300 bytes. The server
  remembers each part, so the model still sees the whole thing. If a fragment is
  rejected even on its own, the agent prints it rather than failing silently.

- **A custom aipass assistant carries the protocol.** The sanctioned way to
  give the model the tool convention is aipass's own Create AI Assistant
  (`/ai-assistant/new`) — paste the NEED/EDIT/CREATE/DONE instructions into its
  behaviour field. Then run against a conversation bound to that assistant with
  `--conversation <id>` (or `--reuse`) plus `--slim`, which drops the built-in
  preamble the assistant already provides.
- **Trigger-shaped tokens are encoded, symmetrically.** Everything sent upstream
  is encoded and everything read back is decoded — so the task text and preamble
  are covered, not just file contents. Three families, all confirmed against the
  live edge: `localhost` / `127.0.0.1` / `0.0.0.0` / `169.254.169.254` /
  `file://` (SSRF); any tag-opening `<` — `<html`, `<div`, a JSX component,
  `<script`, `<!--`, `<!doctype` — while leaving `a < b` and `=>` alone (XSS);
  and `.env` / `process.env` (the classic secrets-probe pattern). They go out as `LCLHST`, `CMT-OPEN`, `DOT-ENV` and so
  on, and are restored before anything is written — the bytes on disk are exactly
  what the file had. A file whose *name* is encoded (a real `.env` shown as
  `DOT-ENV`) still opens, because the decode runs on the model's actions too.

- **Lines that cannot be sent at all are dropped.** Real source contains
  code-execution shapes — `node -e`, `curl`, `rm -rf`, `/bin/sh`, `../../` —
  that no amount of splitting gets past. When a fragment is rejected even on its
  own, those lines are replaced with a note and the rest goes through, so one
  bad line costs a line rather than the whole run.

Tool results are capped at 3000 bytes (`--max-result`) for the same reason.

The npm scripts in this repo avoid `node -e "…"` one-liners for exactly this
reason — the agent reads `package.json` early in almost any task, and a script
field shaped like code execution got the whole read rejected.

## Try it

Run these top to bottom — the early ones are zero-risk (read-only, or a dry run
that writes nothing), and each proves a bit more. Use a scratch folder for the
builds so your own repo stays clean:

```bash
mkdir -p ~/Desktop/agent-test
```

**1. Read-only — proves the whole chain, writes nothing.**

```bash
npm run agent -- "What does this project do and what's the tech stack?" --root .
```

It reads the README and `package.json`, then answers. If this works, the
extension, bridge, and conversation flow are all healthy.

**2. One self-contained file — the classic first build (dry run).**

```bash
npm run agent -- "Create index.html: a self-contained todo app with inline CSS and JS. Add, complete, delete todos, persist to localStorage. Clean, modern look." --root ~/Desktop/agent-test
```

You see the whole file as a `+` diff, then `apply 1 change(s)? [y/N]`. Answer
`y` and then `open ~/Desktop/agent-test/index.html`.

**3. Edit an existing file — exercises `EDIT` / `FIND` / `NEW`.**

```bash
npm run agent -- "In index.html, add a button that clears all completed todos at once." --root ~/Desktop/agent-test --apply
```

It reads the file first, then makes a surgical edit — a real before/after diff,
not a rewrite.

**4. A small multi-file project.**

```bash
npm run agent -- "Create a tiny expense tracker: index.html, style.css, and app.js as separate files. Add expenses with amount and category, show a running total." --root ~/Desktop/agent-test --apply
```

**5. Watch mode — iterate live, the real workflow.**

```bash
npm run agent -- "Create a Pomodoro timer as a single index.html: 25-minute countdown, start/pause/reset." --root ~/Desktop/agent-test --apply --watch
```

Then keep typing follow-ups at the `task>` prompt — each builds on what it
already wrote, in the same conversation:

```
task> add a short-break mode of 5 minutes
task> play a sound when the timer hits zero
task> make it dark by default
```

**6. Search a real codebase — run this against the repo itself.** A task that
has to *find* something first is where `SEARCH` earns its place:

```bash
npm run agent -- "Find everywhere the bridge reads a process.env variable and list each one with what it configures." --root .
```

Watch it `SEARCH process.env`, get back `file:line` hits across the tree, read
only the files that matter, and answer — instead of reading everything. A rename
task (*"find every call to `outbound(` and …"*) exercises search-then-edit the
same way.

Start with **#1**: if it answers cleanly, everything after it is just the agent
doing more. If a step returns a `403`, it hit an upstream filter shape not yet
substituted — the failing fragment prints, and it is usually a one-line fix.

## Conversations

The bridge can create them, the way the chat page does — a form post to
`/chat.data` with `intent=create-conversation`. The server derives the id from
the first sixteen hex characters of the `clientCreateRequestId` it is given,
which is why ids look the way they do.

```bash
curl -s localhost:8787/conversations/new -H 'content-type: application/json' -d '{"message":"hello"}'
curl -s localhost:8787/conversations/new -H 'content-type: application/json' -d '{"temporary":true}'
npm run conversations     # list them, marking the one in use
```

`{"temporary":true}` uses `intent=create-temporary-chat` instead. A temporary
conversation is never listed in the account's chat history and carries an
`expiresAt` about a year out; it needs no opening message, since the point is
that nothing is kept. The flag has to be repeated on every message, so the
bridge remembers it per conversation and sends `isTemporary` on each turn —
including for a temporary conversation picked up again by `--reuse`.

**`npm run agent` starts a fresh temporary conversation for every run.** A
conversation carries its own history, so reusing one drags in whatever was said
before — including a refusal, which the model then sees itself having made and
repeats. Temporary conversations never appear in the account's chat history and
expire on their own, so a week of agent runs leaves the sidebar as it was.
`--permanent` saves the run like an ordinary conversation, `--reuse` continues
the most recent instead, and `--conversation ID` continues a specific one.
`npm run chat` continues the most recent by default, since that is what makes a
chat a chat; `--new` starts a clean one, `--new --temporary` a throwaway one.

Posting to an invented id returns `404 Conversation not found`, and a
conversation that stops accepting messages (`404` when deleted, `409` when the
server still believes a generation is running) makes the bridge move to the next
most recent.

## Models

The account carries far more than chat models — the live list is 34, of which 11
generate images, video or music. The bridge used to hide those, so a third of
what the account can do was invisible from here.

```bash
npm run models              # everything, grouped
npm run models -- image     # one category
```

```
สนทนา · chat  (22)
  gemini-3.1-flash-lite                      Gemini 3.1 Flash Lite  [free]
  claude-opus-5@azure                        Claude Opus 5
  ...

สร้างรูปภาพ · image  (5)
  gpt-image-2                                GPT-Image-2
  gemini-3-pro-image                         Nano Banana Pro
  ...
```

The popup groups its dropdown the same way, and `/v1/models` takes
`?kind=image` (or `?kind=image,video`) and tags every entry with its `kind`.

**The category is derived here, not sent.** `list-models` carries `id`,
`displayName`, `provider`, `description`, icons, `ready`, `selectable`,
`isFreeCredit` and `thinkingConfig` — and no category at all, so the tabs in the
web UI are built client-side. The rules that reproduce them live at the top of
`bridge/server.mjs`, each annotated with the models it actually catches, so they
can be re-checked against a fresh capture rather than trusted.

Two other fields now matter: a model that is `ready` but `selectable: false`
(`openthai2.0-legal@jts` is the live example) is not offered, because the web UI
does not offer it either.

> **Listing them is not yet driving them.** A chat request to an image model
> goes upstream, but the reply comes back as frames this bridge does not decode
> yet, so you get an empty answer rather than a picture. `AIPASS_MODEL_FILTER=chat`
> restores the old text-only list if that bothers a client.

## Generating an image

Pick an image model and ask for a picture. The reply comes back as a markdown
image, because chat completions have no field for one and every client already
renders markdown:

```bash
npm run chat -- "อยากได้ภาพแมว" --model gpt-image-2 --ratio 3:4
```

```
[image saved to /Users/you/aipass-1788366061-1.png]
```

`npm run chat` writes the file rather than printing megabytes of base64 into
your scrollback; `--out DIR` chooses where. From an OpenAI client the image
arrives inline as `![image](data:image/png;base64,…)`.

The aspect ratio rides on the same `imageAspectRatio` field the web UI sends.
A request can set `aspect_ratio`, `POST /config {"aspectRatio":"4:3"}` sets the
default, and `AIPASS_ASPECT_RATIO` sets it at startup.

### Video and music

The same command, with a video or music model:

```bash
npm run chat -- "a cat walking through Bangkok at night" --model veo-3.1-fast-generate-001
npm run chat -- "lo-fi study beat, rain" --model lyria-3-clip-preview
```

Generated media all arrives on the same `file` frame, and the media type
decides what happens to it. An image becomes `![image](…)`; a video or a music
clip becomes a **link** — `[video.mp4](…)` — because an mp4 inside an image tag
is a broken image in every renderer there is. `npm run chat` saves either kind
to `--out`, decoding a data URI or downloading a link once the answer has
finished printing.

Two things are different about video and music, and both are worth knowing
before you spend a generation on them:

- **Video has its own quota**, separate from the credit pool: ten a month on a
  standard account. `npm run credits` reports it.
- **Rendering goes quiet for minutes.** The bridge's timeout is on silence
  rather than on total time, but three minutes of silence is normal here, so
  video and music models get a much longer allowance —
  `AIPASS_MEDIA_TIMEOUT_MS`, 15 minutes by default. A chat model keeps the
  usual `AIPASS_IDLE_TIMEOUT_MS`.

A clip too large to carry back inline (over 50 MB for video, 25 MB for audio)
comes back as a link instead of the bytes. Those links are usually same-origin
and need the session cookie, so they open in the logged-in browser but cannot
be downloaded by the CLI — which says so rather than failing silently.

### A worked example

This came out of one command. The prompt is a heading and a ten-row CSV of a
northern Thai menu, pasted straight into the REPL:

```bash
npm run chat -- --new --model gpt-image-2 --ratio 3:4
```

```
> สร้างใบเมนูอาหารธีมล้านนา เอิร์ทโทน มีความภาคเหนือ โดยอิงรายละเอียดตามนี้ทั้งหมด
"ร้านมาเหนือ
ลำดับ,รายการเมนู,ราคา (บาท)
1,ข้าวซอยไก่ ,65
2,ข้าวซอยเนื้อโคขุน,85
3,ขนมจีนน้ำเงี้ยวเชียงราย,55
4,แกงฮังเลหมูนุ่ม,95
5,ลาบหมูคั่วเครื่องเทศ,80
6,น้ำพริกหนุ่ม + ผักลวก,60
7,น้ำพริกอ่อง + ผักสด,60
8,ไส้อั่วสมุนไพร (จานเล็ก),75
9,จิ๊นนึ่งน้ำพริกข่า,120
10,แกงโฮะวุ้นเส้น,70
  (13 lines · sent as one message)
[image saved to /Users/you/aipass-1788367390207-2.png]
```

<img src="docs/lanna-menu.png" alt="A Lanna-themed restaurant menu with ten Thai dishes and prices" width="420">

768 × 1024 — the `3:4` reached the model — with all ten rows, names and prices
intact. Both halves of that matter: `(13 lines · sent as one message)` is the
paste arriving whole rather than as thirteen separate requests, and the saved
file is the `file` frame decoding correctly.

**Video and music are not proven.** `veo-*`, `seedance-*` and `lyria-*` are
listed and selectable, and they use the same endpoint, but nobody has run one
through here — if a frame comes back that the decoder does not know, it says so
rather than returning nothing:

```
[frame] unhandled "data-video" — {"type":"data-video","data":{…}}
```

The **สไตล์ (style)** presets in the UI — อนิเมะ, การ์ตูน / 2D แฟลต, 3D เรนเดอร์,
เสมือนจริง, มินิมอล, AI / ไซเบอร์, สารคดี, น่ารัก / มาสคอต — are **not wired**.
No capture shows which field carries them, and guessing a field name would fail
silently. Send one capture with a style selected and they go in.

## When it is not working

Every failure in this chain looks the same from a client — the request just does
not work — because the thing that broke is upstream of the thing you are running.

```bash
npm run doctor
```

```
✓ bridge         responding
✓ extension      1 attached
✓ login          signed in — 23 models
✓ credits        9,833 of 10,000 left (98%)
✓ conversation   1137342f9c0a4e21
✓ round trip     gemini-3.1-flash-lite replied in 1.2s

all good.
```

Each check tests one link, and a failing one prints the single next action:

```
✓ bridge         responding
✗ extension      no tab attached
                 → open https://de.aipass.net/chat and leave it open; the popup should read "connected"
– login          skipped — nothing attached to ask
```

Checks after a failure are skipped rather than reported as broken too, so the
first `✗` is always the one to fix. It exits `0` when everything passes and `1`
otherwise, which makes it usable as a readiness probe.

The round trip actually sends a message. It runs unasked only when a
free-credit model is available, so a clean bill of health costs nothing —
`--chat` forces it on a paid model, `--no-chat` skips it.

## Credits

Every model but `gemini-3.1-flash-lite` draws on a shared pool, and that figure
used to live only in the web UI — so a run cost an unknown amount of something
you could not see.

```bash
npm run credits
```

```
9,833 of 10,000 credits left  (98%)
used 167  ·  resets 2026-08-31
video 10 of 10 left this month
```

The extension popup shows the same thing as a meter, amber under 20% and red
under 5%. `npm run agent` prints the balance before it starts and what the run
cost when it finishes:

```
credits  41.6 this run · 9,791 of 10,000 left
```

The bridge serves it at `GET /quota` (`?refresh=1` to bypass the 30-second
cache) and includes the last known figures on `/status`. The upstream loader
reports integers scaled by `creditsDecimals`, so a raw `10000000000` at 6
decimals is a pool of 10,000 — the bridge does that division for you.

## Configuration

| env | default | |
|---|---|---|
| `AIPASS_PORT` | `8787` | |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | used when no model is given |
| `AIPASS_MODELS` | two known ids | fallback list when no extension is attached |
| `AIPASS_MODEL_FILTER` | `all` | `chat` drops the image/video/music generators |
| `AIPASS_ASPECT_RATIO` | `1:1` | image models only; the UI offers `1:1`, `3:4`, `4:3` |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `text` or `off` |
| `AIPASS_CONVERSATION_ID` | *(unset)* | pin one conversation |
| `AIPASS_PER_REQUEST_CONVERSATIONS` | `1` | `0` restores legacy shared-conversation behavior |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | fail a job after this long with no delta |
| `AIPASS_EXTENSION_CONCURRENCY` | `4` | concurrent API jobs allowed per ready extension worker |
| `AIPASS_EXTENSION_WAIT_MS` | `0` (`20000` in Docker) | reconnect grace before a request fails for lack of an extension |
| `AIPASS_EXTENSION_STALE_MS` | `45000` | silence before a worker is excluded from scheduling |
| `AIPASS_CORS_ORIGIN` | *(unset)* | allow one browser origin to call the bridge — see below |
| `AIPASS_ALLOWED_HOSTS` | *(unset)* | extra hostnames accepted in the `Host` header |
| `AIPASS_ADMIN` | *(unset)* | `1` enables the container-management routes |
| `AIPASS_API_KEY` | *(unset)* | require this bearer token for client and admin routes |

The optional Docker deployment adds `/ready` (a `503` until an extension is
attached), a Docker healthcheck, a staged browser/extension watchdog, and an
optional Slack-compatible alert webhook. See [`deploy/`](deploy/README.md).

### Why the bridge is closed by default

Without `AIPASS_API_KEY`, the bridge has **no authentication** — anything that
can reach it can spend the account's credits. Set a long random key for any
private endpoint and clients must send `Authorization: Bearer <key>` (or
`X-API-Key`). `/health`, `/ready`, `/status`, and the loopback-only extension
channel remain unauthenticated so monitoring and the extension keep working.

It also refuses to be reachable from a web page:

- **No CORS.** The CLI clients ignore CORS and the extension reaches the bridge
  with host-permission privilege, so neither needs it. Without an
  `access-control-allow-origin`, a page you happen to visit cannot read (or
  usefully make) a cross-origin request to `127.0.0.1:8787`. Set
  `AIPASS_CORS_ORIGIN=https://your.app` only if you deliberately want one.
- **Host header allowlist.** Only loopback names are accepted, which blocks
  DNS rebinding — an attacker pointing a domain they own at `127.0.0.1`. Behind
  a reverse proxy, add the name to `AIPASS_ALLOWED_HOSTS`.
- **Admin routes off.** `/restart`, `/logs`, `/browser/restart`, `/ext/reload`
  and `/tab/reload` can restart processes, so they only exist when
  `AIPASS_ADMIN=1` — which the Docker deployment sets and a local run does not.

The bridge also serves `POST /v1/chat/completions` and `GET /v1/models`, so any
OpenAI-compatible client can point at `http://127.0.0.1:8787/v1` for plain
chat. By default every Chat Completions request creates one fresh AiPASS
temporary chat (`intent=create-temporary-chat`), sends only that request's
latest user message, and repeats the temporary flag on the response turn.
Temporary chats do not enter the AiPASS sidebar, so API calls stay isolated
without creating or resolving folders. Set `AIPASS_PER_REQUEST_CONVERSATIONS=0`
only if you need the legacy shared-conversation behavior.

AiPASS requests are never sent by the local Node process: the extension injects
them into the already-open `https://de.aipass.net/chat` page with
`credentials: 'include'`, so the browser uses its own signed-in session. A
real `401` or `403` now produces an `AIPASS_AUTH_REQUIRED` error after checking
that same browser page. Sign in or refresh AiPASS in that tab, then retry; do
not put an AiPASS cookie or account credential in the bridge configuration.

## Tests

```bash
npm test
```

53 tests, no dependencies, a few seconds. `test/harness.mjs` runs the real
bridge as a subprocess and a scriptable stand-in for the extension, so tests
drive the actual HTTP surface and the real CLIs rather than mocks of them.

They cover the failures this thing actually hit: that only the newest user
message is forwarded and never an assistant turn; conversation rotation past a
locked one; a job surviving the extension disconnecting mid-stream; loopback
substitution round-tripping so `localhost` never leaves the machine and the
bytes on disk are unchanged; splitting a rejected turn; dropping a line that
cannot be sent at any size; a premature `DONE` being ignored; recovery when the
model drifts into prose; refusing paths outside the project root; and dry run
leaving the disk untouched.

To add a case, script the model's replies with `scripted([...])` and, where a
filter is being modelled, pass `reject` to refuse payloads matching a pattern.

## Known limits

- A de.aipass.net tab must stay open for a request to run. If a tab predates the
  extension, or Chrome discarded it, the worker re-injects the scripts.
- Chrome evicts an idle MV3 service worker after ~30s, and inbound SSE bytes do
  not count as activity. Two things hold it open: the content script's port while
  a tab is there, and an offscreen document when one is not — so the bridge keeps
  reporting the extension accurately instead of flapping between attached and
  gone whenever the last tab closes.
- `npm run chat` appears in the account's chat history — this uses the real
  product. `npm run agent` does not: it uses a temporary conversation.
- Long sessions burn credits. Only `gemini-3.1-flash-lite` is free-credit;
  `npm run models` marks it, and `npm run credits` says what is left.
