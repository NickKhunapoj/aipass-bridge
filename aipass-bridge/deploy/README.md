# Headless deployment (optional)

Run the bridge on a Linux server so it stays up without your laptop. The
**core is unchanged** — this folder only adds container plumbing that runs the
same `../bridge` and `../extension` inside a headless Chromium you can view over
noVNC. Nothing here modifies the bridge, the agent, or the extension.

```
docker container
├── Xvfb + fluxbox      a virtual display
├── x11vnc + noVNC      view/drive that display in a browser  (:6080)
├── chromium            loads ../extension, opens de.aipass.net/chat
└── node ../bridge      the OpenAI-compatible bridge           (:8787)
```

## Security first — read before exposing anything

Three services here have **no authentication**: the bridge (`:8787`), and the
noVNC desktop (`:6080`) unless you set a password. The noVNC desktop is a full
remote view of a browser **logged into your de.aipass.net account** — treat the
port like a password.

By default `docker-compose.yml` binds every port to **`127.0.0.1`**, so nothing
is reachable from the network. Keep it that way and reach the desktop over an
**SSH tunnel**:

```bash
ssh -L 6080:127.0.0.1:6080 you@your-server
# then open http://127.0.0.1:6080 in your local browser
```

Only if you have a specific reason to expose `6080` to a network: set a strong
`noVNC_PASSWORD` in `.env` **first**, change the port to `6080:6080` in
`docker-compose.yml`, and firewall it.

## Run it

```bash
cd aipass-bridge/deploy
cp .env.example .env          # optionally set noVNC_PASSWORD
./reset.sh                    # build + start (docker compose up -d --build)
```

Before starting a private endpoint, set a long random API key in `.env`:

```bash
openssl rand -hex 32
# Copy the result into: AIPASS_API_KEY=...
```

OpenAI-compatible clients then use that value as their bearer token. The
Docker health endpoints and extension relay do not need the key.

The bridge accepts multiple simultaneous OpenAI-compatible clients. Each ready
extension worker serves up to four isolated API jobs by default; excess jobs
queue rather than being sent to a busy or stale worker. Set
`AIPASS_EXTENSION_CONCURRENCY` in `.env` to tune the per-worker limit.

Then:

1. Tunnel to noVNC (command above) and open `http://127.0.0.1:6080`.
2. In the Chrome window, log in at `https://de.aipass.net/chat` and leave the
   tab open. The extension is already loaded.
3. Verify end to end:

```bash
./test.sh                     # bridge status → extension connected → models → one chat
```

## Health, recovery, and alerts

Docker reports the container as `healthy` only when the bridge is responding
**and** at least one extension is attached. Check it without sending a model
request:

```bash
docker compose ps
curl -fsS http://127.0.0.1:8787/ready
```

`/health` is a liveness endpoint: it is `200` whenever the Node process can
answer HTTP. `/ready` is the stricter readiness endpoint used by Docker; it
returns `503` until Chrome's extension connects. `/status` also exposes
`oldestJobAgeMs` and `oldestJobIdleMs` for monitoring without exposing request
contents.

Supervisor runs a watchdog every 30 seconds. It logs and optionally alerts on
a dead bridge, no attached extension, or a job that has been silent for too
long. Recovery is rate-limited and escalates from reloading the extension/tab
to restarting Chromium. It does not restart the container merely because a
login expired, so the browser profile and noVNC desktop remain available for
you to sign in again.

The watchdog also posts an info event for each accepted API request (never its
prompt or response), an alert when AiPASS rejects authentication, and an alert
when the browser cannot reach AiPASS or it returns a server error. These totals
and timestamps are visible on `/status` as `apiRequests`, `authFailures`, and
`upstreamFailures`.

To receive alerts, set `AIPASS_ALERT_WEBHOOK_URL` in `.env`. Discord webhook
URLs automatically receive a native rich card with severity color, icon,
timestamp, and service context; a previously configured `/slack` suffix is
handled too. Other Slack-compatible endpoints receive concise text. The URL is
optional; blank means local logs only. The watchdog sends info on startup and
recovery, warnings when it takes a recovery action, and alerts for failures;
it never posts on every poll. Set `AIPASS_ALERT_INCLUDE_INFO=0` to receive only
warnings and alerts. The supplied settings are conservative:

| setting | default | purpose |
|---|---:|---|
| `AIPASS_WATCHDOG_INTERVAL_SECONDS` | 30 | time between checks |
| `AIPASS_WATCHDOG_STUCK_JOB_MS` | 960000 | silence before a job is treated as stuck (16 min) |
| `AIPASS_ALERT_COOLDOWN_SECONDS` | 900 | repeat-alert suppression window |
| `AIPASS_ALERT_INCLUDE_INFO` | 1 | send startup and recovery events to the webhook |

For an external monitor, alert on a failed `/ready` request or Docker changing
to `unhealthy`. Do not use `test.sh` as a frequent probe: it deliberately
sends a chat completion.

The bridge is now on the server's `127.0.0.1:8787`. Point any OpenAI-compatible
client at `http://127.0.0.1:8787/v1` (tunnel `8787` the same way to reach it
from your laptop), or run the agent on the server itself.

## Files

| file | what it is |
|---|---|
| `Dockerfile` | node 22 + chromium + Xvfb + x11vnc + noVNC + supervisor |
| `docker-compose.yml` | ports (localhost by default) and the `../bridge` / `../extension` mounts |
| `supervisord.conf` | starts and auto-restarts each process |
| `start-browser.sh` | launches Chromium with the extension, clears stale profile locks |
| `start-vnc.sh` | x11vnc with an optional password from `.env` |
| `reset.sh` | rebuild & restart (`--clean` also wipes the browser profile) |
| `test.sh` | end-to-end diagnostic |

## Notes

- The browser profile lives in `deploy/chrome-data/` (gitignored). Your login
  persists across restarts; `./reset.sh --clean` wipes it.
- `docker compose logs -f aipass-bridge` shows all processes; per-process logs
  are under `/var/log/` inside the container.
- This runs your account through an automated, always-on client — fine for your
  own TH-AI Passport account, but keep the server private.

## Security notes on the merge

This deployment and the multimodal (image) support both came from a community
PR. Two things were tightened before landing:

- The extension permission was scoped from `<all_urls>` down to the aipass
  origins plus `https://storage.googleapis.com/*` (the signed upload host). The
  bridge resolves remote image URLs to data URIs server-side behind an SSRF
  guard, so the extension never fetches an arbitrary URL with your cookies.
- Two reverse-engineering debug routes (`/inspect`, `/asset`) and a full-payload
  error dump were removed.

The image-upload feature itself is kept — send an `image_url` in a chat message
and it is uploaded to aipass and attached.
