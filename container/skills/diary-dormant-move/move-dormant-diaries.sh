#!/bin/bash
# move-dormant-diaries.sh — 휴면 다이어리 이동/삭제 스크립트
# NanoClaw 스케줄 태스크의 script로 실행
# 출력: {"wakeAgent": true, "data": {...}} 또는 {"wakeAgent": false}

TOOLS_ENV="/workspace/global/tools.env"
if [ -z "${DISCORD_BOT_TOKEN:-}" ] && [ -f "$TOOLS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$TOOLS_ENV"
  set +a
fi

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo '{"wakeAgent": false, "error": "DISCORD_BOT_TOKEN not found"}' >&2
  exit 1
fi

# ─── 인자 파싱 (선택적) ─────────────────────────────────────────────────
# --months N        : 비활성 기준 개월 수 (기본 6)
# --category CAT_ID : 특정 기숙사 카테고리만 처리 (기본 전체)
# 환경변수로도 전달 가능: DORMANT_MONTHS=5 DORMANT_TARGET_CAT=xxx bash script.sh
while [[ $# -gt 0 ]]; do
  case $1 in
    --months)   DORMANT_MONTHS="$2";     shift 2 ;;
    --category) DORMANT_TARGET_CAT="$2"; shift 2 ;;
    *)          shift ;;
  esac
done
export DORMANT_MONTHS="${DORMANT_MONTHS:-3}"
export DORMANT_TARGET_CAT="${DORMANT_TARGET_CAT:-}"

python3 << PYEOF
import os, json, time, sys
from urllib.request import urlopen, Request
from urllib.error import HTTPError

GUILD_ID = "1213133289498615818"
API_BASE = "https://discord.com/api/v10"
TOKEN = os.environ["DISCORD_BOT_TOKEN"]

# 기숙사 카테고리 (채널 소스)
DORM_CATEGORIES = {
    "1236979261529657426": "소용돌이",
    "1236979345529114664": "노블레빗",
    "1236979439879848028": "볼리베어",
    "1386697214910529687": "펭도리야",
}

# 휴면 카테고리 (이동 목적지) — 순서대로 빈 자리 채움
DORMANT_CATEGORIES = [
    "1231241329384620134",  # ~휴면 다이어리 1~
    "1354671983664828549",  # ~휴면 다이어리 2~
    "1422467951109345300",  # ~휴면 다이어리 3~
    "1476394387784077405",  # ~휴면 다이어리 4~
    "1522048332967575712",  # ~휴면 다이어리 5~
]

# 비활성 기준 개월 수 (기본 6개월, --months 인자 또는 DORMANT_MONTHS 환경변수로 오버라이드)
MONTHS = int(os.environ.get("DORMANT_MONTHS", "3"))
MONTHS_MS = MONTHS * 30 * 24 * 60 * 60 * 1000
now_ms = int(time.time() * 1000)
cutoff_ms = now_ms - MONTHS_MS

# 특정 카테고리만 처리 (비어있으면 전체 기숙사 처리)
TARGET_CAT_FILTER = os.environ.get("DORMANT_TARGET_CAT", "")

# 메시지 수 기준 (미만이면 이동 대신 삭제)
DELETE_THRESHOLD = 10


def api_get(path):
    req = Request(f"{API_BASE}{path}", headers={
        "Authorization": f"Bot {TOKEN}",
        "User-Agent": "DiscordBot (https://nanoclaw.ai, 1.0)"
    })
    try:
        with urlopen(req) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return json.loads(e.read())


def api_patch(path, data):
    body = json.dumps(data).encode()
    req = Request(f"{API_BASE}{path}", data=body, method="PATCH", headers={
        "Authorization": f"Bot {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://nanoclaw.ai, 1.0)"
    })
    try:
        with urlopen(req) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return json.loads(e.read())


def api_post(path, data):
    body = json.dumps(data).encode()
    req = Request(f"{API_BASE}{path}", data=body, method="POST", headers={
        "Authorization": f"Bot {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://nanoclaw.ai, 1.0)"
    })
    try:
        with urlopen(req) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return json.loads(e.read())


def api_delete(path):
    req = Request(f"{API_BASE}{path}", method="DELETE", headers={
        "Authorization": f"Bot {TOKEN}",
        "User-Agent": "DiscordBot (https://nanoclaw.ai, 1.0)"
    })
    try:
        with urlopen(req) as r:
            return r.status
    except HTTPError as e:
        return e.code


def snowflake_to_ms(snowflake_id):
    return (int(snowflake_id) >> 22) + 1420070400000


def get_owner_from_first_message(channel_id):
    """첫 메시지의 멘션된 유저 ID를 소유자로 반환. 없으면 None."""
    try:
        msgs = api_get(f"/channels/{channel_id}/messages?limit=1&after=0")
        if isinstance(msgs, list) and msgs:
            mentions = msgs[0].get("mentions", [])
            if mentions:
                return mentions[0].get("id")
    except Exception:
        pass
    return None


def get_thread_stats(channel_id):
    """
    채널의 모든 스레드에서:
    - 가장 최근 메시지 시간(ms) — 6개월 비활성 판단에 사용
    - 스레드 메시지 총 수 — 삭제 기준에 사용 (message_count 필드, 최대 50까지 집계)
    반환: (latest_ms, total_thread_msg_count)
    """
    latest_ms = 0
    total_count = 0

    threads = []

    # 활성 스레드
    active = api_get(f"/channels/{channel_id}/threads/active")
    if isinstance(active, dict):
        threads.extend(active.get("threads", []))
    time.sleep(0.2)

    # 아카이브된 공개 스레드
    archived = api_get(f"/channels/{channel_id}/threads/archived/public?limit=100")
    if isinstance(archived, dict):
        threads.extend(archived.get("threads", []))
    time.sleep(0.2)

    for t in threads:
        # 스레드 최신 활동 시간
        t_last = t.get("last_message_id")
        if t_last:
            t_ms = snowflake_to_ms(t_last)
            if t_ms > latest_ms:
                latest_ms = t_ms

        # 스레드 메시지 수 (Discord가 최대 50까지만 집계하지만 10 기준엔 충분)
        mc = t.get("message_count") or 0
        total_count += mc

    return latest_ms, total_count


def count_channel_messages(channel_id, limit=10):
    """채널 메인 타임라인에서 최대 limit개 메시지를 조회해 실제 개수 반환."""
    msgs = api_get(f"/channels/{channel_id}/messages?limit={limit}")
    if isinstance(msgs, list):
        return len(msgs)
    return 0


def remove_user_overwrites(channel_id, overwrites):
    """채널에서 개인(type=1) 권한 오버라이드 제거."""
    for ow in overwrites:
        if ow.get("type") == 1:
            api_delete(f"/channels/{channel_id}/permissions/{ow['id']}")
            time.sleep(0.2)


# ─── 1. 서버 전체 채널 조회 ─────────────────────────────────────────────
all_channels = api_get(f"/guilds/{GUILD_ID}/channels")
if not isinstance(all_channels, list):
    print(json.dumps({"wakeAgent": False, "error": "채널 조회 실패"}))
    sys.exit(0)

# ─── 2. 서버 멤버 전체 조회 (페이지네이션) ─────────────────────────────
members = set()
after = "0"
while True:
    batch = api_get(f"/guilds/{GUILD_ID}/members?limit=1000&after={after}")
    if not isinstance(batch, list) or not batch:
        break
    for m in batch:
        uid = (m.get("user") or {}).get("id")
        if uid:
            members.add(uid)
    if len(batch) < 1000:
        break
    after = batch[-1].get("user", {}).get("id", "0")
    time.sleep(0.5)

# ─── 3. 휴면 카테고리별 현재 채널 수 ───────────────────────────────────
dormant_counts = {}
for c in all_channels:
    pid = c.get("parent_id")
    if pid in DORMANT_CATEGORIES:
        dormant_counts[pid] = dormant_counts.get(pid, 0) + 1

# 신규 생성된 카테고리 (동적 추가)
created_categories = []


def get_dormant_target():
    """여유 있는 휴면 카테고리 ID 반환. 없으면 None."""
    for cat_id in DORMANT_CATEGORIES + created_categories:
        if dormant_counts.get(cat_id, 0) < 50:
            return cat_id
    return None


def create_new_dormant_category():
    """새 ~휴면 다이어리 N~ 카테고리 생성"""
    num = len(DORMANT_CATEGORIES) + len(created_categories) + 1
    result = api_post(f"/guilds/{GUILD_ID}/channels", {
        "name": f"~휴면 다이어리 {num}~",
        "type": 4
    })
    if result.get("id"):
        new_id = result["id"]
        created_categories.append(new_id)
        dormant_counts[new_id] = 0
        return new_id
    return None


# ─── 4. 이동/삭제 대상 수집 ─────────────────────────────────────────────
to_process = []

for c in all_channels:
    if c.get("type") != 0:  # 텍스트 채널만
        continue
    if c.get("parent_id") not in DORM_CATEGORIES:
        continue
    if TARGET_CAT_FILTER and c.get("parent_id") != TARGET_CAT_FILTER:
        continue

    channel_id = c["id"]
    reason = None
    owner_id = None
    thread_stats = None  # (latest_ms, thread_msg_count) — 필요할 때만 조회

    # type=1(사용자) 오버라이드 찾기
    for p in c.get("permission_overwrites", []):
        if p.get("type") == 1:
            owner_id = p["id"]
            break

    # type=1 없으면 첫 메시지 멘션으로 소유자 파악
    # (Discord는 서버 탈퇴 시 type=1 오버라이드를 자동 삭제함)
    if not owner_id:
        owner_id = get_owner_from_first_message(channel_id)
        if owner_id:
            time.sleep(0.2)  # API rate limit 방지

    # 조건 2: 탈퇴 멤버
    if owner_id and owner_id not in members:
        reason = f"탈퇴 멤버 (user_id={owner_id})"

    # 조건 1: 6개월 비활성 (스레드 포함)
    if reason is None:
        last_msg_id = c.get("last_message_id")
        channel_latest_ms = snowflake_to_ms(last_msg_id) if last_msg_id else snowflake_to_ms(channel_id)

        if channel_latest_ms < cutoff_ms:
            # 채널 메인이 오래됐으면 스레드도 확인
            thread_stats = get_thread_stats(channel_id)
            thread_latest_ms = thread_stats[0]
            true_latest_ms = max(channel_latest_ms, thread_latest_ms)

            if true_latest_ms < cutoff_ms:
                reason = f"{MONTHS}개월 비활성"

    if reason:
        # 스레드 통계 아직 없으면 지금 조회 (탈퇴 멤버 경로)
        if thread_stats is None:
            thread_stats = get_thread_stats(channel_id)
            time.sleep(0.3)

        thread_latest_ms, thread_msg_count = thread_stats

        # 총 메시지 수 계산 (채널 메인 + 스레드)
        ch_msg_count = count_channel_messages(channel_id, DELETE_THRESHOLD)
        total_msg_count = ch_msg_count + thread_msg_count
        time.sleep(0.2)

        to_process.append({
            "id": channel_id,
            "name": c.get("name", ""),
            "reason": reason,
            "owner_id": owner_id,
            "dorm": DORM_CATEGORIES.get(c.get("parent_id"), "?"),
            "total_msg_count": total_msg_count,
            "permission_overwrites": c.get("permission_overwrites", []),
        })

if not to_process:
    print(json.dumps({"wakeAgent": False}))
    sys.exit(0)

# ─── 5. 이동 또는 삭제 실행 ─────────────────────────────────────────────
moved = []
deleted = []
errors = []

for ch in to_process:
    # 메시지 10개 미만 → 삭제
    if ch["total_msg_count"] < DELETE_THRESHOLD:
        status = api_delete(f"/channels/{ch['id']}")
        if status in (200, 204):
            deleted.append({
                "id": ch["id"],
                "name": ch["name"],
                "reason": ch["reason"],
                "from_dorm": ch["dorm"],
                "msg_count": ch["total_msg_count"],
            })
        else:
            errors.append({
                "id": ch["id"],
                "name": ch["name"],
                "error": f"삭제 실패 (HTTP {status})",
            })
        time.sleep(0.3)
        continue

    # 메시지 10개 이상 → 휴면 카테고리로 이동
    target = get_dormant_target()
    if target is None:
        target = create_new_dormant_category()
    if target is None:
        errors.append({"id": ch["id"], "name": ch["name"], "error": "카테고리 생성 실패"})
        continue

    result = api_patch(f"/channels/{ch['id']}", {"parent_id": target})
    if result.get("id"):
        # 개인(type=1) 권한 오버라이드 제거 — 소유자도 열람 불가
        remove_user_overwrites(ch["id"], ch["permission_overwrites"])
        moved.append({
            "id": ch["id"],
            "name": ch["name"],
            "reason": ch["reason"],
            "from_dorm": ch["dorm"],
        })
        dormant_counts[target] = dormant_counts.get(target, 0) + 1
    else:
        errors.append({
            "id": ch["id"],
            "name": ch["name"],
            "error": str(result)[:150]
        })
    time.sleep(0.3)

print(json.dumps({
    "wakeAgent": True,
    "data": {
        "moved": moved,
        "deleted": deleted,
        "errors": errors,
        "new_categories": created_categories
    }
}))
PYEOF
