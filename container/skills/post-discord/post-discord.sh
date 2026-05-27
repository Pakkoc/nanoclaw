#!/bin/bash
# post-discord.sh — Discord 임의 채널에 메시지 게시
#
# 사용법:
#   bash post-discord.sh <CHANNEL_ID> < message.txt
#   bash post-discord.sh <CHANNEL_ID> <<'EOM'
#   여러 줄 본문...
#   EOM

set -euo pipefail

# discord_diary 그룹에서는 외부 채널 메시지 전송 완전 차단.
# NANOCLAW_GROUP_FOLDER는 MCP 서버 환경에만 있고 bash에는 없으므로
# agent-runner가 시작 시 /workspace/group/.nanoclaw-group에 기록한 값을 읽는다.
_NANOCLAW_GROUP=$(cat /workspace/group/.nanoclaw-group 2>/dev/null || echo "${NANOCLAW_GROUP_FOLDER:-}")
if [[ "$_NANOCLAW_GROUP" == discord_diary* ]]; then
  echo "ERROR: post-discord is disabled in diary channels." >&2
  exit 1
fi

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
    mid = d.get("id")
    cid = d.get("channel_id")
    clen = len(d.get("content", ""))
    print("OK message_id={} channel_id={} length={}".format(mid, cid, clen))
except Exception:
    print(sys.stdin.read())
'
  exit 0
else
  echo "ERROR HTTP $HTTP_CODE" >&2
  echo "$BODY_RESPONSE" >&2
  exit 1
fi
