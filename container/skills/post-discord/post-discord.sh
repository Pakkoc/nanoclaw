#!/bin/bash
# post-discord.sh — Discord 임의 채널에 메시지 게시
#
# 사용법:
#   bash post-discord.sh <CHANNEL_ID> < message.txt
#   bash post-discord.sh <CHANNEL_ID> <<'EOM'
#   여러 줄 본문...
#   EOM

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <channel_id>  (body via stdin)" >&2
  exit 2
fi

CHANNEL_ID="$1"
API_BASE="https://discord.com/api/v10"

TOOLS_ENV="/workspace/global/tools.env"
if [ -z "${DISCORD_BOT_TOKEN:-}" ] && [ -f "$TOOLS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$TOOLS_ENV"
  set +a
fi

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "ERROR: DISCORD_BOT_TOKEN not found ($TOOLS_ENV 확인)" >&2
  exit 1
fi

BODY=$(cat)

if [ -z "$BODY" ]; then
  echo "ERROR: empty body (provide message via stdin)" >&2
  exit 2
fi

if [ ${#BODY} -gt 2000 ]; then
  echo "ERROR: body is ${#BODY} chars, Discord limit is 2000. Split before calling." >&2
  exit 3
fi

PAYLOAD=$(BODY="$BODY" python3 -c '
import json, os, sys
print(json.dumps({"content": os.environ["BODY"]}))
')

RESPONSE=$(curl -sS -w "\n%{http_code}" \
  -X POST \
  "${API_BASE}/channels/${CHANNEL_ID}/messages" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: NanoClaw-Bot (https://nanoclaw.ai, 1.0)" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "$BODY_RESPONSE" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(f"OK message_id={d.get(\"id\")} channel_id={d.get(\"channel_id\")} length={len(d.get(\"content\",\"\"))}")
except Exception:
    print(sys.stdin.read())
'
  exit 0
else
  echo "ERROR HTTP $HTTP_CODE" >&2
  echo "$BODY_RESPONSE" >&2
  exit 1
fi
