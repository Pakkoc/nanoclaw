#!/bin/bash
# create-diary.sh — 사용자의 기숙사에 다이어리 채널을 만들고 권한까지 설정
#
# 사용법:
#   bash create-diary.sh <user_id> <ticket_channel_id>

# set -euo pipefail 의도적으로 제거 — 각 단계를 명시적으로 처리

GUILD_ID="1213133289498615818"
API_BASE="https://discord.com/api/v10"
ADMIN_CHANNEL="1489283292489449585"
LOG_FILE="/tmp/diary-create-$$.log"

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

# 로그 함수
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

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
  local payload response

  payload=$(python3 -c "import json,sys; print(json.dumps({'content': sys.argv[1]}))" "$content")
  if [ $? -ne 0 ] || [ -z "$payload" ]; then
    log "ERROR: send_message payload 생성 실패 (channel=$channel_id)"
    return 1
  fi

  response=$(api_post "/channels/$channel_id/messages" "$payload")
  if echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('id') else 1)" 2>/dev/null; then
    log "send_message OK → channel=$channel_id"
    return 0
  else
    log "ERROR: send_message 실패 → channel=$channel_id response=${response:0:200}"
    return 1
  fi
}

# ─── 완료 추적 변수 ───────────────────────────────────────────────────
COMPLETE_MSG_SENT=0
NEW_CHANNEL_ID=""

# EXIT trap — 완료 메시지가 전송되지 않았으면 관리자 채널에 알림 (방안 B)
cleanup() {
  local exit_code=$?
  if [ "$COMPLETE_MSG_SENT" -eq 0 ]; then
    log "WARNING: 완료 메시지 미전송 감지 (exit_code=$exit_code) — 관리자 채널 알림"
    local alert="⚠️ 다이어리 생성 완료 메시지 미전송\n티켓 채널: <#${TICKET_CHANNEL_ID}>"
    if [ -n "$NEW_CHANNEL_ID" ]; then
      alert="${alert}\n생성된 채널: <#${NEW_CHANNEL_ID}>"
    fi
    alert="${alert}\n로그: $LOG_FILE"
    send_message "$ADMIN_CHANNEL" "$(printf '%b' "$alert")" || true
  fi
  log "=== 스크립트 종료 (exit=$exit_code) ==="
}
trap cleanup EXIT

log "=== diary-create 시작: user=$USER_ID ticket=$TICKET_CHANNEL_ID ==="

# ─── 1단계: 대기 메시지 ───────────────────────────────────────────────
log "[1/9] 대기 메시지 발송..."
send_message "$TICKET_CHANNEL_ID" "잠시만 기다려주세요! 💛" || log "WARNING: 대기 메시지 발송 실패 — 계속 진행"

# ─── 2단계: 사용자 정보 조회 ──────────────────────────────────────────
log "[2/9] 사용자 정보 조회..."
MEMBER_JSON=$(api_get "/guilds/$GUILD_ID/members/$USER_ID")

USER_ROLES=$(echo "$MEMBER_JSON" | python3 -c "import json,sys; m=json.load(sys.stdin); print(' '.join(m.get('roles', [])))" 2>/dev/null || echo "")

USER_NICK=$(echo "$MEMBER_JSON" | python3 -c "
import json, sys
m = json.load(sys.stdin)
nick = m.get('nick') or (m.get('user') or {}).get('global_name') or (m.get('user') or {}).get('username') or ''
print(nick)
" 2>/dev/null || echo "")

if [ -z "$USER_NICK" ]; then
  log "ERROR: 사용자 정보 조회 실패"
  send_message "$TICKET_CHANNEL_ID" "사용자 정보를 가져올 수 없어요. 관리자에게 문의해주세요!" || true
  COMPLETE_MSG_SENT=1  # 오류 안내 메시지를 보냈으므로 관리자 알림 불필요
  exit 1
fi

log "사용자 닉네임: $USER_NICK"

# ─── 기숙사 역할 매칭 ─────────────────────────────────────────────────
DORM_ROLE_ID=""
for role_id in $USER_ROLES; do
  if [ -n "${DORM_CATEGORY[$role_id]:-}" ]; then
    DORM_ROLE_ID="$role_id"
    break
  fi
done

if [ -z "$DORM_ROLE_ID" ]; then
  log "ERROR: 기숙사 역할 없음"
  send_message "$TICKET_CHANNEL_ID" "기숙사 역할이 없어서 다이어리를 만들 수 없어요. 관리자에게 문의해주세요!" || true
  COMPLETE_MSG_SENT=1
  exit 1
fi

CATEGORY_ID="${DORM_CATEGORY[$DORM_ROLE_ID]}"
DORM_LABEL="${DORM_NAME[$DORM_ROLE_ID]}"
log "[3/9] 기숙사 매칭: $DORM_LABEL ($DORM_ROLE_ID) → 카테고리 $CATEGORY_ID"

# ─── 채널명 생성 ──────────────────────────────────────────────────────
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
" 2>/dev/null || echo "diary")

log "[4/9] 채널명: $CHANNEL_NAME"

# ─── 5단계: 채널 생성 ─────────────────────────────────────────────────
log "[5/9] 다이어리 채널 생성..."
CREATE_PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
    'name': sys.argv[1],
    'type': 0,
    'parent_id': sys.argv[2]
}))
" "$CHANNEL_NAME" "$CATEGORY_ID")

CREATE_RESPONSE=$(api_post "/guilds/$GUILD_ID/channels" "$CREATE_PAYLOAD")
NEW_CHANNEL_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

if [ -z "$NEW_CHANNEL_ID" ]; then
  log "ERROR: 채널 생성 실패: ${CREATE_RESPONSE:0:200}"
  send_message "$TICKET_CHANNEL_ID" "채널 생성에 실패했어요. 관리자에게 문의해주세요!" || true
  COMPLETE_MSG_SENT=1
  exit 1
fi

log "[6/9] 채널 생성됨: $NEW_CHANNEL_ID"

# ─── 7단계: 권한 설정 ─────────────────────────────────────────────────
log "[7/9] 권한 설정..."
# allow: VIEW_CHANNEL(1024) + SEND_MESSAGES(2048) + MANAGE_MESSAGES(8192) = 11264
# deny: MANAGE_CHANNELS(16)
PERM_PAYLOAD='{"allow":"11264","deny":"16","type":1}'
api_put "/channels/$NEW_CHANNEL_ID/permissions/$USER_ID" "$PERM_PAYLOAD" > /dev/null || log "WARNING: 권한 설정 실패 — 계속 진행"

send_message "$NEW_CHANNEL_ID" "<@$USER_ID>" || log "WARNING: 채널 내 멘션 실패 — 계속 진행"

# ─── 8단계: NanoClaw 그룹 등록 및 CLAUDE.md 생성 ─────────────────────
log "[8/9] NanoClaw 그룹 등록 및 CLAUDE.md 생성..."
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
" "$NEW_CHANNEL_ID" "$CHANNEL_NAME" || log "WARNING: 그룹 등록 실패 (이미 등록됐거나 권한 문제) — 계속 진행"

TEMPLATE_CLAUDE="/workspace/project/groups/diaries/discord_diary_ch1472986187294703726/CLAUDE.md"
TARGET_DIR="/workspace/project/groups/diaries/discord_diary_ch${NEW_CHANNEL_ID}"
mkdir -p "$TARGET_DIR" || log "WARNING: 디렉토리 생성 실패 — 계속 진행"
if [ -f "$TEMPLATE_CLAUDE" ]; then
  cp "$TEMPLATE_CLAUDE" "$TARGET_DIR/CLAUDE.md" \
    && log "CLAUDE.md 생성 완료: $TARGET_DIR" \
    || log "WARNING: CLAUDE.md 복사 실패 — 계속 진행"
else
  log "WARNING: 템플릿 CLAUDE.md 없음, 건너뜀"
fi

# ─── 9단계: 완료 메시지 ───────────────────────────────────────────────
log "[9/9] 완료 메시지 발송..."
COMPLETE_MSG="다 만들어졌습니다! 🎉
# <#$NEW_CHANNEL_ID>
열공하세요!"

if send_message "$TICKET_CHANNEL_ID" "$COMPLETE_MSG"; then
  COMPLETE_MSG_SENT=1
  log "✅ 다이어리 생성 완료: $CHANNEL_NAME ($NEW_CHANNEL_ID)"
else
  log "ERROR: 완료 메시지 발송 실패 — EXIT trap에서 관리자 알림 전송 예정"
fi
