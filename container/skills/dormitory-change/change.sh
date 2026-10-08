#!/bin/bash
# change.sh — 기숙사 변경 스크립트
#
# 사용법:
#   bash change.sh <user_id> <to_dorm> <ticket_channel_id>
#
# to_dorm: 노블레빗 | 볼리베어 | 소용돌이 | 펭도리야
#
# 처리 순서:
#   1. 기숙사 변경 이력 확인 (1회만 허용)
#   2. 현재 기숙사 역할 제거
#   3. 새 기숙사 역할 부여
#   4. 기존 다이어리 채널 → 새 기숙사 카테고리로 이동
#      (다이어리 없으면 diary-create 스크립트 호출)
#   5. 티켓 채널 완료 메시지 발송

GUILD_ID="1213133289498615818"
API_BASE="https://discord.com/api/v10"
ADMIN_CHANNEL="1489283292489449585"
DORMITORY_CHANGE_CHANNEL="1514124242952781854"  # 🏘️ 기숙사 변경 문의

if [ $# -lt 3 ]; then
  echo "Usage: $0 <user_id> <to_dorm> <ticket_channel_id>" >&2
  echo "  to_dorm: 노블레빗 | 볼리베어 | 소용돌이 | 펭도리야" >&2
  exit 1
fi

USER_ID="$1"
TO_DORM="$2"
TICKET_CHANNEL_ID="$3"

TOOLS_ENV="/workspace/global/tools.env"
if [ -z "${DISCORD_BOT_TOKEN:-}" ] && [ -f "$TOOLS_ENV" ]; then
  set -a
  source "$TOOLS_ENV"
  set +a
fi

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "ERROR: DISCORD_BOT_TOKEN not found" >&2
  exit 1
fi

LOG_FILE="/tmp/dormitory-change-$$.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

api_get() {
  curl -s -X GET "${API_BASE}$1" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)"
}

api_post() {
  curl -s -X POST "${API_BASE}$1" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)" \
    -d "$2"
}

api_put() {
  curl -s -X PUT "${API_BASE}$1" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)" \
    -d "${2:-{}}"
}

api_delete() {
  curl -s -X DELETE "${API_BASE}$1" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)"
}

api_patch() {
  curl -s -X PATCH "${API_BASE}$1" \
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
  local response
  response=$(api_post "/channels/$channel_id/messages" "$payload")
  if echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('id') else 1)" 2>/dev/null; then
    log "send_message OK → channel=$channel_id"
    return 0
  else
    log "ERROR: send_message 실패 → ${response:0:200}"
    return 1
  fi
}

# ─── 기숙사 역할/카테고리 매핑 ───────────────────────────────────────
declare -A DORM_ROLE=(
  ["소용돌이"]="1231209049387831437"
  ["노블레빗"]="1231208875277946930"
  ["볼리베어"]="1231209175388782592"
  ["펭도리야"]="1386636849291857971"
)

declare -A DORM_CATEGORY=(
  ["소용돌이"]="1236979261529657426"
  ["노블레빗"]="1236979345529114664"
  ["볼리베어"]="1236979439879848028"
  ["펭도리야"]="1386697214910529687"
)

declare -A DORM_EMOJI=(
  ["소용돌이"]="🦋"
  ["노블레빗"]="🐇"
  ["볼리베어"]="🐻‍❄️"
  ["펭도리야"]="🐧"
)

ALL_DORM_ROLE_IDS="1231209049387831437 1231208875277946930 1231209175388782592 1386636849291857971"
ACTIVE_DORM_CATS="1236979261529657426 1236979345529114664 1236979439879848028 1386697214910529687"

log "=== dormitory-change 시작: user=$USER_ID to=$TO_DORM ticket=$TICKET_CHANNEL_ID ==="

# ─── 입력 검증 ───────────────────────────────────────────────────────
TO_ROLE="${DORM_ROLE[$TO_DORM]:-}"
TO_CATEGORY="${DORM_CATEGORY[$TO_DORM]:-}"
TO_EMOJI="${DORM_EMOJI[$TO_DORM]:-}"

if [ -z "$TO_ROLE" ]; then
  log "ERROR: 알 수 없는 기숙사: $TO_DORM"
  send_message "$TICKET_CHANNEL_ID" "알 수 없는 기숙사 이름이에요: $TO_DORM (노블레빗 | 볼리베어 | 소용돌이 | 펭도리야)" || true
  exit 1
fi

# ─── 1단계: 기숙사 변경 이력 확인 ───────────────────────────────────
log "[1/5] 기숙사 변경 이력 확인..."
HISTORY=$(api_get "/channels/$DORMITORY_CHANGE_CHANNEL/messages?limit=100" \
  | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
user_id = '$USER_ID'
found = []
for m in msgs:
    if user_id in m.get('content', '') or user_id in str(m.get('mentions', [])):
        found.append(m['timestamp'][:16] + ' | ' + m['content'][:150])
for f in found:
    print(f)
" 2>/dev/null || echo "")

if [ -n "$HISTORY" ]; then
  log "기숙사 변경 이력 있음: $HISTORY"
  send_message "$TICKET_CHANNEL_ID" "기숙사 변경은 1회만 가능해요. 이미 변경 이력이 있어서 처리가 어려워요 🥲 관리자분께 문의해주세요!" || true
  exit 1
fi

log "변경 이력 없음 — 진행 가능"

# ─── 사용자 정보 조회 ─────────────────────────────────────────────
MEMBER_JSON=$(api_get "/guilds/$GUILD_ID/members/$USER_ID")
USER_NICK=$(echo "$MEMBER_JSON" | python3 -c "
import json, sys
m = json.load(sys.stdin)
nick = m.get('nick') or (m.get('user') or {}).get('global_name') or (m.get('user') or {}).get('username') or ''
print(nick)
" 2>/dev/null || echo "")
USER_ROLES=$(echo "$MEMBER_JSON" | python3 -c "
import json, sys
m = json.load(sys.stdin)
print(' '.join(m.get('roles', [])))
" 2>/dev/null || echo "")

if [ -z "$USER_NICK" ]; then
  log "ERROR: 사용자 정보 조회 실패"
  send_message "$TICKET_CHANNEL_ID" "사용자 정보를 가져오지 못했어요. 관리자에게 문의해주세요!" || true
  exit 1
fi

log "사용자: $USER_NICK | 현재 역할: $USER_ROLES"

# ─── 현재 기숙사 역할 파악 ─────────────────────────────────────────
FROM_ROLE=""
FROM_DORM=""
for role_id in $ALL_DORM_ROLE_IDS; do
  if echo "$USER_ROLES" | grep -qw "$role_id"; then
    FROM_ROLE="$role_id"
    # 역할 ID로 이름 역매핑
    for dorm_name in "${!DORM_ROLE[@]}"; do
      if [ "${DORM_ROLE[$dorm_name]}" = "$role_id" ]; then
        FROM_DORM="$dorm_name"
        break
      fi
    done
    break
  fi
done

if [ -z "$FROM_ROLE" ]; then
  log "WARNING: 현재 기숙사 역할 없음 — 역할 부여만 진행"
fi

if [ "$FROM_ROLE" = "$TO_ROLE" ]; then
  log "이미 $TO_DORM 기숙사"
  send_message "$TICKET_CHANNEL_ID" "이미 ${TO_DORM} ${TO_EMOJI} 기숙사 소속이에요! 🦉" || true
  exit 0
fi

# ─── 2단계: 기존 기숙사 역할 제거 ───────────────────────────────────
log "[2/5] 기존 기숙사 역할 제거: $FROM_DORM ($FROM_ROLE)"
if [ -n "$FROM_ROLE" ]; then
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)" \
    "${API_BASE}/guilds/$GUILD_ID/members/$USER_ID/roles/$FROM_ROLE")
  if [ "$HTTP" = "204" ]; then
    log "역할 제거 완료: $FROM_DORM"
  else
    log "WARNING: 역할 제거 실패 (HTTP $HTTP) — 계속 진행"
  fi
fi

# ─── 3단계: 새 기숙사 역할 부여 ─────────────────────────────────────
log "[3/5] 새 기숙사 역할 부여: $TO_DORM ($TO_ROLE)"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "User-Agent: DiscordBot (https://nanoclaw.ai, 1.0)" \
  "${API_BASE}/guilds/$GUILD_ID/members/$USER_ID/roles/$TO_ROLE")
if [ "$HTTP" = "204" ]; then
  log "역할 부여 완료: $TO_DORM"
else
  log "ERROR: 역할 부여 실패 (HTTP $HTTP)"
  send_message "$TICKET_CHANNEL_ID" "기숙사 역할 부여에 실패했어요. 관리자에게 문의해주세요!" || true
  exit 1
fi

# ─── 4단계: 다이어리 채널 처리 ──────────────────────────────────────
log "[4/5] 다이어리 채널 검색..."
GUILD_CHANNELS=$(api_get "/guilds/$GUILD_ID/channels")

DIARY_CHANNEL_ID=$(echo "$GUILD_CHANNELS" | python3 -c "
import json, sys
channels = json.load(sys.stdin)
user_id = '$USER_ID'
active_cats = set('$ACTIVE_DORM_CATS'.split())
for ch in channels:
    if str(ch.get('parent_id', '')) not in active_cats:
        continue
    for ow in ch.get('permission_overwrites', []):
        if ow.get('type') == 1 and str(ow.get('id')) == user_id:
            print(ch['id'])
            sys.exit(0)
" 2>/dev/null || echo "")

if [ -n "$DIARY_CHANNEL_ID" ]; then
  log "다이어리 채널 발견: $DIARY_CHANNEL_ID → 카테고리 이동: $TO_CATEGORY ($TO_DORM)"
  PATCH_RESP=$(api_patch "/channels/$DIARY_CHANNEL_ID" "{\"parent_id\": \"$TO_CATEGORY\", \"lock_permissions\": false}")
  PATCHED_ID=$(echo "$PATCH_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [ -n "$PATCHED_ID" ]; then
    log "카테고리 이동 완료: $DIARY_CHANNEL_ID → $TO_CATEGORY"
    DIARY_MSG=" 다이어리 채널도 이동됐어요 <#$DIARY_CHANNEL_ID>"
  else
    log "WARNING: 카테고리 이동 실패: ${PATCH_RESP:0:200}"
    DIARY_MSG=" (다이어리 카테고리 이동 실패 — 관리자 확인 필요)"
  fi
else
  log "다이어리 채널 없음 — diary-create 호출"
  DIARY_CREATE_SCRIPT="/home/node/.claude/skills/diary-create/create-diary.sh"
  if [ -f "$DIARY_CREATE_SCRIPT" ]; then
    bash "$DIARY_CREATE_SCRIPT" "$USER_ID" "$TICKET_CHANNEL_ID"
    DIARY_MSG=""  # diary-create가 완료 메시지까지 처리함
  else
    log "WARNING: diary-create 스크립트 없음"
    DIARY_MSG=" (다이어리 채널이 없어요 — 별도 생성 요청 필요)"
  fi
fi

# ─── 5단계: 완료 메시지 ─────────────────────────────────────────────
log "[5/5] 완료 메시지 발송..."

# diary-create가 이미 완료 메시지 보냈으면 중복 전송 방지
if [ -n "$DIARY_MSG" ] || [ -n "$DIARY_CHANNEL_ID" ]; then
  FROM_LABEL="${FROM_DORM:-없음}"
  COMPLETE_MSG="<@$USER_ID> 기숙사 변경 완료됐어요! 🎉
${FROM_LABEL} → ${TO_DORM} ${TO_EMOJI}${DIARY_MSG}"
  send_message "$TICKET_CHANNEL_ID" "$COMPLETE_MSG" && log "✅ 완료" || log "ERROR: 완료 메시지 실패"
fi

log "=== 스크립트 종료 ==="
