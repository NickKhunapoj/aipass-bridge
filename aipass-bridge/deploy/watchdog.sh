#!/bin/bash
# Repairs the browser relay in escalating, rate-limited steps and optionally
# posts lifecycle, warning, alert, and recovery events to a webhook.
set -u

BASE_URL="http://127.0.0.1:8787"
INTERVAL_SECONDS="${AIPASS_WATCHDOG_INTERVAL_SECONDS:-30}"
STUCK_JOB_MS="${AIPASS_WATCHDOG_STUCK_JOB_MS:-960000}"
ALERT_COOLDOWN_SECONDS="${AIPASS_ALERT_COOLDOWN_SECONDS:-900}"
WEBHOOK_URL="${AIPASS_ALERT_WEBHOOK_URL:-}"
INCLUDE_INFO="${AIPASS_ALERT_INCLUDE_INFO:-1}"

failure_count=0
last_state="starting"
last_remote_key=""
last_remote_at=0
last_browser_restart_at=0
last_bridge_restart_at=0
seen_api_requests=-1
seen_auth_failures=-1
seen_upstream_failures=-1

now() { date +%s; }

post_alert() {
  local level="$1" title="$2" message="$3" key="$4" at payload endpoint
  [ -n "$WEBHOOK_URL" ] || return 0
  [ "$level" != "info" ] || [ "$INCLUDE_INFO" = "1" ] || return 0
  at=$(now)
  if [ -n "$key" ] && [ "$key" = "$last_remote_key" ] && [ $((at - last_remote_at)) -lt "$ALERT_COOLDOWN_SECONDS" ]; then return 0; fi

  # Discord's ordinary incoming-webhook endpoint uses {content, embeds}. The
  # old /slack URL is accepted too: strip its suffix so existing configuration
  # upgrades to the richer native Discord card automatically.
  endpoint="$WEBHOOK_URL"
  if [[ "$endpoint" =~ ^https://(discord\.com|discordapp\.com)/api/webhooks/ ]]; then
    endpoint="${endpoint%/slack}"
    payload=$(node -e '
      const [level, title, description] = process.argv.slice(1);
      const style = {
        info:    { color: 0x5865F2, icon: "ℹ️", label: "INFO" },
        warning: { color: 0xFEE75C, icon: "⚠️", label: "WARNING" },
        alert:   { color: 0xED4245, icon: "🚨", label: "ALERT" },
      }[level] ?? { color: 0x5865F2, icon: "ℹ️", label: "INFO" };
      process.stdout.write(JSON.stringify({
        username: "AiPass Bridge",
        allowed_mentions: { parse: [] },
        embeds: [{
          title: `${style.icon} ${title}`,
          description,
          color: style.color,
          fields: [
            { name: "Level", value: style.label, inline: true },
            { name: "Service", value: "AiPass Bridge", inline: true },
          ],
          footer: { text: "Watchdog monitoring" },
          timestamp: new Date().toISOString(),
        }],
      }));
    ' "$level" "$title" "$message")
  else
    payload=$(node -e 'process.stdout.write(JSON.stringify({ text: `[${process.argv[1].toUpperCase()}] ${process.argv[2]} — ${process.argv[3]}` }))' "$level" "$title" "$message")
  fi
  if curl --silent --show-error --max-time 10 --fail -X POST -H 'content-type: application/json' --data "$payload" "$endpoint" > /dev/null; then
    last_remote_key="$key"
    last_remote_at=$at
  else
    echo "[watchdog] webhook delivery failed for $title" >&2
  fi
}

emit() {
  local level="$1" title="$2" message="$3" key="${4:-}"
  echo "[watchdog] ${level^^}: $title — $message"
  post_alert "$level" "$title" "$message" "$key"
}

restart_browser_if_due() {
  local title="$1" message="$2" key="$3" at
  at=$(now)
  # Avoid an endless Chromium crash/restart loop if upstream authentication is
  # unavailable. Supervisor still restarts a browser process that exits.
  [ $((at - last_browser_restart_at)) -ge 300 ] || return 0
  emit warning "$title" "$message" "$key"
  curl --silent --show-error --max-time 10 -X POST "$BASE_URL/browser/restart" > /dev/null || true
  last_browser_restart_at=$at
}

restart_bridge_if_due() {
  local at
  at=$(now)
  [ $((at - last_bridge_restart_at)) -ge 300 ] || return 0
  emit warning "Restarting bridge" "The endpoint has failed ${failure_count} consecutive checks." "bridge_restart"
  supervisorctl restart bridge || true
  last_bridge_restart_at=$at
}

report_bridge_events() {
  local api_requests="$1" auth_failures="$2" upstream_failures="$3" new_requests
  # The first snapshot establishes a baseline. Afterwards every accepted API
  # request and every classified AiPASS failure becomes a local/webhook event.
  if [ "$seen_api_requests" -lt 0 ]; then
    seen_api_requests="$api_requests"
    seen_auth_failures="$auth_failures"
    seen_upstream_failures="$upstream_failures"
    return 0
  fi
  if [ "$api_requests" -gt "$seen_api_requests" ]; then
    new_requests=$((api_requests - seen_api_requests))
    emit info "API request received" "Received ${new_requests} API request(s); ${api_requests} accepted since the bridge started." "api_request_${api_requests}"
  fi
  if [ "$auth_failures" -gt "$seen_auth_failures" ]; then
    emit alert "AiPASS authentication required" "AiPASS rejected a request. Open noVNC, sign in or refresh the AiPASS chat tab, then retry." "aipass_auth_required"
  fi
  if [ "$upstream_failures" -gt "$seen_upstream_failures" ]; then
    emit alert "Cannot reach AiPASS" "The browser could not reach de.aipass.net or AiPASS returned a server error. The bridge will keep retrying new requests." "aipass_unreachable"
  fi
  seen_api_requests="$api_requests"
  seen_auth_failures="$auth_failures"
  seen_upstream_failures="$upstream_failures"
}

while true; do
  status=$(curl --silent --show-error --max-time 10 "$BASE_URL/status" 2>/dev/null || true)
  if [ -z "$status" ]; then
    if [ "$last_state" != "bridge_unavailable" ]; then
      failure_count=0
      emit alert "Bridge unavailable" "The local HTTP endpoint is not responding; Supervisor will attempt recovery." "bridge_unavailable"
      last_state="bridge_unavailable"
    fi
    failure_count=$((failure_count + 1))
    # Supervisor should already restart it; this covers a process that is alive
    # but no longer accepts connections.
    if [ "$failure_count" -ge 3 ]; then
      restart_bridge_if_due
    fi
    sleep "$INTERVAL_SECONDS"
    continue
  fi

  read -r extensions active_jobs oldest_idle_ms api_requests auth_failures upstream_failures < <(STATUS_JSON="$status" node -e '
    try {
      const s = JSON.parse(process.env.STATUS_JSON);
      console.log([Number(s.extensions) || 0, Number(s.activeJobs) || 0, Number(s.oldestJobIdleMs) || 0, Number(s.apiRequests) || 0, Number(s.authFailures) || 0, Number(s.upstreamFailures) || 0].join(" "));
    } catch { console.log("0 0 0 0 0 0"); }
  ')

  report_bridge_events "$api_requests" "$auth_failures" "$upstream_failures"

  if [ "$extensions" -lt 1 ]; then
    if [ "$last_state" != "extension_disconnected" ]; then
      failure_count=0
      emit alert "Extension disconnected" "No AiPASS extension is attached; recovery has started." "extension_disconnected"
      last_state="extension_disconnected"
    fi
    failure_count=$((failure_count + 1))
    # A stale service worker is cheap to reload once. With no client left, a
    # full Chromium restart is the only reliable way to load the extension anew.
    if [ "$failure_count" -eq 1 ]; then
      emit warning "Reloading extension" "No extension was attached on the first check." "extension_reload"
      curl --silent --show-error --max-time 10 -X POST "$BASE_URL/ext/reload" > /dev/null || true
    elif [ "$failure_count" -ge 3 ]; then
      restart_browser_if_due "Restarting browser" "The extension remains disconnected after ${failure_count} checks." "browser_restart_extension"
    fi
  elif [ "$active_jobs" -gt 0 ] && [ "$oldest_idle_ms" -ge "$STUCK_JOB_MS" ]; then
    if [ "$last_state" != "stuck_job" ]; then
      failure_count=0
      emit alert "Stuck upstream job" "A job has been silent for ${oldest_idle_ms} ms; recovery has started." "stuck_job"
      last_state="stuck_job"
    fi
    failure_count=$((failure_count + 1))
    if [ "$failure_count" -eq 1 ]; then
      emit warning "Reloading AiPASS tab" "Trying to restore the stalled page relay." "tab_reload"
      curl --silent --show-error --max-time 10 -X POST "$BASE_URL/tab/reload" > /dev/null || true
    elif [ "$failure_count" -ge 3 ]; then
      restart_browser_if_due "Restarting browser" "The upstream job remains stalled after ${failure_count} checks." "browser_restart_stuck_job"
    fi
  else
    if [ "$last_state" != "healthy" ]; then
      if [ "$last_state" = "starting" ]; then
        emit info "Bridge ready" "The bridge and AiPASS extension are connected and ready for requests." "bridge_ready"
      else
        emit info "Bridge recovered" "The bridge is healthy again with ${extensions} extension connection(s)." "bridge_recovered_$last_state"
      fi
      last_state="healthy"
    fi
    failure_count=0
  fi
  sleep "$INTERVAL_SECONDS"
done
