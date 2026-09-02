#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "============================================================"
echo "          🔄 aipass-bridge: Rebuild & Start                 "
echo "============================================================"

# Handle --clean flag
if [ "$1" == "--clean" ]; then
    echo "🧹 [Clean Mode] Stopping containers and resetting Chrome profile..."
    sudo docker compose down -v 2>/dev/null || true
    sudo rm -rf chrome-data/*
else
    echo "🔄 Stopping existing containers..."
    sudo docker compose down 2>/dev/null || true
fi

# Ensure directories and scripts have proper permissions and stale locks are cleared
mkdir -p chrome-data extension bridge
sudo rm -f chrome-data/Singleton* chrome-data/Default/Singleton* 2>/dev/null || true
chmod -R 777 chrome-data 2>/dev/null || true
chmod +x start-browser.sh start-vnc.sh reset.sh test.sh 2>/dev/null || true

echo "🔨 Building Docker image and launching container..."
sudo docker compose up -d --build --force-recreate

echo ""
echo "⏳ Waiting for services to initialize (5s)..."
sleep 5

echo "🔍 Bridge Server Status:"
curl -s http://localhost:8787/status || echo "Starting up..."

echo ""
echo "============================================================"
echo "🎉 aipass-bridge is running!"
echo "👉 1. Open noVNC: http://<YOUR-SERVER-IP>:6080"
if [ -f .env ] && grep -qE '^(noVNC_PASSWORD|NOVNC_PASSWORD)=.+' .env; then
    echo "   🔒 Password protection is active (configured in .env)"
fi
echo "👉 2. Log in to https://de.aipass.net/chat in the Chrome window"
echo "👉 3. Run ./test.sh to verify end-to-end connection"
echo "============================================================"
