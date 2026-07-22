#!/bin/bash
# club.sh — 동아리 생성/종료 관리 스크립트
# 사용법:
#   club.sh create --name "동아리명" --type voice|text|forum --leader USER_ID --members USER_ID,USER_ID,...
#   club.sh close  --channel CHANNEL_ID

set -e

GUILD_ID="1213133289498615818"
ACTIVE_CATEGORY="1449740877718360084"     # 동아리 카테고리
CLOSED_CATEGORY="1481937596413382777"     # 종료 동아리 카테고리

# 기숙사 역할 ID (소용돌이🦋 볼리베어🐻 노블레빗🐇 펭도리야🐧)
DORM_ROLES=(
    "1231209049387831437"
    "1231209175388782592"
    "1231208875277946930"
    "1386636849291857971"
)

# 권한 상수
VOICE_EVERYONE_ALLOW="0"                # VIEW 없음 (기숙사 역할에만 VIEW ALLOW — JSC 방식)
VOICE_EVERYONE_DENY="377960278528"       # SEND+CONNECT+SPEAK+CREATE_THREADS+SEND_IN_THREADS
VOICE_DORM_ALLOW="1024"                  # VIEW
VOICE_DORM_DENY="1048576"               # CONNECT
VOICE_ROLE_ALLOW="3149312"              # VIEW+STREAM+SEND+CONNECT+SPEAK

TEXT_EVERYONE_ALLOW="1024"              # VIEW
TEXT_EVERYONE_DENY="3213312"            # SEND+READ_HIST+CONNECT+SPEAK
TEXT_DORM_ALLOW="1024"                  # VIEW
TEXT_DORM_DENY="3213312"               # SEND+READ_HIST+CONNECT+SPEAK (서버 레벨 READ_HIST 차단)
TEXT_ROLE_ALLOW="3214848"              # VIEW+STREAM+SEND+CONNECT+SPEAK+READ_HIST

FORUM_EVERYONE_ALLOW="1024"             # VIEW
FORUM_EVERYONE_DENY="309240858624"      # SEND+READ_HIST+CONNECT+SPEAK+CREATE_THREADS+SEND_IN_THREADS
FORUM_DORM_ALLOW="1024"                 # VIEW
FORUM_DORM_DENY="309240858624"         # SEND+READ_HIST+CONNECT+SPEAK+CREATE_THREADS+SEND_IN_THREADS (서버 레벨 READ_HIST 차단)
FORUM_ROLE_ALLOW="309237713920"         # VIEW+SEND+READ_HIST+CREATE_THREADS+SEND_IN_THREADS

# tools.env에서 Discord 봇 토큰 로드
source /workspace/global/tools.env

# ─── API 헬퍼 ────────────────────────────────────────
api_get() {
    curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: DiscordBot/1.0" \
         "https://discord.com/api/v10$1"
}

api_post() {
    curl -s -X POST \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: DiscordBot/1.0" \
         -H "Content-Type: application/json" \
         -d "$2" \
         "https://discord.com/api/v10$1"
}

api_put() {
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: DiscordBot/1.0" \
         -H "Content-Type: application/json" \
         ${2:+-d "$2"} \
         "https://discord.com/api/v10$1")
    echo "$status"
}

api_delete() {
    curl -s -o /dev/null -w "%{http_code}" -X DELETE \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: DiscordBot/1.0" \
         "https://discord.com/api/v10$1"
}

api_patch() {
    curl -s -X PATCH \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: DiscordBot/1.0" \
         -H "Content-Type: application/json" \
         -d "$2" \
         "https://discord.com/api/v10$1"
}

# ─── 권한 설정 ────────────────────────────────────────
set_permissions() {
    local ch_id="$1"
    local type="$2"
    local role_id="$3"
    local leader="$4"

    echo "  권한 설정 중..."

    case "$type" in
        voice)
            # @everyone: VIEW ALLOW, CONNECT 등 DENY
            api_put "/channels/$ch_id/permissions/1213133289498615818" \
                "{\"type\":0,\"allow\":\"$VOICE_EVERYONE_ALLOW\",\"deny\":\"$VOICE_EVERYONE_DENY\"}" > /dev/null

            # 기숙사 역할: VIEW ALLOW + CONNECT DENY
            for dorm in "${DORM_ROLES[@]}"; do
                api_put "/channels/$ch_id/permissions/$dorm" \
                    "{\"type\":0,\"allow\":\"$VOICE_DORM_ALLOW\",\"deny\":\"$VOICE_DORM_DENY\"}" > /dev/null
                sleep 0.2
            done

            # 동아리 역할: 모두 ALLOW
            api_put "/channels/$ch_id/permissions/$role_id" \
                "{\"type\":0,\"allow\":\"$VOICE_ROLE_ALLOW\",\"deny\":\"0\"}" > /dev/null
            ;;

        text)
            # @everyone: VIEW ALLOW, SEND+READ_HIST 등 DENY
            api_put "/channels/$ch_id/permissions/1213133289498615818" \
                "{\"type\":0,\"allow\":\"$TEXT_EVERYONE_ALLOW\",\"deny\":\"$TEXT_EVERYONE_DENY\"}" > /dev/null

            # 기숙사 역할: VIEW ALLOW, READ_HIST+SEND DENY
            for dorm in "${DORM_ROLES[@]}"; do
                api_put "/channels/$ch_id/permissions/$dorm" \
                    "{\"type\":0,\"allow\":\"$TEXT_DORM_ALLOW\",\"deny\":\"$TEXT_DORM_DENY\"}" > /dev/null
                sleep 0.2
            done

            # 동아리 역할: 모두 ALLOW
            api_put "/channels/$ch_id/permissions/$role_id" \
                "{\"type\":0,\"allow\":\"$TEXT_ROLE_ALLOW\",\"deny\":\"0\"}" > /dev/null

            # 입학생·노란부엉이 VIEW DENY 삭제 (카테고리에서 상속됨 — 모두가 볼 수 있어야 함)
            api_delete "/channels/$ch_id/permissions/1236275792657514528" > /dev/null
            sleep 0.2
            api_delete "/channels/$ch_id/permissions/1358244936129970247" > /dev/null
            ;;

        forum)
            # @everyone: VIEW ALLOW, SEND+READ_HIST 등 DENY
            api_put "/channels/$ch_id/permissions/1213133289498615818" \
                "{\"type\":0,\"allow\":\"$FORUM_EVERYONE_ALLOW\",\"deny\":\"$FORUM_EVERYONE_DENY\"}" > /dev/null

            # 기숙사 역할: VIEW ALLOW, READ_HIST+SEND DENY
            for dorm in "${DORM_ROLES[@]}"; do
                api_put "/channels/$ch_id/permissions/$dorm" \
                    "{\"type\":0,\"allow\":\"$FORUM_DORM_ALLOW\",\"deny\":\"$FORUM_DORM_DENY\"}" > /dev/null
                sleep 0.2
            done

            # 동아리 역할: 모두 ALLOW
            api_put "/channels/$ch_id/permissions/$role_id" \
                "{\"type\":0,\"allow\":\"$FORUM_ROLE_ALLOW\",\"deny\":\"0\"}" > /dev/null

            # 입학생·노란부엉이 VIEW DENY 삭제 (카테고리에서 상속됨 — 모두가 볼 수 있어야 함)
            api_delete "/channels/$ch_id/permissions/1236275792657514528" > /dev/null
            sleep 0.2
            api_delete "/channels/$ch_id/permissions/1358244936129970247" > /dev/null
            ;;
    esac

    # 회장: MANAGE_CHANNELS(16) ALLOW (type=1 개인 오버라이드)
    api_put "/channels/$ch_id/permissions/$leader" \
        "{\"type\":1,\"allow\":\"16\",\"deny\":\"0\"}" > /dev/null

    echo "  권한 설정 완료"
}

# ─── 역할 부여 ────────────────────────────────────────
assign_roles() {
    local role_id="$1"
    local leader="$2"
    local members="$3"

    echo "  역할 부여 중..."

    # 회장
    local status
    status=$(api_put "/guilds/$GUILD_ID/members/$leader/roles/$role_id")
    echo "  회장($leader): $status"
    sleep 0.3

    # 회원
    IFS=',' read -ra member_arr <<< "$members"
    for member in "${member_arr[@]}"; do
        member=$(echo "$member" | tr -d ' ')
        [ -z "$member" ] && continue
        status=$(api_put "/guilds/$GUILD_ID/members/$member/roles/$role_id")
        echo "  회원($member): $status"
        sleep 0.3
    done
}

# ─── CREATE ──────────────────────────────────────────
create_club() {
    local name="$1"
    local type="$2"
    local leader="$3"
    local members="$4"

    echo "=== 동아리 생성: $name ($type) ==="

    # 1. 역할 생성
    echo "1. 역할 생성..."
    local role_resp
    role_resp=$(api_post "/guilds/$GUILD_ID/roles" \
        "{\"name\":\"$name\",\"permissions\":\"2221947747683905\",\"color\":0,\"hoist\":false,\"mentionable\":true}")
    local role_id
    role_id=$(echo "$role_resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)
    if [ -z "$role_id" ]; then
        echo "ERROR: 역할 생성 실패"
        echo "$role_resp"
        exit 1
    fi
    echo "   역할 ID: $role_id"

    # 2. 채널 유형 결정
    local ch_type
    case "$type" in
        voice) ch_type=2 ;;
        text)  ch_type=0 ;;
        forum) ch_type=15 ;;
        *) echo "ERROR: 알 수 없는 채널 유형 '$type'"; exit 1 ;;
    esac

    # 3. 채널 생성
    echo "2. 채널 생성..."
    local ch_resp
    ch_resp=$(api_post "/guilds/$GUILD_ID/channels" \
        "{\"name\":\"$name\",\"type\":$ch_type,\"parent_id\":\"$ACTIVE_CATEGORY\"}")
    local ch_id
    ch_id=$(echo "$ch_resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)
    if [ -z "$ch_id" ]; then
        echo "ERROR: 채널 생성 실패"
        echo "$ch_resp"
        exit 1
    fi
    echo "   채널 ID: $ch_id"

    # 4. 권한 설정
    echo "3. 권한 설정..."
    set_permissions "$ch_id" "$type" "$role_id" "$leader"

    # 5. 역할 부여
    echo "4. 역할 부여..."
    assign_roles "$role_id" "$leader" "$members"

    echo ""
    echo "✅ 동아리 생성 완료"
    echo "   이름:    $name"
    echo "   유형:    $type"
    echo "   역할 ID: $role_id"
    echo "   채널 ID: $ch_id"
}

# ─── CLOSE ───────────────────────────────────────────
close_club() {
    local ch_id="$1"

    echo "=== 동아리 종료: 채널 $ch_id ==="

    # 1. 현재 채널 정보 조회
    local ch_resp
    ch_resp=$(api_get "/channels/$ch_id")
    local ch_name
    ch_name=$(echo "$ch_resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])" 2>/dev/null)
    if [ -z "$ch_name" ]; then
        echo "ERROR: 채널 정보 조회 실패"
        echo "$ch_resp"
        exit 1
    fi

    # 2. 채널명에 -종료 추가
    local new_name="$ch_name"
    if [[ "$ch_name" != *"-종료" ]]; then
        new_name="${ch_name}-종료"
    fi

    # 3. 채널 이동 + 이름 변경
    local patch_resp
    patch_resp=$(api_patch "/channels/$ch_id" \
        "{\"name\":\"$new_name\",\"parent_id\":\"$CLOSED_CATEGORY\"}")
    local result_name
    result_name=$(echo "$patch_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('name','ERROR'))" 2>/dev/null)

    echo ""
    echo "✅ 동아리 종료 완료"
    echo "   채널명: $ch_name → $result_name"
    echo "   이동:   활성 동아리 → 종료 동아리 카테고리"
    echo "   (역할은 유지 — 동아리원이 아카이브 열람 가능)"
}

# ─── 메인 ────────────────────────────────────────────
CMD="$1"
shift || true

NAME="" TYPE="voice" LEADER="" MEMBERS="" CHANNEL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name)    NAME="$2";    shift 2 ;;
        --type)    TYPE="$2";    shift 2 ;;
        --leader)  LEADER="$2";  shift 2 ;;
        --members) MEMBERS="$2"; shift 2 ;;
        --channel) CHANNEL="$2"; shift 2 ;;
        *) shift ;;
    esac
done

case "$CMD" in
    create)
        [ -z "$NAME" ]   && { echo "ERROR: --name 필요"; exit 1; }
        [ -z "$LEADER" ] && { echo "ERROR: --leader 필요"; exit 1; }
        [ -z "$MEMBERS" ] && { echo "ERROR: --members 필요"; exit 1; }
        create_club "$NAME" "$TYPE" "$LEADER" "$MEMBERS"
        ;;
    close)
        [ -z "$CHANNEL" ] && { echo "ERROR: --channel 필요"; exit 1; }
        close_club "$CHANNEL"
        ;;
    *)
        echo "사용법:"
        echo "  club.sh create --name '동아리명' --type voice|text|forum --leader USER_ID --members USER_ID,..."
        echo "  club.sh close  --channel CHANNEL_ID"
        ;;
esac
