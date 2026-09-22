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

# 활성 기숙사 카테고리 ID 목록
ACTIVE_DORM_CATS="1236979261529657426 1236979345529114664 1236979439879848028 1386697214910529687"
# 휴면 다이어리 카테고리 ID 목록
DORMANT_CAT_IDS="1231241329384620134 1354671983664828549 1422467951109345300 1476394387784077405 1522048332967575712"

DORMANT_MOVE_SCRIPT="/home/node/.claude/skills/diary-dormant-move/move-dormant-diaries.sh"

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

api_patch() {
  curl -s -X PATCH \
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
    if [ -n "$NEW_CHANNEL_ID" ]; then
      # 채널은 생성됐지만 완료 메시지 전송만 실패 — 부차적 문제, 경고 생략
      log "INFO: 완료 메시지 미전송이나 채널($NEW_CHANNEL_ID)은 정상 생성됨 — 관리자 알림 생략"
    else
      # 채널 자체가 생성되지 않은 진짜 실패
      log "WARNING: 다이어리 생성 실패 감지 (exit_code=$exit_code) — 관리자 채널 알림"
      local alert="⚠️ 다이어리 생성 실패\n티켓 채널: <#${TICKET_CHANNEL_ID}>\n로그: $LOG_FILE"
      send_message "$ADMIN_CHANNEL" "$(printf '%b' "$alert")" || true
    fi
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

# ─── 4.5단계: 기존 다이어리 전체 검색 (활성 기숙사 + 휴면 카테고리) ──
log "[4.5/9] 기존 다이어리 채널 검색..."
GUILD_CHANNELS=$(api_get "/guilds/$GUILD_ID/channels")

# 결과 형식: "<channel_id> <status>"
#   status=same     : 이미 현재 기숙사 카테고리에 있음 (중복 → 리다이렉트)
#   status=move     : 다른 활성 기숙사 카테고리에 있음 (기숙사 변경 → 복구)
#   status=recover  : 휴면 카테고리에 있음 (휴면 → 복구)
SEARCH_RESULT=$(echo "$GUILD_CHANNELS" | python3 -c "
import json, sys, re

channels = json.load(sys.stdin)
user_id  = '$USER_ID'
target_cat   = '$CATEGORY_ID'
active_cats  = set('$ACTIVE_DORM_CATS'.split())
dormant_cats = set('$DORMANT_CAT_IDS'.split())

# 1. 활성 기숙사 카테고리에서 permission_overwrite(type=1) 검색
for ch in channels:
    pid = str(ch.get('parent_id', ''))
    if pid not in active_cats:
        continue
    for ow in ch.get('permission_overwrites', []):
        if ow.get('type') == 1 and str(ow.get('id')) == user_id:
            status = 'same' if pid == target_cat else 'move'
            print(f\"{ch['id']} {status}\")
            sys.exit(0)

# 2. 휴면 카테고리에서 채널 이름으로 검색
# (휴면 이동 시 user overwrite가 제거되므로 이름 기반 매칭)
nick = '$CHANNEL_NAME'
for ch in channels:
    pid = str(ch.get('parent_id', ''))
    if pid not in dormant_cats:
        continue
    if ch.get('name', '').lower() == nick.lower():
        print(f\"{ch['id']} recover\")
        sys.exit(0)

sys.exit(0)
" 2>/dev/null || echo "")

RECOVERY_MODE=0
RECOVERY_CHANNEL_ID=""

if [ -n "$SEARCH_RESULT" ]; then
  FOUND_CH=$(echo "$SEARCH_RESULT" | awk '{print $1}')
  FOUND_STATUS=$(echo "$SEARCH_RESULT" | awk '{print $2}')

  if [ "$FOUND_STATUS" = "same" ]; then
    log "기존 다이어리 채널 발견 (현재 기숙사): $FOUND_CH — 중복 생성 차단"
    COMPLETE_MSG="이미 다이어리가 있어요! 💛
<#$FOUND_CH>
여기서 계속 기록해주세요 📖"
    send_message "$TICKET_CHANNEL_ID" "$COMPLETE_MSG" || true
    COMPLETE_MSG_SENT=1
    exit 0
  else
    log "기존 다이어리 발견 ($FOUND_STATUS): $FOUND_CH → 복구 모드"
    RECOVERY_MODE=1
    RECOVERY_CHANNEL_ID="$FOUND_CH"
  fi
fi

log "$([ $RECOVERY_MODE -eq 1 ] && echo '복구 모드' || echo '신규 생성 모드')"

# ─── 4.6단계: 카테고리 용량 체크 + 자동 정리 ─────────────────────────
log "[4.6/9] 카테고리 용량 체크: $CATEGORY_ID ($DORM_LABEL)"

CAT_COUNT=$(echo "$GUILD_CHANNELS" | python3 -c "
import json, sys
channels = json.load(sys.stdin)
count = sum(1 for c in channels if str(c.get('parent_id','')) == '$CATEGORY_ID')
print(count)
" 2>/dev/null || echo "0")

if [ "$CAT_COUNT" -ge 50 ]; then
  log "카테고리 꽉 참 ($CAT_COUNT/50) — 휴면 정리 자동 시도..."
  CLEANED=0
  for MONTHS in 6 5 4 3 2 1; do
    log "  휴면 정리 시도: ${MONTHS}개월 기준..."
    DORMANT_MONTHS=$MONTHS DORMANT_TARGET_CAT=$CATEGORY_ID bash "$DORMANT_MOVE_SCRIPT" > /dev/null 2>&1 || true

    # 채널 수 재조회
    GUILD_CHANNELS=$(api_get "/guilds/$GUILD_ID/channels")
    CAT_COUNT=$(echo "$GUILD_CHANNELS" | python3 -c "
import json, sys
channels = json.load(sys.stdin)
count = sum(1 for c in channels if str(c.get('parent_id','')) == '$CATEGORY_ID')
print(count)
" 2>/dev/null || echo "50")

    if [ "$CAT_COUNT" -lt 50 ]; then
      log "  정리 완료 (${MONTHS}개월 기준): ${CAT_COUNT}/50"
      CLEANED=1
      break
    fi
  done

  if [ "$CLEANED" -eq 0 ]; then
    log "ERROR: 정리 후에도 카테고리 꽉 참 ($CAT_COUNT/50) — 관리자 안내"
    send_message "$TICKET_CHANNEL_ID" "다이어리 생성이 가능해요! 😊 다만 현재 기숙사 카테고리가 가득 찬 상태라 자동 생성이 어렵네요 🥲 관리자분이 확인하시는 대로 처리해드릴 테니 잠시만 기다려주세요 🦉" || true
    COMPLETE_MSG_SENT=1
    exit 1
  fi
fi

# ─── 5단계: 복구 또는 신규 생성 ──────────────────────────────────────
if [ "$RECOVERY_MODE" -eq 1 ]; then
  # ─── 복구 플로우 ────────────────────────────────────────────────────
  log "[5/9] 다이어리 복구: $RECOVERY_CHANNEL_ID → 카테고리 $CATEGORY_ID"

  PATCH_RESPONSE=$(api_patch "/channels/$RECOVERY_CHANNEL_ID" "{\"parent_id\": \"$CATEGORY_ID\"}")
  NEW_CHANNEL_ID=$(echo "$PATCH_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

  if [ -z "$NEW_CHANNEL_ID" ]; then
    log "ERROR: 복구 실패: ${PATCH_RESPONSE:0:200}"
    send_message "$TICKET_CHANNEL_ID" "다이어리 복구에 실패했어요. 관리자에게 문의해주세요!" || true
    COMPLETE_MSG_SENT=1
    exit 1
  fi

  log "[6/9] 복구 완료: $NEW_CHANNEL_ID"

  # ─── 7단계: 권한 복원 ───────────────────────────────────────────────
  log "[7/9] 권한 복원..."
  PERM_PAYLOAD='{"allow":"2252177770818560","deny":"16","type":1}'
  api_put "/channels/$NEW_CHANNEL_ID/permissions/$USER_ID" "$PERM_PAYLOAD" > /dev/null || log "WARNING: 권한 복원 실패 — 계속 진행"

  send_message "$NEW_CHANNEL_ID" "<@$USER_ID>" || log "WARNING: 채널 내 멘션 실패 — 계속 진행"

  # ─── 8단계: NanoClaw 그룹 등록 확인 ────────────────────────────────
  log "[8/9] NanoClaw 그룹 등록 확인..."
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
console.log('등록 확인: dc:' + process.argv[1]);
" "$NEW_CHANNEL_ID" "$CHANNEL_NAME" || log "WARNING: 그룹 등록 확인 실패 — 계속 진행"

  # CLAUDE.md 디렉토리 확인 (없으면 생성)
  TEMPLATE_CLAUDE="/workspace/project/groups/discord_diary/CLAUDE.md"
  TARGET_DIR="/workspace/project/groups/diaries/discord_diary_ch${NEW_CHANNEL_ID}"
  if [ ! -d "$TARGET_DIR" ]; then
    mkdir -p "$TARGET_DIR" && log "디렉토리 생성: $TARGET_DIR" || log "WARNING: 디렉토리 생성 실패"
    if [ -f "$TEMPLATE_CLAUDE" ]; then
      cp "$TEMPLATE_CLAUDE" "$TARGET_DIR/CLAUDE.md" \
        && log "CLAUDE.md 복원 완료" \
        || log "WARNING: CLAUDE.md 복사 실패 — 계속 진행"
    fi
  fi

  # ─── 9단계: 복구 완료 메시지 ────────────────────────────────────────
  log "[9/9] 복구 완료 메시지 발송..."
  COMPLETE_MSG="다이어리 복구 완료됐어요! 🎉
<#$NEW_CHANNEL_ID>
다시 기록 시작해봐요 📖"

  if send_message "$TICKET_CHANNEL_ID" "$COMPLETE_MSG"; then
    COMPLETE_MSG_SENT=1
    log "✅ 다이어리 복구 완료: $CHANNEL_NAME ($NEW_CHANNEL_ID)"
  else
    log "ERROR: 복구 완료 메시지 발송 실패 — EXIT trap에서 관리자 알림 전송 예정"
  fi

else
  # ─── 신규 생성 플로우 ────────────────────────────────────────────────
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

  # ─── 7단계: 권한 설정 ───────────────────────────────────────────────
  log "[7/9] 권한 설정..."
  # 채널 주인: allow VIEW_CHANNEL(1024) + SEND_MESSAGES(2048) + MANAGE_MESSAGES(8192) + CREATE_PUBLIC_THREADS(34359738368) + CREATE_PRIVATE_THREADS(68719476736) + SEND_MESSAGES_IN_THREADS(274877906944) + PIN_MESSAGES(2251799813685248) = 2252177770818560, deny MANAGE_CHANNELS(16)
  PERM_PAYLOAD='{"allow":"2252177770818560","deny":"16","type":1}'
  api_put "/channels/$NEW_CHANNEL_ID/permissions/$USER_ID" "$PERM_PAYLOAD" > /dev/null || log "WARNING: 권한 설정 실패 — 계속 진행"

  # @everyone: SEND_MESSAGES(2048) + CREATE_PUBLIC_THREADS(34359738368) + CREATE_PRIVATE_THREADS(68719476736) + SEND_MESSAGES_IN_THREADS(274877906944) deny
  # = 377957124096 (다이어리는 주인만 작성, 다른 멤버는 이모지 반응만 가능)
  EVERYONE_PERM_PAYLOAD='{"allow":"0","deny":"377957124096","type":0}'
  api_put "/channels/$NEW_CHANNEL_ID/permissions/$GUILD_ID" "$EVERYONE_PERM_PAYLOAD" > /dev/null || log "WARNING: @everyone 스레드 차단 설정 실패 — 계속 진행"

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

  # canonical 다이어리 템플릿(호스트 registerGroup 과 동일 소스) 사용, 학생 폴더를 템플릿으로 쓰지 않음.
  TEMPLATE_CLAUDE="/workspace/project/groups/discord_diary/CLAUDE.md"
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
<#$NEW_CHANNEL_ID>
열공하세요!"

  if send_message "$TICKET_CHANNEL_ID" "$COMPLETE_MSG"; then
    COMPLETE_MSG_SENT=1
    log "✅ 다이어리 생성 완료: $CHANNEL_NAME ($NEW_CHANNEL_ID)"
  else
    log "ERROR: 완료 메시지 발송 실패 — EXIT trap에서 관리자 알림 전송 예정"
  fi

fi
