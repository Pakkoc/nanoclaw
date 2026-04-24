#!/bin/bash
# create-diary.sh — 사용자의 기숙사에 다이어리 채널을 만들고 권한까지 설정
#
# 사용법:
#   bash create-diary.sh <user_id> <ticket_channel_id>

set -euo pipefail

GUILD_ID="1213133289498615818"
API_BASE="https://discord.com/api/v10"

declare -A DORM_CATEGORY=(
  [1231209049387831437]=1236979261529657426  # 소용돌이 → 🩷 소용돌이 기숙사
  [1231208875277946930]=1236979345529114664  # 노블레빗 → 💜 노블레빗 기숙사
  [1231209175388782592]=1236979439879848028  # 볼리베어 → 🩵 볼리베어 기숙사
  [1386636849291857971]=1386697214910529687  # 펭도리야 → 🩶 펭도리야 기숙사
)

declare -A DORM_NAME=(
  [1231209049387831437]="소용돌이"
  [1231208875277946930]="노블레빗"
  [1231209175388782592]="볼리베어"
  [1386636849291857971]="펭도리야"
)

if [ $# -lt 2 ]; then
  echo "Usage: $0 <user_id> <ticket_channel_id>" >&2
  exit 1
fi

USER_ID="$1"
TICKET_CHANNEL_ID="$2"

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

api_get() {
  curl -s -X GET \
    "${API_BASE}$1" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)"
}

api_post() {
  curl -s -X POST \
    "${API_BASE}$1" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)" \
    -d "$2"
}

api_put() {
  curl -s -X PUT \
    "${API_BASE}$1" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)" \
    -d "$2"
}

send_message() {
  local channel_id="$1"
  local content="$2"
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'content': sys.argv[1]}))" "$content")
  api_post "/channels/$channel_id/messages" "$payload" > /dev/null
}

echo "[1/8] 대기 메시지 발송..."
send_message "$TICKET_CHANNEL_ID" "잠시만 기다려주세요! 💛"

echo "[2/8] 사용자 정보 조회..."
MEMBER_JSON=$(api_get "/guilds/$GUILD_ID/members/$USER_ID")

USER_ROLES=$(echo "$MEMBER_JSON" | python3 -c "import json,sys; m=json.load(sys.stdin); print(' '.join(m.get('roles', [])))")

USER_NICK=$(echo "$MEMBER_JSON" | python3 -c "
import json, sys
m = json.load(sys.stdin)
nick = m.get('nick') or (m.get('user') or {}).get('global_name') or (m.get('user') or {}).get('username') or ''
print(nick)
")

if [ -z "$USER_NICK" ]; then
  send_message "$TICKET_CHANNEL_ID" "사용자 정보를 가져올 수 없어요. 관리자에게 문의해주세요!"
  exit 1
fi

DORM_ROLE_ID=""
for role_id in $USER_ROLES; do
  if [ -n "${DORM_CATEGORY[$role_id]:-}" ]; then
    DORM_ROLE_ID="$role_id"
    break
  fi
done

if [ -z "$DORM_ROLE_ID" ]; then
  send_message "$TICKET_CHANNEL_ID" "기숙사 역할이 없어서 다이어리를 만들 수 없어요. 관리자에게 문의해주세요!"
  exit 1
fi

CATEGORY_ID="${DORM_CATEGORY[$DORM_ROLE_ID]}"
DORM_LABEL="${DORM_NAME[$DORM_ROLE_ID]}"
echo "[3/8] 기숙사 매칭: $DORM_LABEL ($DORM_ROLE_ID) → 카테고리 $CATEGORY_ID"

CHANNEL_NAME=$(echo "$USER_NICK" | python3 -c "
import sys, re
nick = sys.stdin.read().strip()
nick = re.sub(r'\[[^\]]*\]', '', nick)
nick = nick.strip()
nick = re.sub(r'\s+', '-', nick)
nick = nick[:100]
if not nick:
    nick = 'diary'
print(nick)
")

echo "[4/8] 채널명: $CHANNEL_NAME"

echo "[5/8] 다이어리 채널 생성..."
CREATE_PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
    'name': sys.argv[1],
    'type': 0,
    'parent_id': sys.argv[2]
}))
" "$CHANNEL_NAME" "$CATEGORY_ID")

CREATE_RESPONSE=$(api_post "/guilds/$GUILD_ID/channels" "$CREATE_PAYLOAD")
NEW_CHANNEL_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))")

if [ -z "$NEW_CHANNEL_ID" ]; then
  echo "ERROR: 채널 생성 실패: $CREATE_RESPONSE" >&2
  send_message "$TICKET_CHANNEL_ID" "채널 생성에 실패했어요. 관리자에게 문의해주세요!"
  exit 1
fi

echo "[6/8] 채널 생성됨: $NEW_CHANNEL_ID"

echo "[7/8] 권한 설정..."
# allow: VIEW_CHANNEL(1024) + SEND_MESSAGES(2048) + MANAGE_MESSAGES(8192) = 11264
# deny: MANAGE_CHANNELS(16)
PERM_PAYLOAD='{"allow":"11264","deny":"16","type":1}'
api_put "/channels/$NEW_CHANNEL_ID/permissions/$USER_ID" "$PERM_PAYLOAD" > /dev/null

send_message "$NEW_CHANNEL_ID" "<@$USER_ID>"

echo "[8/9] NanoClaw 그룹 등록 및 CLAUDE.md 생성..."
node -e "
const Database = require('/workspace/project/node_modules/better-sqlite3');
const db = new Database('/workspace/project/store/messages.db');
const now = new Date().toISOString();
db.prepare(\`
  INSERT OR IGNORE INTO registered_groups
  (jid, name, folder, trigger_pattern, requires_trigger, added_at)
  VALUES (?, ?, ?, ?, 1, ?)
\`).run(
  'dc:' + process.argv[1],
  '기숙사 다이어리 #' + process.argv[2],
  'diaries/discord_diary_ch' + process.argv[1],
  '@부엉이',
  now
);
console.log('등록 완료: dc:' + process.argv[1]);
" "$NEW_CHANNEL_ID" "$CHANNEL_NAME"

TEMPLATE_CLAUDE="/workspace/project/groups/diaries/discord_diary_ch1472986187294703726/CLAUDE.md"
TARGET_DIR="/workspace/project/groups/diaries/discord_diary_ch${NEW_CHANNEL_ID}"
mkdir -p "$TARGET_DIR"
if [ -f "$TEMPLATE_CLAUDE" ]; then
  cp "$TEMPLATE_CLAUDE" "$TARGET_DIR/CLAUDE.md"
  echo "CLAUDE.md 생성 완료: $TARGET_DIR"
else
  echo "WARNING: 템플릿 CLAUDE.md 없음, 건너뜀" >&2
fi

echo "[9/9] 완료 메시지 발송..."
COMPLETE_MSG="다 만들어졌습니다! 🎉
# <#$NEW_CHANNEL_ID>
열공하세요!"
send_message "$TICKET_CHANNEL_ID" "$COMPLETE_MSG"

echo "✅ 다이어리 생성 완료: $CHANNEL_NAME ($NEW_CHANNEL_ID)"
