#!/bin/bash
set -e

# Wait for Xvfb display :99
for i in {1..30}; do
    if [ -e /tmp/.X11-unix/X99 ]; then
        break
    fi
    sleep 0.5
done

# Read password from environment or /app/.env
VNC_PASS="${noVNC_PASSWORD:-${NOVNC_PASSWORD:-}}"

if [ -z "$VNC_PASS" ] && [ -f "/app/.env" ]; then
    # Extract noVNC_PASSWORD or NOVNC_PASSWORD from .env
    VNC_PASS=$(grep -E '^(noVNC_PASSWORD|NOVNC_PASSWORD)=' /app/.env | head -n 1 | cut -d '=' -f2-)
fi

# Trim whitespace and surrounding quotes
VNC_PASS=$(echo "$VNC_PASS" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'"'"']//' -e 's/["'"'"']$//')

if [ -n "$VNC_PASS" ]; then
    echo "🔒 [start-vnc] Password protection ENABLED for noVNC/x11vnc."
    PASS_FILE="/tmp/.x11vnc_pass"
    printf "%s\n" "$VNC_PASS" > "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    exec x11vnc -display :99 -forever -shared -rfbport 5900 -passwdfile "$PASS_FILE"
else
    echo "⚠️ [start-vnc] No password set (noVNC_PASSWORD is empty). Running with -nopw."
    exec x11vnc -display :99 -forever -nopw -shared -rfbport 5900
fi
