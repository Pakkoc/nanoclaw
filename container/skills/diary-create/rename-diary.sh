#!/bin/bash
# rename-diary.sh — 티켓 요청자 본인의 다이어리 채널 이름을 바꾼다
#
# 사용법:
#   bash rename-diary.sh <user_id> <old_name> <new_name> <ticket_channel_id>
#
#   <user_id>   : 티켓 메시지의 senderId (요청자 본인)
#   <old_name>  : 회원이 알려 준 이전 닉네임(= 지금 다이어리 이름)
#   <new_name>  : 바꾸고 싶은 이름 (대괄호 태그는 자동 제거)
#
# 안전장치:
#   - 요청자에게 주인 권한(type=1 overwrite + 글쓰기)이 있는 활성 기숙사 다이어리만 바꾼다.
#     이름만 같고 주인이 다른 채널, 휴면 카테고리 채널은 건드리지 않고 운영진에게 넘긴다.
#   - 주인 다이어리가 여러 개면 old_name과 이름이 같은 것만 바꾸고, 못 고르면 운영진에게 넘긴다.
#   - 회원 입력은 argv로만 python에 넘긴다 (코드에 끼워 넣지 않음).
#
# 종료 코드: 0 = 변경 완료 또는 이미 같은 이름 / 1 = 운영진 확인 필요 (안내 메시지는 스크립트가 보냄)
# 모든 티켓 메시지는 스크립트가 직접 보낸다. 에이전트는 추가 메시지를 보내지 않는다.

GUILD_ID="1213133289498615818"
API_BASE="https://discord.com/api/v10"
ADMIN_CHANNEL="1489283292489449585"
ACTIVE_DORM_CATS="1236979261529657426 1236979345529114664 1236979439879848028 1386697214910529687"
DORMANT_CAT_IDS="1231241329384620134 1354671983664828549 1422467951109345300 1476394387784077405 1522048332967575712"

if [ $# -lt 4 ]; then
  echo "Usage: $0 <user_id> <old_name> <new_name> <ticket_channel_id>" >&2
  exit 1
fi

USER_ID="$1"
OLD_NAME="$2"
NEW_NAME_RAW="$3"
TICKET_CHANNEL_ID="$4"

if ! [[ "$USER_ID" =~ ^[0-9]{15,21}$ ]] || ! [[ "$TICKET_CHANNEL_ID" =~ ^[0-9]{15,21}$ ]]; then
  echo "ERROR: user_id/ticket_channel_id는 숫자 ID여야 해요" >&2
  exit 1
fi

TOOLS_ENV="/workspace/global/tools.env"
if [ -z "${DISCORD_BOT_TOKEN:-}" ] && [ -f "$TOOLS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$TOOLS_ENV"
  set +a
fi
if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "ERROR: DISCORD_BOT_TOKEN not found" >&2
  exit 1
fi

LOG_FILE="/tmp/diary-rename-$$.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >&2; }

UA="DiscordBot (https://nanoclaw.ai, 1.0)"

send_message() {
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'content': sys.argv[1], 'allowed_mentions': {'parse': []}}))" "$2")
  curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE}/channels/$1/messages" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" \
    -H "User-Agent: $UA" -d "$payload" | grep -q '^2' \
    && log "send_message OK → $1" || log "ERROR: send_message 실패 → $1"
}

WAIT_MSG="다이어리 이름 변경은 운영진이 확인해 드릴게요! 티켓을 닫지 말고 잠시만 기다려 주세요 🦉"

handoff() {
  # $1 = 관리자 채널에 남길 사유
  send_message "$TICKET_CHANNEL_ID" "$WAIT_MSG"
  send_message "$ADMIN_CHANNEL" "⚠️ 다이어리 이름 변경 자동 처리 불가 — $1
티켓: <#${TICKET_CHANNEL_ID}> / 요청자 ID: ${USER_ID}
이전 이름: ${OLD_NAME} → 새 이름: ${NEW_NAME_RAW}"
  exit 1
}

log "=== diary-rename: user=$USER_ID old='$OLD_NAME' new='$NEW_NAME_RAW' ticket=$TICKET_CHANNEL_ID ==="

# ─── 새 이름 정리 (create-diary.sh와 같은 규칙) ─────────────────────
NEW_NAME=$(python3 -c "
import re, sys
n = sys.argv[1]
n = re.sub(r'\[[^\]]*\]', '', n)          # [직장인] 같은 태그 제거
n = re.sub(r'[@#<>:\`]', '', n)           # 멘션/채널 링크/코드 기호 제거
n = n.strip()
n = re.sub(r'\s+', '-', n)
print(n[:100])
" "$NEW_NAME_RAW" 2>/dev/null)

if [ -z "$NEW_NAME" ]; then
  send_message "$TICKET_CHANNEL_ID" "바꾸실 이름을 다시 알려 주시겠어요? 글자가 들어간 이름이어야 해요 🦉"
  exit 1
fi

# ─── 요청자 본인의 다이어리 찾기 ─────────────────────────────────────
GUILD_CHANNELS=$(curl -s "${API_BASE}/guilds/$GUILD_ID/channels" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "User-Agent: $UA")

# 출력: "OK <channel_id> <현재이름>" | "MULTI" | "DORMANT" | "OTHER" | "NONE" | "ERROR"
FIND=$(echo "$GUILD_CHANNELS" | python3 -c "
import json, sys, re
try:
    chans = json.load(sys.stdin)
    assert isinstance(chans, list)
except Exception:
    print('ERROR'); sys.exit(0)
uid, old = sys.argv[1], sys.argv[2]
active, dormant = set(sys.argv[3].split()), set(sys.argv[4].split())
def norm(s):
    s = re.sub(r'\[[^\]]*\]', '', s or '').strip().lower()
    return re.sub(r'[\s_-]+', '-', s)
SEND = 2048
def is_owner(ch):
    for ow in ch.get('permission_overwrites', []):
        if ow.get('type') == 1 and str(ow.get('id')) == uid and int(ow.get('allow', '0')) & SEND:
            return True
    return False
owned = [c for c in chans if str(c.get('parent_id')) in active and c.get('type') == 0 and is_owner(c)]
if len(owned) == 1:
    c = owned[0]; print('OK', c['id'], c['name']); sys.exit(0)
if len(owned) > 1:
    m = [c for c in owned if norm(c['name']) == norm(old)]
    if len(m) == 1:
        c = m[0]; print('OK', c['id'], c['name'])
    else:
        print('MULTI')
    sys.exit(0)
if any(str(c.get('parent_id')) in dormant and norm(c.get('name')) == norm(old) for c in chans):
    print('DORMANT'); sys.exit(0)
if any(str(c.get('parent_id')) in active and norm(c.get('name')) == norm(old) for c in chans):
    print('OTHER'); sys.exit(0)
print('NONE')
" "$USER_ID" "$OLD_NAME" "$ACTIVE_DORM_CATS" "$DORMANT_CAT_IDS" 2>/dev/null || echo "ERROR")

STATUS=$(echo "$FIND" | awk '{print $1}')
log "검색 결과: $FIND"

case "$STATUS" in
  OK) ;;
  MULTI)   handoff "요청자 주인 권한 다이어리가 여러 개이고 이전 이름으로 하나를 고를 수 없음" ;;
  DORMANT) handoff "이전 이름과 같은 다이어리가 휴면 카테고리에 있음 (주인 확인 불가)" ;;
  OTHER)   handoff "이전 이름과 같은 채널은 있지만 요청자에게 주인 권한이 없음" ;;
  NONE)    handoff "요청자 다이어리를 찾지 못함" ;;
  *)       handoff "채널 목록 조회 실패" ;;
esac

DIARY_ID=$(echo "$FIND" | awk '{print $2}')
CUR_NAME=$(echo "$FIND" | cut -d' ' -f3-)

if [ "$(echo "$CUR_NAME" | tr '[:upper:]' '[:lower:]')" = "$(echo "$NEW_NAME" | tr '[:upper:]' '[:lower:]')" ]; then
  send_message "$TICKET_CHANNEL_ID" "다이어리 이름이 이미 **${NEW_NAME}**이에요! 🦉
<#${DIARY_ID}>"
  exit 0
fi

# ─── 이름 변경 ───────────────────────────────────────────────────────
PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'name': sys.argv[1]}))" "$NEW_NAME")
RESP_FILE="/tmp/diary-rename-resp-$$.json"
HTTP=$(curl -s -o "$RESP_FILE" -w '%{http_code}' -X PATCH "${API_BASE}/channels/$DIARY_ID" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" \
  -H "User-Agent: $UA" -H "X-Audit-Log-Reason: diary-rename ticket ${TICKET_CHANNEL_ID}" \
  -d "$PAYLOAD")
log "PATCH $DIARY_ID → HTTP $HTTP $(head -c 200 "$RESP_FILE")"

if [ "$HTTP" = "429" ]; then
  rm -f "$RESP_FILE"
  send_message "$TICKET_CHANNEL_ID" "지금은 디스코드 제한 때문에 이름을 바로 바꿀 수 없어요 😅 10분쯤 뒤에 \"다시 바꿔 주세요\"라고 말씀해 주세요 🦉"
  exit 1
fi

FINAL_NAME=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('name',''))" "$RESP_FILE" 2>/dev/null)
rm -f "$RESP_FILE"
if [[ "$HTTP" != 2* ]] || [ -z "$FINAL_NAME" ]; then
  handoff "이름 변경 API 실패 (HTTP $HTTP, 채널 <#${DIARY_ID}>)"
fi

log "✅ 다이어리 이름 변경 완료: $CUR_NAME → $FINAL_NAME ($DIARY_ID)"
send_message "$TICKET_CHANNEL_ID" "다이어리 이름을 **${FINAL_NAME}**(으)로 바꿔 드렸어요! 🦉
<#${DIARY_ID}>

다른 용건이 없으시면 티켓은 닫으셔도 괜찮아요 😊"
exit 0
