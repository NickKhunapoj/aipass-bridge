#!/bin/bash

BASE_URL="http://localhost:8787"

echo "============================================================"
echo "           🚀 aipass-bridge Diagnostics & Test              "
echo "============================================================"

echo ""
echo "🔍 1. Checking Bridge Server Status..."
STATUS=$(curl -s "${BASE_URL}/status" || curl -s "${BASE_URL}/health")
echo "$STATUS"

EXT_COUNT=$(echo "$STATUS" | grep -o '"extensions":[0-9]*' | cut -d':' -f2)

if [ "$EXT_COUNT" = "1" ] || [ "$EXT_COUNT" -gt 0 ] 2>/dev/null; then
    echo "🟢 ✅ Extension connected! (extensions = $EXT_COUNT)"
else
    echo "🟡 ⚠️ Warning: extensions = ${EXT_COUNT:-0} (Extension not connected yet)"
    echo "👉 Ensure Chrome is open on https://de.aipass.net/chat in noVNC (http://<IP>:6080)"
fi

echo ""
echo "📋 2. Testing Models Endpoint (/v1/models)..."
MODELS_RESP=$(curl -s "${BASE_URL}/v1/models")
if command -v jq >/dev/null 2>&1; then
    echo "$MODELS_RESP" | jq .
else
    echo "$MODELS_RESP"
fi

echo ""
echo "💬 3. Testing Chat Completion (gemini-3.1-flash-lite)..."
CHAT_RESP=$(curl -s -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-lite",
    "messages": [
      {"role": "user", "content": "สวัสดี ตอบสั้นๆ 1 ประโยคว่าระบบพร้อมทำงาน"}
    ]
  }')

if command -v jq >/dev/null 2>&1; then
    echo "$CHAT_RESP" | jq .
else
    echo "$CHAT_RESP"
fi

echo ""
echo "🖼️ 4. Testing Multimodal Vision (test-vision.py)..."
if [ -f "test-vision.py" ]; then
    if [ -f "test_real.png" ]; then
        python3 test-vision.py test_real.png --model "gemini-3.1-flash-lite"
    else
        python3 test-vision.py --model "gemini-3.1-flash-lite"
    fi
else
    echo "ℹ️ test-vision.py not found, skipping vision test."
fi

echo ""
echo "============================================================"
