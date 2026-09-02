#!/bin/bash
set -e

echo "⏳ [start-browser] Waiting for Xvfb display :99..."
for i in {1..30}; do
    if [ -e /tmp/.X11-unix/X99 ]; then
        echo "✅ [start-browser] Xvfb display :99 is ready."
        break
    fi
    sleep 0.5
done

echo "⏳ [start-browser] Waiting for Bridge Server on 127.0.0.1:8787..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:8787/status > /dev/null 2>&1; then
        echo "✅ [start-browser] Bridge Server is ready."
        break
    fi
    sleep 0.5
done

# Clean up any stale Singleton lock files and sockets from previous container runs
echo "🧹 [start-browser] Cleaning up stale locks and profile crash flags..."
rm -f /app/chrome-data/Singleton* \
      /app/chrome-data/Default/Singleton* \
      /app/chrome-data/Default/.org.chromium.Chromium.* \
      /tmp/.org.chromium.Chromium.* \
      /tmp/Singleton* 2>/dev/null || true

# Select Browser Binary (Chromium supports --load-extension)
if [ -x "/usr/bin/chromium" ]; then
    BROWSER_BIN="/usr/bin/chromium"
elif [ -x "/usr/bin/chromium-browser" ]; then
    BROWSER_BIN="/usr/bin/chromium-browser"
elif [ -x "/usr/bin/google-chrome-stable" ]; then
    BROWSER_BIN="/usr/bin/google-chrome-stable"
else
    BROWSER_BIN="chromium"
fi

# Prepare Chrome/Chromium profile directory and suppress crash bubbles
mkdir -p /app/chrome-data/Default
PREF_FILE="/app/chrome-data/Default/Preferences"
if [ -f "$PREF_FILE" ]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g' "$PREF_FILE" 2>/dev/null || true
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/g' "$PREF_FILE" 2>/dev/null || true
fi

echo "🚀 [start-browser] Launching $BROWSER_BIN with Extension (/app/extension)..."

exec "$BROWSER_BIN" \
    --no-sandbox \
    --test-type \
    --disable-dev-shm-usage \
    --disable-gpu \
    --disable-software-rasterizer \
    --no-first-run \
    --no-default-browser-check \
    --disable-fre \
    --password-store=basic \
    --use-mock-keychain \
    --disable-component-update \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --load-extension=/app/extension \
    --disable-extensions-except=/app/extension \
    --user-data-dir=/app/chrome-data \
    --window-size=1280,800 \
    --window-position=0,0 \
    --start-maximized \
    --remote-debugging-port=9222 \
    --remote-debugging-address=0.0.0.0 \
    --remote-allow-origins=* \
    "https://de.aipass.net/chat"
