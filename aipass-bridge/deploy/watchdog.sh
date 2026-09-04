#!/bin/bash
# Repairs the browser relay in escalating, rate-limited steps and optionally
# posts lifecycle, warning, alert, and recovery events to a webhook.
set -u

BASE_URL="http://127.0.0.1:8787"
INTERVAL_SECONDS="${AIPASS_WATCHDOG_INTERVAL_SECONDS:-30}"
STUCK_JOB_MS="${AIPASS_WATCHDOG_STUCK_JOB_MS:-960000}"
ALERT_COOLDOWN_SECONDS="${AIPASS_ALERT_COOLDOWN_SECONDS:-900}"
USAGE_REPORT_SECONDS=3600
WEBHOOK_URL="${AIPASS_ALERT_WEBHOOK_URL:-}"
INCLUDE_INFO="${AIPASS_ALERT_INCLUDE_INFO:-1}"
API_KEY="${AIPASS_API_KEY:-}"

failure_count=0
last_state="starting"
last_remote_key=""
last_remote_at=0
last_browser_restart_at=0
last_bridge_restart_at=0
seen_api_requests=-1
last_reported_api_requests=-1
last_api_report_at=0
seen_auth_failures=-1
seen_upstream_failures=-1

now() { date +%s; }

# Management endpoints use the same API-key protection as client endpoints.
# Keep the key out of logs and centralize the curl behavior so a rejected
# recovery action is reported instead of being mistaken for success.
admin_post() {
  local path="$1"
  local args=(--silent --show-error --fail --max-time 10 -X POST)
  if [ -n "$API_KEY" ]; then args+=(-H "Authorization: Bearer $API_KEY"); fi
  curl "${args[@]}" "$BASE_URL$path" > /dev/null
}

# Supervisor starts all programs together. Give the Node listener a short
# chance to bind before classifying it as an outage; normally this completes
# on the first or second iteration.
for _ in {1..60}; do
  curl --silent --fail --max-time 2 "$BASE_URL/health" > /dev/null 2>&1 && break
  sleep 1
done

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
  if ! supervisorctl restart browser > /dev/null; then
    emit alert "Browser restart failed" "Supervisor could not restart Chromium." "browser_restart_failed"
  fi
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
  local api_requests="$1" api_requests_last_hour="$2" auth_failures="$3" upstream_failures="$4" at
  # The first snapshot establishes a baseline. Afterwards every accepted API
  # request contributes to an hourly summary. A quiet hour emits nothing.
  if [ "$seen_api_requests" -lt 0 ]; then
    seen_api_requests="$api_requests"
    last_reported_api_requests="$api_requests"
    seen_auth_failures="$auth_failures"
    seen_upstream_failures="$upstream_failures"
    return 0
  fi

  # The bridge counter resets with the bridge process. Start a fresh reporting
  # window instead of waiting for the new process to exceed the old total.
  if [ "$api_requests" -lt "$seen_api_requests" ]; then
    last_reported_api_requests="$api_requests"
    last_api_report_at=0
  fi

  if [ "$api_requests" -gt "$last_reported_api_requests" ]; then
    at=$(now)
    if [ "$last_api_report_at" -eq 0 ] || [ $((at - last_api_report_at)) -ge "$USAGE_REPORT_SECONDS" ]; then
      emit info "API request received" "Usage in the last hour: ${api_requests_last_hour} request(s). Cumulative usage since bridge startup: ${api_requests} request(s)." "api_usage"
      last_reported_api_requests="$api_requests"
      last_api_report_at=$at
    fi
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

  read -r extensions extension_connections active_jobs oldest_idle_ms api_requests api_requests_last_hour auth_failures upstream_failures < <(STATUS_JSON="$status" node -e '
    try {
      const s = JSON.parse(process.env.STATUS_JSON);
      console.log([Number(s.extensions) || 0, Number(s.extensionConnections) || 0, Number(s.activeJobs) || 0, Number(s.oldestJobIdleMs) || 0, Number(s.apiRequests) || 0, Number(s.apiRequestsLastHour) || 0, Number(s.authFailures) || 0, Number(s.upstreamFailures) || 0].join(" "));
    } catch { console.log("0 0 0 0 0 0 0 0"); }
  ')

  report_bridge_events "$api_requests" "$api_requests_last_hour" "$auth_failures" "$upstream_failures"

  if [ "$extensions" -lt 1 ]; then
    if [ "$last_state" != "extension_suspect" ] && [ "$last_state" != "extension_disconnected" ]; then
      failure_count=0
      last_state="extension_suspect"
    fi
    failure_count=$((failure_count + 1))
    # A planned four-minute SSE renewal normally reconnects in under a second.
    # One missed poll is therefore noise; recovery begins only if two
    # consecutive 30-second checks see no usable worker.
    if [ "$failure_count" -eq 2 ]; then
      emit alert "Extension disconnected" "No AiPASS extension is attached; recovery has started." "extension_disconnected"
      last_state="extension_disconnected"
      if [ "$extension_connections" -gt 0 ]; then
        emit warning "Reloading extension" "The extension is connected but its AiPASS tab did not become ready after two checks." "extension_reload"
        admin_post "/ext/reload" || emit alert "Extension reload failed" "The bridge rejected or could not perform the extension reload." "extension_reload_failed"
      fi
    elif [ "$failure_count" -ge 4 ]; then
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
      admin_post "/tab/reload" || emit alert "Tab reload failed" "The bridge rejected or could not perform the AiPASS tab reload." "tab_reload_failed"
    elif [ "$failure_count" -ge 3 ]; then
      restart_browser_if_due "Restarting browser" "The upstream job remains stalled after ${failure_count} checks." "browser_restart_stuck_job"
    fi
  else
    # A single failed poll is expected during the extension's planned SSE
    # renewal and should not produce a recovery notification either.
    if [ "$last_state" = "extension_suspect" ]; then
      last_state="healthy"
      failure_count=0
      sleep "$INTERVAL_SECONDS"
      continue
    fi
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
